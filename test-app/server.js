/*
 * hls-pipe test-app server
 *
 * Express harness that proxies the hls-pipe library API:
 *   - imports Extractor / StdoutSink / makeOutputMode from ../dist
 *   - feeds Extractor output into an ffplay subprocess (one window per session)
 *   - exposes REST + SSE for the browser UI to drive playback
 *
 * Single active session at a time. Starting a new one tears down the previous.
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Extractor,
  StdoutSink,
  makeOutputMode,
} from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -- session state ----------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   url: string,
 *   options: Record<string, unknown>,
 *   extractor: import('../dist/index.js').Extractor,
 *   ffplay: import('node:child_process').ChildProcess,
 *   sink: import('../dist/index.js').StdoutSink,
 *   abort: AbortController,
 *   startedAt: number,
 *   logs: { t: number, line: string }[],
 *   state: 'starting' | 'running' | 'paused' | 'stopped' | 'error',
 *   error: string | null,
 *   exitInfo: { code: number | null, signal: NodeJS.Signals | null } | null,
 *   ffplayExitInfo: { code: number | null, signal: NodeJS.Signals | null } | null,
 *   runPromise: Promise<void>,
 * }} Session
 */

/** @type {Session | null} */
let session = null;
const LOG_RING_CAP = 1000;

/**
 * Pending playhead, in seconds. Set by `POST /api/seek` when no session is
 * active; consumed (and cleared) by the next `POST /api/session` as the
 * Extractor's `startTimeSec`. Mid-play `/api/seek` calls bypass this and go
 * straight to `extractor.seek()`.
 */
let pendingTimeSec = null;

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      // best-effort
    }
  }
}

function appendLog(line) {
  if (!session) return;
  const entry = { t: Date.now(), line };
  session.logs.push(entry);
  if (session.logs.length > LOG_RING_CAP) {
    session.logs.splice(0, session.logs.length - LOG_RING_CAP);
  }
  broadcast('log', entry);
}

function setState(next, extra = {}) {
  if (!session) return;
  if (session.state !== next) {
    session.state = next;
    broadcast('state', publicSession());
  } else if (Object.keys(extra).length > 0) {
    broadcast('state', publicSession());
  }
}

function publicSnapshot() {
  return { session: publicSession(), pendingTimeSec };
}

function publicSession() {
  if (!session) return null;
  return {
    id: session.id,
    url: session.url,
    options: session.options,
    state: session.state,
    error: session.error,
    startedAt: session.startedAt,
    paused: session.extractor.isPaused?.() ?? false,
    bytesWritten: session.sink.getStats().bytesWritten,
    mediaSecondsWritten: session.sink.getStats().mediaSecondsWritten,
    ffplayPid: session.ffplay.pid ?? null,
    ffplayExitInfo: session.ffplayExitInfo,
    exitInfo: session.exitInfo,
  };
}

// -- ffplay --------------------------------------------------------------

/**
 * ffplay flags worth knowing:
 *   -alwaysontop  — window stays above other windows (macOS/Linux/Win).
 *                   Best-effort "foreground" — does NOT steal focus, but the
 *                   window remains visible above the browser/terminal.
 *   -window_title — set the window title so you can identify the session.
 *   -autoexit     — quit after the input stream ends (useful for VOD).
 *   -f <fmt>      — force input format (matched to the output mode below).
 *   -loglevel     — keep ffplay's stderr digestible.
 */
function spawnFfplay(outputModeId, label) {
  const inputFmt = ffplayInputFormat(outputModeId);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-autoexit',
    '-alwaysontop',
    '-window_title', `hls-pipe :: ${label}`,
    '-f', inputFmt,
    '-i', 'pipe:0',
  ];
  return spawn('ffplay', args, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function ffplayInputFormat(outputModeId) {
  switch (outputModeId) {
    case 'es-audio': return 'aac';
    case 'es-video': return 'h264';
    case 'ts':
    case 'ts-canonical':
    default:
      return 'mpegts';
  }
}

// -- session lifecycle ---------------------------------------------------

async function stopSession(reason) {
  if (!session) return;
  const s = session;
  if (s.state === 'stopped' || s.state === 'error') {
    // already winding down; let the runPromise finish naturally
    return;
  }
  appendLog(`stop requested: ${reason}`);
  s.abort.abort();
  // Destroy ffplay's stdin so any in-flight sink.write parked on a drain
  // event unwinds immediately. We pass an Error: bare destroy() only emits
  // 'close' (not 'error'), and the sink's waitForDrainEvent only listens for
  // 'drain' and 'error' — so a bare destroy would leave the write parked
  // forever and runPromise would never resolve.
  try {
    if (s.ffplay.stdin && !s.ffplay.stdin.destroyed) {
      s.ffplay.stdin.destroy(new Error('session stopped'));
    }
  } catch {}
  // give ffplay a moment to wind down, then SIGTERM, then SIGKILL.
  setTimeout(() => {
    if (!s.ffplay.killed && s.ffplay.exitCode === null) {
      try { s.ffplay.kill('SIGTERM'); } catch {}
    }
  }, 300).unref();
  setTimeout(() => {
    if (!s.ffplay.killed && s.ffplay.exitCode === null) {
      try { s.ffplay.kill('SIGKILL'); } catch {}
    }
  }, 1500).unref();
}

function parseQuality(q) {
  if (!q || q === 'auto') return undefined;
  if (q === 'highest' || q === 'lowest') return { kind: q };
  if (typeof q === 'string' && q.startsWith('index:')) {
    const n = Number.parseInt(q.slice('index:'.length), 10);
    if (!Number.isFinite(n)) throw new Error(`invalid quality: ${q}`);
    return { kind: 'index', index: n };
  }
  if (typeof q === 'string' && q.startsWith('maxBitrate:')) {
    const n = Number.parseInt(q.slice('maxBitrate:'.length), 10);
    if (!Number.isFinite(n)) throw new Error(`invalid quality: ${q}`);
    return { kind: 'maxBitrate', bitrate: n };
  }
  throw new Error(`invalid quality: ${q}`);
}

function startSession(url, options) {
  const id = randomBytes(6).toString('hex');
  const outputModeId = options.outputMode ?? 'ts-canonical';
  const labelParts = [
    options.quality && options.quality !== 'auto' ? options.quality : 'ABR',
    outputModeId,
  ];
  const label = `${id} [${labelParts.join(' / ')}]`;

  const ffplay = spawnFfplay(outputModeId, label);
  const abort = new AbortController();

  ffplay.on('error', (err) => {
    appendLog(`ffplay error: ${err.message}`);
    if (session?.id === id) {
      session.error = `ffplay failed to launch: ${err.message}`;
      setState('error');
      abort.abort();
    }
  });
  ffplay.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) appendLog(`[ffplay] ${trimmed}`);
    }
  });
  ffplay.on('exit', (code, signal) => {
    appendLog(`ffplay exited (code=${code}, signal=${signal})`);
    if (session?.id === id) {
      session.ffplayExitInfo = { code, signal };
      // If the user quits ffplay (closes the window), tear down the extractor.
      if (session.state === 'running' || session.state === 'paused' || session.state === 'starting') {
        abort.abort();
      }
      broadcast('state', publicSession());
    }
  });
  // Don't let an EPIPE (ffplay closed early) crash the server.
  ffplay.stdin?.on('error', (err) => {
    if (err && /** @type {NodeJS.ErrnoException} */(err).code === 'EPIPE') return;
    appendLog(`ffplay stdin error: ${err.message}`);
  });

  // 10 MB smoothing buffer between extractor and ffplay — same default the CLI uses.
  const sink = new StdoutSink(ffplay.stdin, { bufferLimitBytes: 10 * 1024 * 1024 });

  const extractorOpts = {
    url,
    sink,
    signal: abort.signal,
    log: (msg) => appendLog(`[hls-pipe] ${msg}`),
  };
  const fixedQuality = parseQuality(options.quality);
  if (fixedQuality) extractorOpts.fixedQuality = fixedQuality;
  if (options.abrPreset === 'unstable') {
    extractorOpts.abr = { ...(extractorOpts.abr ?? {}), tickIntervalMs: 100 };
  }
  if (options.capBitrate) {
    extractorOpts.abr = { ...(extractorOpts.abr ?? {}), capBitrate: Number(options.capBitrate) };
  }
  const latency = {};
  if (options.liveSyncSec) latency.liveSyncTargetSec = Number(options.liveSyncSec);
  if (options.liveMaxLagSec) latency.liveMaxLatencySec = Number(options.liveMaxLagSec);
  if (options.skipOnStall) latency.skipOnStall = true;
  if (Object.keys(latency).length > 0) extractorOpts.latency = latency;

  // Default outputMode is ts-canonical (same as CLI) — the explicit default
  // here also keeps the inline-audio branch below consistent: when no
  // outputMode is sent we still resolve to canonical, which is the only mode
  // that supports inline audio.
  const resolvedOutputMode = options.outputMode ?? 'ts-canonical';
  if (resolvedOutputMode !== 'ts') {
    extractorOpts.outputMode = makeOutputMode(resolvedOutputMode);
  }
  if (options.alignment && options.alignment !== 'auto') {
    extractorOpts.alignment = options.alignment;
  }
  if (options.liveStartOffsetSegments !== undefined && options.liveStartOffsetSegments !== null && options.liveStartOffsetSegments !== '') {
    extractorOpts.liveStartOffsetSegments = Number(options.liveStartOffsetSegments);
  }
  // Apply a pending seek (stashed via /api/seek before this session existed)
  // as the bootstrap startTimeSec. Clears the pending value so it doesn't
  // leak into the next session.
  const appliedPendingSeek = pendingTimeSec;
  if (pendingTimeSec !== null && pendingTimeSec > 0) {
    extractorOpts.startTimeSec = pendingTimeSec;
  }
  pendingTimeSec = null;
  if (appliedPendingSeek !== null) broadcast('pending', { pendingTimeSec: null });

  if (options.allowMonoAudio) extractorOpts.allowMonoAudio = true;

  // Per-file audio extraction (--audio / --audio-out-dir / --audio-group).
  // Mirrors the CLI: --audio requires --audio-out-dir.
  if (options.audio && options.audio.trim().length > 0) {
    const v = options.audio.trim();
    extractorOpts.audioSelection = v === 'all'
      ? 'all'
      : v.split(',').map((s) => s.trim()).filter(Boolean);
    if (!options.audioOutDir || options.audioOutDir.trim().length === 0) {
      throw new Error('--audio requires audioOutDir');
    }
    extractorOpts.audioOutDir = path.resolve(__dirname, options.audioOutDir.trim());
    if (options.audioGroup && options.audioGroup.trim().length > 0) {
      extractorOpts.audioPreferredGroup = options.audioGroup.trim();
    }
  }

  // Inline audio. The default (no-inline-audio toggle off, languages blank)
  // matches the CLI: when output mode is ts-canonical, multiplex ALL audio
  // languages inline.
  if (resolvedOutputMode === 'ts-canonical') {
    if (options.noInlineAudio) {
      // omit; extractor video-only
    } else if (options.inlineAudioLanguages && options.inlineAudioLanguages.trim().length > 0) {
      const v = options.inlineAudioLanguages.trim();
      extractorOpts.inlineAudioLanguages = v === 'all'
        ? 'all'
        : v.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      extractorOpts.inlineAudioLanguages = 'all';
    }
  }

  const extractor = new Extractor(extractorOpts);

  session = {
    id,
    url,
    options,
    extractor,
    ffplay,
    sink,
    abort,
    startedAt: Date.now(),
    logs: [],
    state: 'starting',
    error: null,
    exitInfo: null,
    ffplayExitInfo: null,
    runPromise: Promise.resolve(),
  };

  appendLog(`session ${id} starting: url=${url} outputMode=${outputModeId}`);
  if (appliedPendingSeek !== null && appliedPendingSeek > 0) {
    appendLog(`pending seek ${appliedPendingSeek}s applied as startTimeSec`);
  }

  session.runPromise = (async () => {
    try {
      // Flip to 'running' on the first iteration; the extractor doesn't have
      // a "ready" event, so we set it immediately after kicking off.
      Promise.resolve().then(() => {
        if (session && session.id === id && session.state === 'starting') {
          setState('running');
        }
      });
      await extractor.run();
      await sink.end();
      appendLog(`extractor finished cleanly`);
      if (session?.id === id) {
        session.exitInfo = { code: 0, signal: null };
        setState('stopped');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If we asked the extractor to stop (abort fired), any error it raises
      // on the way out is a stop, not a failure — including a sink "write
      // after destroy" error from the ffplay.stdin we tore down ourselves.
      const isStop = abort.signal.aborted || (err instanceof Error && err.name === 'AbortError');
      if (isStop) {
        appendLog(`extractor aborted`);
        if (session?.id === id) {
          session.exitInfo = { code: 0, signal: 'SIGINT' };
          setState('stopped');
        }
      } else {
        appendLog(`extractor error: ${msg}`);
        if (session?.id === id) {
          session.error = msg;
          setState('error');
        }
      }
    } finally {
      // close ffplay's stdin so the player exits naturally
      try {
        if (session?.id === id && session.ffplay.stdin && !session.ffplay.stdin.destroyed) {
          session.ffplay.stdin.end();
        }
      } catch {}
    }
  })();

  return publicSession();
}

// -- routes --------------------------------------------------------------

app.get('/api/session', (_req, res) => {
  res.json(publicSnapshot());
});

app.post('/api/session', async (req, res) => {
  const { url, options } = req.body ?? {};
  if (typeof url !== 'string' || url.length === 0) {
    return res.status(400).json({ error: 'url is required' });
  }
  // Always tear down whatever's there. Previously the state-guard ('running'/
  // 'paused'/'starting') skipped this branch for already-stopped sessions, but
  // we want unconditional cleanup; stopSession itself short-circuits cleanly.
  const previous = session;
  if (previous) {
    await stopSession('replaced by new session');
    // Wait up to 2.5s for graceful teardown so we don't have two ffplay
    // windows fighting. If the previous runPromise doesn't resolve in time
    // (e.g. sink.write parked on a drain event we already destroyed), force
    // SIGKILL and proceed — the new session is independent of the old one.
    const winner = await Promise.race([
      previous.runPromise.then(() => 'done').catch(() => 'done'),
      new Promise((r) => setTimeout(() => r('timeout'), 2500).unref()),
    ]);
    if (winner === 'timeout') {
      appendLog(`previous session ${previous.id} didn't resolve in 2.5s; forcing kill and proceeding`);
      if (previous.ffplay.exitCode === null && !previous.ffplay.killed) {
        try { previous.ffplay.kill('SIGKILL'); } catch {}
      }
    }
  }
  try {
    const info = startSession(url, options ?? {});
    res.status(201).json(info);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/session/:id/pause', (req, res) => {
  if (!session || session.id !== req.params.id) return res.status(404).json({ error: 'no such session' });
  if (session.state !== 'running') return res.status(409).json({ error: `cannot pause in state=${session.state}` });
  session.extractor.pause();
  setState('paused');
  res.json(publicSession());
});

app.post('/api/session/:id/resume', (req, res) => {
  if (!session || session.id !== req.params.id) return res.status(404).json({ error: 'no such session' });
  if (session.state !== 'paused') return res.status(409).json({ error: `cannot resume in state=${session.state}` });
  session.extractor.resume();
  setState('running');
  res.json(publicSession());
});

/**
 * Unified seek endpoint. Behavior depends on whether a session is live:
 *
 *   - session active (running/paused/starting): forwards to extractor.seek(),
 *     which pauses-seeks-resumes around the call. VOD only — the library
 *     warns and no-ops on live.
 *   - no active session: stashes the value as `pendingTimeSec`. The NEXT
 *     `POST /api/session` consumes it as the bootstrap `startTimeSec`. This
 *     avoids the t=0 visual blip you'd get if we instead called seek()
 *     immediately after start.
 *
 * Either way the caller talks to one endpoint and gets one mental model:
 * "set the playhead". Pass `{ timeSec: 0 }` (or omit / null) to clear a
 * stash without setting one.
 */
app.post('/api/seek', async (req, res) => {
  const raw = req.body?.timeSec;
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0) {
    return res.status(400).json({ error: 'timeSec must be a non-negative number' });
  }

  const live = session && (session.state === 'starting' || session.state === 'running' || session.state === 'paused');
  if (live) {
    try {
      const wasPaused = session.extractor.isPaused?.() ?? false;
      if (!wasPaused) session.extractor.pause();
      const actual = await session.extractor.seek(t);
      if (!wasPaused) session.extractor.resume();
      return res.json({
        applied: 'live',
        playheadSec: actual,
        session: publicSession(),
        pendingTimeSec,
      });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  pendingTimeSec = t > 0 ? t : null;
  broadcast('pending', { pendingTimeSec });
  return res.json({
    applied: 'pending',
    pendingTimeSec,
    note: 'no active session; will apply as startTimeSec on next session create',
  });
});

app.delete('/api/session/:id', async (req, res) => {
  if (!session || session.id !== req.params.id) return res.status(404).json({ error: 'no such session' });
  const target = session;
  await stopSession('user requested stop');
  // Block until the session is genuinely wound down before responding. This
  // is what lets the client safely do `DELETE → POST /api/seek → POST
  // /api/session` and have the seek stash (not live-seek the previous
  // session). 2.5s max so a stuck teardown can't deadlock the client.
  await Promise.race([
    target.runPromise.then(() => null).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 2500).unref()),
  ]);
  res.json({ ok: true });
});

// SSE stream of state + log events. Sends a snapshot first, then incremental
// events until the client disconnects.
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  res.write(`event: state\ndata: ${JSON.stringify(publicSession())}\n\n`);
  res.write(`event: pending\ndata: ${JSON.stringify({ pendingTimeSec })}\n\n`);
  if (session) {
    for (const entry of session.logs.slice(-200)) {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }
  }

  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// -- bootstrap -----------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`hls-pipe test-app listening on http://localhost:${PORT}`);
  console.log(`open the URL in your browser, paste an HLS URL, click Start.`);
});

async function shutdown(sig) {
  console.log(`\n${sig}, shutting down`);
  await stopSession('server shutdown');
  if (session?.runPromise) {
    try { await session.runPromise; } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

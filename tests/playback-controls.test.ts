/*
 * hls-pipe — play/pause/seek + --start-time tests
 *
 * Covers:
 *   - clampStartTime pure helper
 *   - Extractor.pause()/resume()/isPaused() state-machine semantics
 *   - bootstrap startTimeSec re-anchors the video cursor on VOD
 *   - bootstrap startTimeSec is ignored (with a warning) on live
 *   - bootstrap startTimeSec clamps out-of-range values
 *   - seek() is a no-op on live with a warning
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import {
  Extractor,
  clampStartTime,
  StdoutSink,
  TsPassthroughMode,
  TsCanonicalMode,
  parseMedia,
} from '../src/index.js';
import type { Loader, LoaderRequest, LoaderResult } from '../src/types.js';

// -- fixtures --------------------------------------------------------------

const VOD_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6,
seg0.ts
#EXTINF:6,
seg1.ts
#EXTINF:6,
seg2.ts
#EXTINF:6,
seg3.ts
#EXTINF:6,
seg4.ts
#EXT-X-ENDLIST
`;

const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:4,
seg100.ts
#EXTINF:4,
seg101.ts
#EXTINF:4,
seg102.ts
`;

/**
 * Loader that serves a known media playlist for any *.m3u8 URL and a tiny
 * MPEG-TS sync byte sentinel for any segment URL. Records every fetch so
 * tests can assert which segments were pulled.
 */
class FakeLoader implements Loader {
  public readonly fetched: string[] = [];
  constructor(private readonly playlistText: string) {}
  async fetch(req: LoaderRequest): Promise<LoaderResult> {
    this.fetched.push(req.url);
    const body = req.url.endsWith('.m3u8')
      ? new TextEncoder().encode(this.playlistText)
      : new Uint8Array(); // empty segment — TsPassthroughMode just forwards it
    return {
      url: req.url,
      status: 200,
      headers: {},
      body,
      stats: { ttfbMs: 1, totalMs: 2, bytes: body.byteLength },
    };
  }
}

function makeSink(): StdoutSink {
  const passthrough = new PassThrough();
  passthrough.resume(); // drain to /dev/null
  return new StdoutSink(passthrough);
}

// -- clampStartTime --------------------------------------------------------

describe('clampStartTime', () => {
  const vod = parseMedia(VOD_PLAYLIST, 'https://x/p.m3u8');

  it('returns 0 for negative input', () => {
    assert.equal(clampStartTime(-5, vod), 0);
  });

  it('returns 0 for NaN input', () => {
    assert.equal(clampStartTime(Number.NaN, vod), 0);
  });

  it('clamps overshoot to totalDuration − lastSegmentDuration', () => {
    // 5 segments × 6s = 30s total; last segment starts at 24s.
    assert.equal(clampStartTime(999, vod), 24);
  });

  it('passes through values within range', () => {
    assert.equal(clampStartTime(0, vod), 0);
    assert.equal(clampStartTime(12, vod), 12);
    assert.equal(clampStartTime(24, vod), 24);
  });

  it('returns 0 on empty playlist', () => {
    const empty = parseMedia(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n',
      'https://x/p.m3u8',
    );
    assert.equal(clampStartTime(10, empty), 0);
  });
});

// -- pause/resume state machine -------------------------------------------

describe('Extractor pause/resume state', () => {
  function makeExtractor(): Extractor {
    return new Extractor({
      url: 'https://x/p.m3u8',
      sink: makeSink(),
      loader: new FakeLoader(VOD_PLAYLIST),
    });
  }

  it('starts unpaused', () => {
    assert.equal(makeExtractor().isPaused(), false);
  });

  it('pause() sets isPaused() true', () => {
    const e = makeExtractor();
    e.pause();
    assert.equal(e.isPaused(), true);
  });

  it('resume() clears isPaused()', () => {
    const e = makeExtractor();
    e.pause();
    e.resume();
    assert.equal(e.isPaused(), false);
  });

  it('pause() is idempotent', () => {
    const e = makeExtractor();
    e.pause();
    e.pause();
    e.pause();
    assert.equal(e.isPaused(), true);
    e.resume();
    assert.equal(e.isPaused(), false);
  });

  it('resume() before pause() is a no-op', () => {
    const e = makeExtractor();
    e.resume();
    assert.equal(e.isPaused(), false);
  });
});

// -- seek() guard ----------------------------------------------------------

describe('Extractor seek()', () => {
  it('throws when called before run() has bootstrapped', async () => {
    const e = new Extractor({
      url: 'https://x/p.m3u8',
      sink: makeSink(),
      loader: new FakeLoader(VOD_PLAYLIST),
    });
    await assert.rejects(() => e.seek(10), /before run/);
  });

  // Regression: a pause+seek+resume issued while a segment fetch was in flight
  // used to be clobbered by the in-flight iteration's post-write cursor advance
  // (cursor jumped to N+1 instead of staying on the seek target). The seek log
  // line was correct but the next fetched segment ignored it.
  it('seeking during an in-flight fetch retargets the next fetch to the seek target', async () => {
    // Loader holds the FIRST segment fetch so we can race a seek against it.
    // All later fetches resolve immediately.
    let releaseFirstSegment!: () => void;
    const firstSegmentGate = new Promise<void>((resolve) => {
      releaseFirstSegment = resolve;
    });
    const fetched: string[] = [];
    let segmentFetches = 0;
    const loader: Loader = {
      async fetch(req: LoaderRequest): Promise<LoaderResult> {
        fetched.push(req.url);
        const body = req.url.endsWith('.m3u8')
          ? new TextEncoder().encode(VOD_PLAYLIST)
          : new Uint8Array();
        if (req.kind === 'segment') {
          segmentFetches++;
          if (segmentFetches === 1) await firstSegmentGate;
        }
        return {
          url: req.url,
          status: 200,
          headers: {},
          body,
          stats: { ttfbMs: 1, totalMs: 2, bytes: body.byteLength },
        };
      },
    };

    const abort = new AbortController();
    const logs: string[] = [];
    const e = new Extractor({
      url: 'https://x/p.m3u8',
      sink: makeSink(),
      loader,
      outputMode: new TsPassthroughMode(),
      signal: abort.signal,
      log: (m) => logs.push(m),
    });

    // Spin up the loop; we'll await it after we've forced our race.
    const runPromise = e.run().catch(() => undefined);
    // Wait until the first segment fetch is in flight.
    for (let i = 0; i < 100 && segmentFetches === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(segmentFetches, 1, 'expected one in-flight segment fetch');

    // Now race: pause, seek to seg2 (12s in), resume — all before the first
    // fetch completes. The bug clobbers the seek cursor here.
    e.pause();
    const seekTarget = await e.seek(12);
    assert.equal(seekTarget, 12, `seek returned ${seekTarget}`);
    e.resume();

    // Release the held first segment; the iteration finishes, writes seg0,
    // then must NOT advance cursor — next fetch should be seg2, not seg1.
    releaseFirstSegment();
    // Wait until a second segment URL appears, then abort.
    for (let i = 0; i < 100 && fetched.filter((u) => u.endsWith('.ts')).length < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    abort.abort();
    await runPromise;

    const tsFetches = fetched.filter((u) => u.endsWith('.ts'));
    assert.ok(tsFetches.length >= 2, `expected ≥2 segment fetches; got ${tsFetches.join(',')}`);
    assert.equal(tsFetches[0], 'https://x/seg0.ts', 'first fetch should be the pre-seek seg0');
    assert.equal(
      tsFetches[1],
      'https://x/seg2.ts',
      `post-seek fetch should jump to seg2; got ${tsFetches[1]}`,
    );
  });
});

// -- startTimeSec bootstrap behavior (VOD) --------------------------------

describe('startTimeSec at bootstrap', () => {
  it('VOD: re-anchors the cursor to the segment covering the requested time', async () => {
    // startTimeSec=14 → bracketing segment is seg2 (covers 12-18).
    const loader = new FakeLoader(VOD_PLAYLIST);
    const logs: string[] = [];
    const e = new Extractor({
      url: 'https://x/master.m3u8',
      sink: makeSink(),
      loader,
      outputMode: new TsPassthroughMode(),
      startTimeSec: 14,
      log: (m) => logs.push(m),
    });
    await e.run();
    // The first segment fetched should be seg2.ts (not seg0.ts).
    const firstSegment = loader.fetched.find((u) => u.endsWith('.ts'));
    assert.equal(firstSegment, 'https://x/seg2.ts', `first segment was ${firstSegment}`);
    assert.ok(
      logs.some((l) => l.includes('startTimeSec applied') && l.includes('playhead=12.00')),
      `expected log "startTimeSec applied: playhead=12.00s, seq=2"; got: ${logs.join(' | ')}`,
    );
  });

  it('VOD: clamps an out-of-range startTimeSec and logs', async () => {
    const loader = new FakeLoader(VOD_PLAYLIST);
    const logs: string[] = [];
    const e = new Extractor({
      url: 'https://x/master.m3u8',
      sink: makeSink(),
      loader,
      outputMode: new TsPassthroughMode(),
      startTimeSec: 999,
      log: (m) => logs.push(m),
    });
    await e.run();
    // Clamp lands at 24s → seg4 (the last segment).
    const firstSegment = loader.fetched.find((u) => u.endsWith('.ts'));
    assert.equal(firstSegment, 'https://x/seg4.ts', `first segment was ${firstSegment}`);
    assert.ok(
      logs.some((l) => l.includes('clamped: 999s')),
      `expected clamp log; got: ${logs.join(' | ')}`,
    );
  });

  it('LIVE: warns and is ignored', async () => {
    // Live: the loop would otherwise block forever waiting for new segments
    // after exhausting the playlist. Abort once bootstrap fires its log line
    // so the loop's throwIfAborted exits cleanly (run() resolves on abort).
    const loader = new FakeLoader(LIVE_PLAYLIST);
    const logs: string[] = [];
    const abort = new AbortController();
    const liveExt = new Extractor({
      url: 'https://x/master.m3u8',
      sink: makeSink(),
      loader,
      outputMode: new TsPassthroughMode(),
      startTimeSec: 60,
      signal: abort.signal,
      log: (m) => {
        logs.push(m);
        if (m.startsWith('bootstrap:')) abort.abort();
      },
    });
    await liveExt.run();
    assert.ok(
      logs.some((l) => l.includes('startTimeSec=60s ignored on live stream')),
      `expected "ignored on live stream" log; got: ${logs.join(' | ')}`,
    );
  });
});

// -- seek() live no-op -----------------------------------------------------

// -- inline-audio ordering -------------------------------------------------

/**
 * Master playlist with three audio renditions deliberately listed in an
 * order DIFFERENT from typical user input. Order in master.audio: fra, eng, nor.
 * User input: --inline-audio=nor,eng,fra. The PMT must end up with nor first
 * so ffplay-style "pick first audio stream" players play Norwegian.
 */
const MASTER_REVERSE_AUDIO = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="French",LANGUAGE="fra",URI="audio-fra.m3u8",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="eng",URI="audio-eng.m3u8",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Norwegian",LANGUAGE="nor",URI="audio-nor.m3u8",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2"
#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="aud"
video.m3u8
`;

const AUDIO_RENDITION_VOD = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg0.m4s
#EXT-X-ENDLIST
`;

class MultiAudioFakeLoader implements Loader {
  public readonly fetched: string[] = [];
  async fetch(req: LoaderRequest): Promise<LoaderResult> {
    this.fetched.push(req.url);
    let body: Uint8Array;
    if (req.url.endsWith('master.m3u8')) {
      body = new TextEncoder().encode(MASTER_REVERSE_AUDIO);
    } else if (req.url.endsWith('video.m3u8')) {
      body = new TextEncoder().encode(VOD_PLAYLIST);
    } else if (req.url.endsWith('.m3u8')) {
      body = new TextEncoder().encode(AUDIO_RENDITION_VOD);
    } else {
      body = new Uint8Array();
    }
    return {
      url: req.url,
      status: 200,
      headers: {},
      body,
      stats: { ttfbMs: 1, totalMs: 2, bytes: body.byteLength },
    };
  }
}

describe('inline-audio explicit list order is honored in PMT', () => {
  it('user list nor,eng,fra produces ctxs in that order regardless of master.audio order', async () => {
    // The master lists fra, eng, nor in that order; without the fix the
    // first audio PID would be French. With the fix, Norwegian is first.
    const loader = new MultiAudioFakeLoader();
    const logs: string[] = [];
    const abort = new AbortController();
    const e = new Extractor({
      url: 'https://x/master.m3u8',
      sink: makeSink(),
      loader,
      outputMode: new TsCanonicalMode(),
      inlineAudioLanguages: ['nor', 'eng', 'fra'],
      signal: abort.signal,
      log: (m) => {
        logs.push(m);
        // Abort once bootstrap-time inline-audio logs have all fired so the
        // run() resolves cleanly without trying to fetch segments.
        if (m.startsWith('bootstrap:')) abort.abort();
      },
    });
    await e.run();
    // Filter to per-language PID-assignment log lines, in emission order.
    const pidLines = logs.filter((l) => /^inline-audio\[[^\]]+\]: PID=/.test(l));
    assert.equal(pidLines.length, 3, `expected 3 PID-assignment lines; got: ${pidLines.join(' | ')}`);
    const order = pidLines.map((l) => /^inline-audio\[([^\]]+)\]:/.exec(l)![1]);
    assert.deepEqual(order, ['nor', 'eng', 'fra'], `wrong PID-assignment order: ${order.join(',')}`);
  });
});

describe('Extractor seek() on live', () => {
  it('warns and returns the unchanged playhead', async () => {
    const loader = new FakeLoader(LIVE_PLAYLIST);
    const logs: string[] = [];
    const abort = new AbortController();
    let seekResult: number | undefined;
    let seekError: unknown;
    const e = new Extractor({
      url: 'https://x/master.m3u8',
      sink: makeSink(),
      loader,
      outputMode: new TsPassthroughMode(),
      signal: abort.signal,
      log: (m) => {
        logs.push(m);
        if (m.startsWith('bootstrap:')) {
          // Fire seek + abort once bootstrap has stamped state. The seek call
          // is sync up to the playlist cache hit; await it after run() returns.
          e.seek(60)
            .then((p) => (seekResult = p))
            .catch((err) => (seekError = err))
            .finally(() => abort.abort());
        }
      },
    });
    await e.run();
    assert.equal(seekError, undefined, `seek rejected: ${seekError}`);
    assert.ok(
      logs.some((l) => l.includes('seek(60s) ignored on live stream')),
      `expected seek-ignored log; got: ${logs.join(' | ')}`,
    );
    assert.equal(typeof seekResult, 'number');
  });
});

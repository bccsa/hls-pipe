/* hls-pipe test-app — browser UI */

const $ = (id) => document.getElementById(id);
const els = {
  form: $('start-form'),
  url: $('url'),
  outputMode: $('outputMode'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  pauseBtn: $('pause-btn'),
  resumeBtn: $('resume-btn'),
  seekBtn: $('seek-btn'),
  seekInput: $('seek-input'),
  state: $('state'),
  sessionId: $('session-id'),
  mediaOut: $('media-out'),
  ffplayPid: $('ffplay-pid'),
  log: $('log'),
  clearLogBtn: $('clear-log-btn'),
  autoscroll: $('autoscroll'),
  audioSection: $('audio-section'),
  pendingHint: $('pending-hint'),
  pendingValue: $('pending-value'),
};

let session = null;
let pendingTimeSec = null;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function renderState(s) {
  session = s;
  if (!s) {
    els.state.textContent = 'no session';
    els.state.className = '';
    els.sessionId.textContent = '—';
    els.mediaOut.textContent = '0 s / 0 B';
    els.ffplayPid.textContent = '—';
    setControlState(null);
    return;
  }
  els.state.textContent = s.state + (s.error ? ` (${s.error})` : '');
  els.state.className = `state-${s.state}`;
  els.sessionId.textContent = s.id;
  els.mediaOut.textContent = `${(s.mediaSecondsWritten ?? 0).toFixed(1)} s / ${fmtBytes(s.bytesWritten ?? 0)}`;
  els.ffplayPid.textContent = s.ffplayPid ?? '—';
  setControlState(s.state);
}

function setControlState(state) {
  const live = state === 'running' || state === 'paused' || state === 'starting';
  els.stopBtn.disabled = !live;
  els.pauseBtn.disabled = state !== 'running';
  els.resumeBtn.disabled = state !== 'paused';
  // Seek is always enabled — before start, it stashes as the initial playhead.
  els.seekBtn.disabled = false;
  els.startBtn.disabled = state === 'starting';
}

function renderPending(t) {
  pendingTimeSec = t;
  if (t && t > 0) {
    els.pendingHint.hidden = false;
    els.pendingValue.textContent = String(t);
  } else {
    els.pendingHint.hidden = true;
  }
}

function fmtTs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function appendLog({ t, line }) {
  const span = document.createElement('div');
  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = fmtTs(t) + ' ';
  span.appendChild(tsSpan);

  let cls = '';
  if (line.startsWith('[ffplay]')) cls = 'ffplay';
  else if (line.startsWith('[hls-pipe]')) cls = 'hls';
  else if (line.toLowerCase().includes('error')) cls = 'err';

  const body = document.createElement('span');
  if (cls) body.className = cls;
  body.textContent = line;
  span.appendChild(body);

  els.log.appendChild(span);
  if (els.autoscroll.checked) els.log.scrollTop = els.log.scrollHeight;
}

// -- SSE --------------------------------------------------------------

function openEventStream() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (ev) => {
    try { renderState(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('log', (ev) => {
    try { appendLog(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('pending', (ev) => {
    try { renderPending(JSON.parse(ev.data).pendingTimeSec); } catch {}
  });
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

// -- form / actions ---------------------------------------------------

function collectOptions(formData) {
  const opt = {};
  for (const [k, v] of formData.entries()) {
    if (v === '' || v === null || v === undefined) continue;
    if (k === 'skipOnStall' || k === 'noInlineAudio' || k === 'allowMonoAudio') {
      opt[k] = true;
    } else {
      opt[k] = v;
    }
  }
  // Unchecked checkboxes don't appear in formData; that's fine — we treat
  // their absence as false on the server side.
  return opt;
}

els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(els.form);
  const url = fd.get('url');
  if (!url) return;
  els.startBtn.disabled = true;
  try {
    // If a session is currently live, tear it down BEFORE stashing the
    // playhead. Otherwise the stash POST would be applied as a live seek to
    // the about-to-be-replaced session, and the new session would start at 0.
    // The server's DELETE blocks until the session is fully wound down.
    if (session && (session.state === 'running' || session.state === 'paused' || session.state === 'starting')) {
      await fetch(`/api/session/${session.id}`, { method: 'DELETE' });
    }
    // Now stash the playhead value (server has no live session → goes to
    // pendingTimeSec, consumed by the create call below as startTimeSec).
    const seekValue = els.seekInput.value.trim();
    if (seekValue.length > 0) {
      const t = Number(seekValue);
      if (Number.isFinite(t) && t >= 0) {
        await fetch('/api/seek', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeSec: t }),
        });
      }
    }
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, options: collectOptions(fd) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      appendLog({ t: Date.now(), line: `error starting session: ${err.error}` });
    }
    // Do NOT renderState() from the HTTP response here: SSE delivers the
    // authoritative state (including the 'starting' → 'running' transition
    // that fires in a microtask on the server immediately after this response
    // is sent). If the SSE 'state' event arrives first and we then renderState
    // from a stale 'starting' response, the Pause/Resume buttons stay disabled
    // for the whole session.
  } finally {
    if (!session || (session.state !== 'starting' && session.state !== 'running' && session.state !== 'paused')) {
      els.startBtn.disabled = false;
    }
  }
});

els.stopBtn.addEventListener('click', async () => {
  if (!session) return;
  await fetch(`/api/session/${session.id}`, { method: 'DELETE' });
});

els.pauseBtn.addEventListener('click', async () => {
  if (!session) return;
  await fetch(`/api/session/${session.id}/pause`, { method: 'POST' });
});

els.resumeBtn.addEventListener('click', async () => {
  if (!session) return;
  await fetch(`/api/session/${session.id}/resume`, { method: 'POST' });
});

els.seekBtn.addEventListener('click', async () => {
  const t = Number(els.seekInput.value);
  if (!Number.isFinite(t) || t < 0) return;
  const res = await fetch('/api/seek', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeSec: t }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    appendLog({ t: Date.now(), line: `seek failed: ${err.error}` });
    return;
  }
  const result = await res.json();
  if (result.applied === 'pending') {
    renderPending(result.pendingTimeSec);
    appendLog({ t: Date.now(), line: `seek stashed: ${result.pendingTimeSec}s (will apply on next Start)` });
  } else {
    appendLog({ t: Date.now(), line: `seek applied: playhead → ${result.playheadSec?.toFixed?.(2) ?? result.playheadSec}s` });
  }
});

els.clearLogBtn.addEventListener('click', () => {
  els.log.innerHTML = '';
});

// Toggle audio panel state based on output mode (inline-audio only applies
// to ts-canonical). Just visual — server enforces it too.
function refreshAudioSectionVisibility() {
  const isCanonical = els.outputMode.value === 'ts-canonical';
  els.audioSection.style.opacity = isCanonical ? '1' : '0.5';
  els.audioSection.querySelectorAll('input').forEach((i) => { i.disabled = !isCanonical; });
}
els.outputMode.addEventListener('change', refreshAudioSectionVisibility);
refreshAudioSectionVisibility();

openEventStream();

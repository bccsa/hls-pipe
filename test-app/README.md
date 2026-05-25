# hls-pipe test-app

Browser-driven test harness for the `hls-pipe` library. An Express server in
this folder proxies the library API and feeds the output stream into a local
`ffplay` window — useful for exercising every CLI option (and the runtime
play / pause / seek controls) without juggling shell pipes.

```
browser ──REST/SSE──▶ Express ──Extractor──▶ StdoutSink ──pipe──▶ ffplay window
```

The video plays in a **separate `ffplay` window** spawned by the server. The
browser only controls the session and shows status / logs.

## Requirements

- Node ≥ 20
- `ffplay` on `PATH` (Homebrew: `brew install ffmpeg`)
- `hls-pipe` built — this app imports `../dist/index.js`, so run
  `npm run build` in the repo root if you've modified `src/`.

## Run

From the repo root:

```sh
# one-time build of the library (skip if dist/ is already current)
npm run build

cd test-app
npm install
npm start
```

Then open <http://localhost:3001>. The port is configurable via `PORT=4000 npm start`.

## CLI option coverage

Every flag the `hls-pipe` CLI accepts has a corresponding form field, grouped
into collapsible sections. The mapping:

| CLI flag                       | Form field / section                              |
| ------------------------------ | ------------------------------------------------- |
| `<hls-url>` (positional)       | HLS URL (required)                                |
| `--quality=<spec>`             | Variant / ABR → Quality (incl. `index:N`, `maxBitrate:N`) |
| `--abr-preset=default|unstable`| Variant / ABR → ABR preset                        |
| `--cap-bitrate=N`              | Variant / ABR → Cap bitrate                       |
| `--align=auto|mediaSequence|cumulative` | Variant / ABR → Alignment                |
| `--live-start=N`               | Live / latency → liveStartOffsetSegments          |
| `--live-sync=N`                | Live / latency → liveSyncTargetSec                |
| `--live-max-lag=N`             | Live / latency → liveMaxLatencySec                |
| `--skip-on-stall`              | Live / latency → skipOnStall (checkbox)           |
| `--output=ts-canonical|ts|es-audio|es-video` | Output transform → Output mode      |
| `--inline-audio=<spec>`        | Inline audio → Languages                          |
| `--no-inline-audio`            | Inline audio → --no-inline-audio (checkbox)       |
| `--allow-mono-audio`           | Inline audio → --allow-mono-audio (checkbox)      |
| `--audio=<langs>`              | Per-file audio extraction → --audio               |
| `--audio-out-dir=<p>`          | Per-file audio extraction → --audio-out-dir (resolved relative to the test-app dir) |
| `--audio-group=<id>`           | Per-file audio extraction → --audio-group         |
| `--seek=N`                     | Playback section → Playhead input + Seek button (see "Unified seek" below) |
| `--verbose` / `-v`             | Always on — the test-app wires a log callback unconditionally and streams it to the browser via SSE |
| `--help` / `-h`                | n/a (form-based UI)                               |

Runtime playback controls — these have **no CLI equivalent** because the CLI
is single-shot; they use the `Extractor` API directly:

- **Pause / Resume** — `extractor.pause()` / `extractor.resume()`. The
  in-flight segment finishes; the next iteration awaits the gate.
- **Stop** — aborts the extractor and closes ffplay's stdin so the player exits.

## Unified seek

The test-app exposes **one** endpoint for "set the playhead":

- `POST /api/seek` with `{ timeSec }`
  - **Session active** (running / paused / starting): forwards to
    `extractor.seek(timeSec)`. Library wraps the call with pause + resume so
    you don't have to coordinate three round-trips. VOD only; live streams
    log a warning and no-op. Out-of-range values clamp to the last segment.
  - **No active session**: stashes the value server-side as `pendingTimeSec`.
    The next `POST /api/session` consumes it as the bootstrap `startTimeSec`
    (the library's constructor option). This avoids a t=0 visual blip you'd
    get by always calling `seek()` post-start.

The CLI flag for the same concept is `--seek=N` (formerly `--start-time=N`).
Since the CLI is single-shot, only the "before start" case applies.

**UI shortcut**: typing a value in the Playhead input and clicking **Start**
(without clicking Seek first) works in one click — the browser auto-POSTs the
value to `/api/seek` to stash it, then POSTs `/api/session`. Clicking Seek
explicitly is only needed for mid-play.

## How `ffplay` is launched (foreground behavior)

`ffplay` has two flags relevant to "foreground" / focus on macOS, Linux, and
Windows:

- **`-alwaysontop`** — the window stays above other windows. Best-effort
  "foreground"; it does **not** grab focus, so your keyboard stays with the
  browser, but the video remains visible. **This app uses it by default.**
- **`-window_title <title>`** — sets the window title to
  `hls-pipe :: <session-id> [...]` so you can tell sessions apart.

Other flags worth knowing if you want to tweak `spawnFfplay()` in `server.js`:

- `-fs` — start fullscreen (Esc to exit)
- `-noborder` — borderless window
- `-left <x> -top <y>` — initial window position
- `-autoexit` — quit when input EOFs (this app passes it)

There is no portable cross-platform flag to *steal* focus to the video
window. On macOS the convention is to click the window to bring it forward;
`-alwaysontop` is the closest substitute.

The input format ffplay expects is selected to match the chosen output mode:

| Output mode      | ffplay `-f` |
| ---------------- | ----------- |
| `ts-canonical`   | `mpegts`    |
| `ts`             | `mpegts`    |
| `es-audio`       | `aac`       |
| `es-video`       | `h264`      |

## HTTP API

| Method | Path                          | Purpose                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/session`                | Snapshot — `{ session, pendingTimeSec }` |
| POST   | `/api/session`                | Start a session — body `{ url, options }`. Replaces any active session. Consumes `pendingTimeSec` as `startTimeSec`. Returns 201 + session snapshot. |
| POST   | `/api/session/:id/pause`      | Pause                                    |
| POST   | `/api/session/:id/resume`     | Resume                                   |
| POST   | `/api/seek`                   | Body `{ timeSec }`. Sessionless; see "Unified seek" above. |
| DELETE | `/api/session/:id`            | Stop                                     |
| GET    | `/api/events`                 | SSE: `state`, `log`, `pending` events    |

`options` keys mirror the form fields (and map 1-to-1 to the CLI flags
above):

```jsonc
{
  "quality": "auto | highest | lowest | index:N | maxBitrate:N",
  "abrPreset": "default | unstable",
  "capBitrate": "0",                  // bits/s, "" for none
  "alignment": "auto | mediaSequence | cumulative",
  "liveStartOffsetSegments": "6",
  "liveSyncSec": "4",
  "liveMaxLagSec": "30",
  "skipOnStall": true,
  "outputMode": "ts-canonical | ts | es-audio | es-video",
  "inlineAudioLanguages": "eng,fra,nor | all | (omit for default = all)",
  "noInlineAudio": true,
  "allowMonoAudio": true,
  "audio": "eng,fra | all",           // per-file extraction
  "audioOutDir": "./audio-out",       // resolved relative to test-app/
  "audioGroup": "audio_hq"            // optional
}
```

Only one session exists at a time. Posting a new one stops the previous and
waits for its `ffplay` to exit before starting the new one.

## Known quirks

- **First-segment latency**: on bootstrap, the Extractor probes the lowest
  variant before the main loop's ABR picks. Expect a 1-2 s gap between
  "Start" and the first frame appearing in `ffplay`.
- **Pause-on-live**: pausing a live stream lets the live edge drift past the
  current cursor. On resume, if you've fallen further behind than
  `liveMaxLatencySec` and `skipOnStall` is on, the extractor jumps to the
  live edge (logged). Otherwise it keeps fetching from where it paused.
- **Seek on live**: no-op, logged. The HTTP call still succeeds.
- **Multi-audio default selection in `ffplay`**: when the canonical TS has
  multiple audio PIDs, `ffplay` picks the **last** tied stream by default.
  This is upstream `av_find_best_stream` behavior — pass `-ast 0:a:0` in
  `spawnFfplay()` if you need to force the first. Other players (mpv, VLC,
  browsers) honor the language tags and pick the right default.

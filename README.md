# hls-pipe

A Node.js HLS extraction service that pipes an HLS stream (live or VOD) to stdout. Strongly inspired by [hls.js](https://github.com/video-dev/hls.js).

**Status: alpha.** Default invocation `hls-pipe <url>` produces one multi-stream MPEG-TS on stdout — H.264 video plus every audio language the master playlist offers. ABR with mid-fragment abandon, fMP4 / CMAF + MPEG-TS sources, AES-128 decryption, and live + VOD all work. See [What works](#what-works) and [What doesn't work yet](#what-doesnt-work-yet).

## Why this exists

`ffmpeg -i <hls-url> -c copy -f mpegts -` is the boring correct answer for most extraction jobs. This project is for cases where you need:

- Fine-grained, programmable ABR — particularly mid-fragment abandon on unstable mobile networks
- Simultaneous extraction of multiple audio languages from a single stream
- A library you can embed in a longer Node.js pipeline rather than shelling to ffmpeg
- Full visibility into the HLS state machine (manifest reloads, discontinuities, byte ranges)

## Relationship to hls.js

hls.js is Apache 2.0. This project adopts a **hybrid port** approach:

- **Direct ports** (with attribution headers) for pure algorithms where there is one obvious correct implementation: HLS grammar parsing, MPEG-TS demuxing, MP4 box generation, AES-128 decryption, EWMA bandwidth math.
- **Fresh writes inspired by hls.js** for orchestration that has to change for Node: the stream controller, the buffer/sink, the loader, the multi-audio coordinator. These files cite the corresponding hls.js source in their headers so future maintainers can diff-compare when hls.js fixes a bug.

**Upstream pin:** ports in this repo are based on hls.js commit [`7f6ac1169`](https://github.com/video-dev/hls.js/commit/7f6ac1169) (`v1.7.0-alpha.1-117-g7f6ac1169`, 2026-05-22 — *"Do not request video buffer flush or EOS when the main playlist is audio-only"*). When pulling in upstream fixes, diff the relevant file against this commit and update this line — keeping a single source of truth here avoids stamping a commit hash into every ported file's header.

See [NOTICE](./NOTICE) for the full attribution.

## Architecture

```
                       hls-pipe
   ┌──────────────────────────────────────────┐
   │  CLI / Library API   (src/cli.ts,        │
   │                       src/index.ts)      │
   └──────────────────┬───────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────┐
   │  Extractor      (src/stream/extractor.ts)│
   │   orchestrates manifest fetch, variant   │
   │   selection, segment loop, live reloads  │
   └────┬────────────────┬────────────────┬───┘
        │                │                │
        ▼                ▼                ▼
   ┌─────────┐    ┌─────────────┐   ┌──────────┐
   │ Parser  │    │  Loader     │   │  Sink    │
   │ (M3U8)  │    │  (Node      │   │ (stdout, │
   │         │    │   fetch)    │   │  back-   │
   │         │    │             │   │  press.) │
   └─────────┘    └─────────────┘   └──────────┘
```

| Module | hls.js counterpart | Style |
|---|---|---|
| [src/parser/m3u8-parser.ts](src/parser/m3u8-parser.ts) | [src/loader/m3u8-parser.ts](../hls.js/src/loader/m3u8-parser.ts) | Fresh, inspired-by |
| [src/parser/attr-list.ts](src/parser/attr-list.ts) | [src/utils/attr-list.ts](../hls.js/src/utils/attr-list.ts) | Fresh, inspired-by |
| [src/loader/node-loader.ts](src/loader/node-loader.ts) | [src/utils/fetch-loader.ts](../hls.js/src/utils/fetch-loader.ts) | Fresh, Node-specific |
| [src/loader/retry.ts](src/loader/retry.ts) | [src/utils/error-helper.ts](../hls.js/src/utils/error-helper.ts) | Fresh, inspired-by |
| [src/abr/ewma.ts](src/abr/ewma.ts) | [src/utils/ewma.ts](../hls.js/src/utils/ewma.ts) | **Direct port** (Apache 2.0) |
| [src/abr/bandwidth-estimator.ts](src/abr/bandwidth-estimator.ts) | [src/utils/ewma-bandwidth-estimator.ts](../hls.js/src/utils/ewma-bandwidth-estimator.ts) | **Direct port** (Apache 2.0) |
| [src/abr/abr-controller.ts](src/abr/abr-controller.ts) | [src/controller/abr-controller.ts](../hls.js/src/controller/abr-controller.ts) | Fresh, inspired-by (findBestLevel + abandon) |
| [src/stream/extractor.ts](src/stream/extractor.ts) | [src/controller/stream-controller.ts](../hls.js/src/controller/stream-controller.ts) | Fresh, radically simplified |
| [src/stream/variant-selector.ts](src/stream/variant-selector.ts) | n/a | Fresh; static selection when ABR is disabled |
| [src/stream/playlist-cache.ts](src/stream/playlist-cache.ts) | [src/controller/level-controller.ts](../hls.js/src/controller/level-controller.ts) | Fresh, inspired-by |
| [src/stream/latency-controller.ts](src/stream/latency-controller.ts) | [src/controller/latency-controller.ts](../hls.js/src/controller/latency-controller.ts) | Fresh, reduced to tracking+ABR-input role (no playbackRate) |
| [src/demux/ts-packet.ts](src/demux/ts-packet.ts) | [src/demux/tsdemuxer.ts](../hls.js/src/demux/tsdemuxer.ts) (parsePID, syncOffset) | **Direct port** (Apache 2.0) |
| [src/demux/pat-pmt.ts](src/demux/pat-pmt.ts) | [src/demux/tsdemuxer.ts](../hls.js/src/demux/tsdemuxer.ts) (parsePAT, parsePMT) | **Direct port** (Apache 2.0) |
| [src/demux/pes.ts](src/demux/pes.ts) | [src/demux/tsdemuxer.ts](../hls.js/src/demux/tsdemuxer.ts) (parsePES + accumulator) | **Direct port** (Apache 2.0) |
| [src/demux/demuxer.ts](src/demux/demuxer.ts) | [src/demux/tsdemuxer.ts](../hls.js/src/demux/tsdemuxer.ts) (main loop) | Fresh, inspired-by — no event bus, no MSE codec gating |
| [src/output/output-mode.ts](src/output/output-mode.ts) | n/a (new abstraction) | Fresh |
| [src/output/stdout-sink.ts](src/output/stdout-sink.ts) | [src/controller/buffer-controller.ts](../hls.js/src/controller/buffer-controller.ts) | Fresh, MSE replaced with stdout |
| [src/output/file-sink.ts](src/output/file-sink.ts) | n/a (sibling to stdout-sink) | Fresh |
| [src/stream/audio-format.ts](src/stream/audio-format.ts) | n/a | Fresh — URI + content sniff to distinguish AAC / TS / fMP4 |
| [src/stream/audio-rendition-extractor.ts](src/stream/audio-rendition-extractor.ts) | [src/controller/audio-stream-controller.ts](../hls.js/src/controller/audio-stream-controller.ts) | Fresh, inspired-by — single-rendition loop |
| [src/stream/audio-coordinator.ts](src/stream/audio-coordinator.ts) | n/a (new concept) | Fresh — spawns N rendition extractors, picks one GROUP-ID |
| [src/parser/webvtt-parser.ts](src/parser/webvtt-parser.ts) | n/a | Fresh — WebVTT cue tokenizer with X-TIMESTAMP-MAP |
| [src/stream/subtitle-rendition-extractor.ts](src/stream/subtitle-rendition-extractor.ts) | [src/controller/subtitle-stream-controller.ts](../hls.js/src/controller/subtitle-stream-controller.ts) | Fresh, inspired-by — single-rendition WebVTT fetch loop with cue-carryover dedup |
| [src/stream/subtitle-coordinator.ts](src/stream/subtitle-coordinator.ts) | n/a (new concept) | Fresh — sibling of audio-coordinator for SUBTITLES groups |
| [src/crypt/decrypter.ts](src/crypt/decrypter.ts) | [src/crypt/decrypter.ts](../hls.js/src/crypt/decrypter.ts) (algorithm) | Fresh, inspired-by — uses Node WebCrypto (we skipped the pure-JS AES port) |
| [src/crypt/key-cache.ts](src/crypt/key-cache.ts) | [src/loader/key-loader.ts](../hls.js/src/loader/key-loader.ts) | Fresh, simpler than upstream |
| [src/demux/video/nal-framing.ts](src/demux/video/nal-framing.ts) | [src/demux/video/base-video-parser.ts](../hls.js/src/demux/video/base-video-parser.ts) (parseNALu) | Fresh, inspired-by — stateless scanner (segment-at-a-time vs hls.js FSM) |
| [src/demux/video/avc.ts](src/demux/video/avc.ts) | [src/demux/video/avc-video-parser.ts](../hls.js/src/demux/video/avc-video-parser.ts) (NAL classification) | **Direct port** (Apache 2.0) for NAL types; SPS/PPS parsing deferred |
| [src/demux/fmp4/box.ts](src/demux/fmp4/box.ts) | n/a (hls.js inlines box helpers in mp4-tools.ts) | Fresh — ISO BMFF box iterator + path lookup |
| [src/demux/fmp4/init-segment.ts](src/demux/fmp4/init-segment.ts) | n/a (hls.js's init parsing is in src/utils/mp4-tools.ts + remuxer) | Fresh — extracts AudioSpecificConfig + per-track timescale |
| [src/demux/fmp4/movie-fragment.ts](src/demux/fmp4/movie-fragment.ts) | n/a (analogous logic embedded in hls.js MP4Remuxer) | Fresh — parses moof/traf/trun + iterates mdat samples |
| [src/demux/fmp4/aac-to-adts.ts](src/demux/fmp4/aac-to-adts.ts) | inverse of [src/remux/mp4-remuxer.ts](../hls.js/src/remux/mp4-remuxer.ts) (which strips ADTS) | Fresh — adds ADTS header per AAC frame |
| [src/demux/fmp4/audio.ts](src/demux/fmp4/audio.ts) | n/a | Fresh — stateful init+segment → ADTS façade |
| [src/demux/fmp4/avc-config.ts](src/demux/fmp4/avc-config.ts) | n/a (hls.js parses avcC inside its remuxer) | Fresh — extracts SPS/PPS + lengthSize from `avcC` |
| [src/demux/fmp4/video.ts](src/demux/fmp4/video.ts) | n/a | Fresh — fMP4 video samples with Annex-B + 90kHz PTS |
| [src/mux/ts/packet.ts](src/mux/ts/packet.ts) | n/a (hls.js only reads TS) | Fresh — 188-byte packetizer with continuity counter + AF stuffing + PCR |
| [src/mux/ts/pat-pmt.ts](src/mux/ts/pat-pmt.ts) | n/a | Fresh — PAT/PMT section builders + CRC-32/MPEG-2 + ISO-639 language + registration_descriptor support |
| [src/mux/ts/pes.ts](src/mux/ts/pes.ts) | inverse of [src/demux/pes.ts](src/demux/pes.ts) | Fresh — PES header + 33-bit PTS/DTS encoding (video / audio / private_stream_1) |
| [src/mux/ts/muxer.ts](src/mux/ts/muxer.ts) | n/a | Fresh — top-level façade muxing video + N audio + N subtitle streams by DTS into one TS |

## Usage

### CLI

```bash
npm install
npm run build
node dist/cli.js https://example.com/master.m3u8 | ffplay -
```

Or during development:

```bash
npm run dev -- https://example.com/master.m3u8 --verbose | ffplay -
```

Options:

```
--quality=<spec>      disable ABR; pick one variant statically
                      highest | lowest | index:N | maxBitrate:N
--abr-preset=<name>   ABR tuning: default | unstable
                      (unstable: tighter EWMA, lower margin)
--cap-bitrate=N       maximum variant bitrate ABR may choose (bits/s)
--live-start=N        start N segments before live edge (default: 6)
--live-sync=N         target latency from live edge in seconds
                      (default: 2 × targetDuration, auto-tuned)
--live-max-lag=N      max tolerated live-edge lag in seconds (default: 30)
--skip-on-stall       jump cursor to live edge when --live-max-lag exceeded
--output=<mode>       ts (default, passthrough) | es-audio | es-video
                      (es-audio: demux MPEG-TS, emit AAC/MP3/AC-3 elementary stream)
                      (es-video: demux MPEG-TS, emit H.264 Annex-B elementary stream)
--audio=<langs>       extract alternate audio renditions in parallel
                      comma-separated LANGUAGE codes (e.g., eng,fra,nor) or "all"
                      each rendition writes to its own file in --audio-out-dir
--audio-out-dir=<p>   directory for per-language audio files (required with --audio)
--audio-group=<id>    restrict to a specific AUDIO GROUP-ID (e.g., audio_hq)
--inline-subtitles=<langs>
                      multiplex subtitle renditions inline as private PIDs
                      (one PID per language, stream_type 0x06 carrying
                      WebVTT cues on private_stream_1). Requires
                      --output=ts-canonical and a master playlist with
                      EXT-X-MEDIA TYPE=SUBTITLES entries. PMT-tagged with
                      ISO 639 language + registration_descriptor "VTT ".
--verbose, -v         log ABR decisions to stderr
```

**ABR is on by default** when the URL points to a master playlist. Use `--quality=` to disable it. Use `--abr-preset=unstable` on slow / lossy mobile connections. For live streams that fall behind on bad networks, `--skip-on-stall` lets the extractor catch up by dropping segments.

### Library

The library surface mirrors the CLI. The top-level entry point is `Extractor`, which is driven by an options object and writes output bytes to a `StdoutSink` (or `FileSink`). Full re-export list lives in [src/index.ts](src/index.ts).

#### Minimal example

```ts
import { Extractor, StdoutSink, makeOutputMode } from 'hls-pipe';

const sink = new StdoutSink(process.stdout, { bufferLimitBytes: 10 * 1024 * 1024 });
await new Extractor({
  url: 'https://example.com/master.m3u8',
  sink,
  outputMode: makeOutputMode('ts-canonical'),
  inlineAudioLanguages: 'all',
  log: (msg) => console.error(msg),
}).run();
```

#### `ExtractorOptions`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | `string` | *required* | HLS URL — master or media playlist. |
| `sink` | `StdoutSink` | *required* | Where segment bytes go. |
| `loader` | `Loader` | `new NodeLoader()` | HTTP loader. Swap to test or to add auth headers. |
| `outputMode` | `OutputMode` | `new TsPassthroughMode()` | Per-segment byte transform. Use `makeOutputMode('ts-canonical' \| 'ts' \| 'es-audio' \| 'es-video')`. |
| `fixedQuality` | `QualityHint` | undefined | Disable ABR. `{kind:'lowest'}`, `{kind:'highest'}`, `{kind:'index', value:N}`, or `{kind:'maxBitrate', bitrate:N}`. |
| `abr` | `Partial<AbrConfig>` | `DEFAULT_ABR_CONFIG` | Override EWMA half-lives, bandwidth margin, abandon thresholds. `UNSTABLE_NETWORK_ABR_CONFIG` is a preset. |
| `latency` | `Partial<LatencyConfig>` | auto-tuned | `liveSyncTargetSec`, `liveMaxLatencySec`, etc. Auto-tunes from first live playlist when not pinned. |
| `autoTuneLiveSync` | `boolean` | `true` | When `latency.liveSyncTargetSec` isn't set explicitly, auto-tune to `2 × targetDuration`. |
| `liveStartOffsetSegments` | `number` | `6` | Segments behind live edge to start at. Larger = more head-room before ABR sees pressure. |
| `inlineAudioLanguages` | `'all' \| string[]` | undefined | Multiplex these languages into the canonical TS. Requires `outputMode = ts-canonical`. |
| `allowMonoAudio` | `boolean` | `false` | Permit all-mono AUDIO groups for inline-mux. Default biases toward stereo+. |
| `audioSelection` | `'all' \| string[]` | undefined | Spawn the per-file audio coordinator for these languages. Runs in parallel with the main video pipeline. |
| `audioOutDir` | `string` | undefined | Required when `audioSelection` is set; one `.aac` file per language is written here. |
| `audioPreferredGroup` | `string` | undefined | Pin the per-file coordinator to a specific AUDIO group-id. Disables ABR-group following. |
| `inlineSubtitleLanguages` | `'all' \| string[]` | undefined | Multiplex SUBTITLES renditions inline as private PIDs (stream_type 0x06, private_stream_1 PES carrying WebVTT cue blocks verbatim). Requires `outputMode = ts-canonical`. PIDs assigned from `DEFAULT_SUBTITLE_PID_BASE` (0x110) in user-list order. |
| `alignment` | `'auto' \| 'mediaSequence' \| 'cumulative'` | `'auto'` | Cross-variant segment alignment. `auto` = cumulative for VOD, mediaSequence for live. |
| `signal` | `AbortSignal` | undefined | Cancellation. The extractor's `run()` rejects with `AbortError` on signal. |
| `log` | `(msg: string) => void` | no-op | One-line status events (ABR decisions, init reloads, skip-to-live, etc.). |
| `abandonCheckIntervalMs` | `number` | `100` | How often the mid-fragment abandon evaluator runs during a segment fetch. |

#### Common patterns

**Fixed quality, no ABR — useful for tests or capped scenarios:**

```ts
new Extractor({
  url, sink,
  fixedQuality: { kind: 'maxBitrate', bitrate: 2_000_000 },
}).run();
```

**Cancellable run with an AbortController (timeouts, user-stop, etc.):**

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000);
try {
  await new Extractor({ url, sink, signal: ac.signal }).run();
} catch (err) {
  if ((err as Error).name !== 'AbortError') throw err;
}
```

**Write to a file instead of stdout:**

```ts
import { createWriteStream } from 'node:fs';
import { Extractor, StdoutSink } from 'hls-pipe';

const sink = new StdoutSink(createWriteStream('out.ts'));
await new Extractor({ url, sink }).run();
await sink.end();
```

(`StdoutSink` accepts any `node:stream.Writable`. `FileSink` is a thin wrapper for `fs.WriteStream` with the same `write(chunk, mediaSeconds)` contract.)

**Per-file multi-language audio in parallel with main video:**

```ts
new Extractor({
  url, sink,
  audioSelection: ['eng', 'fra', 'nor'],   // or 'all'
  audioOutDir: './audio',                  // ./audio/audio-eng.aac, audio-fra.aac, ...
  audioPreferredGroup: 'audio_hq',         // optional; skip to pin a group
}).run();
```

**Inline-mux subtitles into the canonical TS:**

```ts
new Extractor({
  url, sink,
  outputMode: makeOutputMode('ts-canonical'),
  inlineAudioLanguages: ['nor'],            // optional — combine with audio
  inlineSubtitleLanguages: ['eng', 'nor'],  // → PIDs 0x110, 0x111
}).run();
```

The output TS carries one private-data PID per language (stream_type 0x06, stream_id 0xBD private_stream_1). Each PES packet is a verbatim WebVTT cue block (`00:00:01.500 --> 00:00:04.000\ntext\n`) with PTS = absolute cue start in 90 kHz units. PMT entries are tagged with both an ISO 639 language descriptor (when the source declared `LANGUAGE=`) and a registration_descriptor carrying the 4CC `"VTT "` so downstream demuxers can identify the carriage convention without out-of-band signalling. Subtitle PIDs survive SRT / RIST transports transparently — the routing fabric sees them as opaque private-data packets.

**Slow-network preset:**

```ts
import { Extractor, UNSTABLE_NETWORK_ABR_CONFIG } from 'hls-pipe';

new Extractor({
  url, sink,
  abr: UNSTABLE_NETWORK_ABR_CONFIG,
}).run();
```

#### Other public exports

- **Parsing**: `parseMaster`, `parseMedia`, `isMasterPlaylist`, `findSegmentAtTime`, `ParseError`, `parseWebVttSegment`, `WebVttParseError`.
- **ABR**: `AbrController`, `EwmaBandWidthEstimator`, `DEFAULT_ABR_CONFIG`, `UNSTABLE_NETWORK_ABR_CONFIG`.
- **Live**: `LatencyController`, `DEFAULT_LATENCY_CONFIG`.
- **Loader**: `NodeLoader`, `HttpError` — swap for tests or to inject auth.
- **Demux / mux primitives**: `Demuxer`, `MpegTsMuxer`, `Fmp4AudioExtractor`, `Fmp4VideoExtractor`, ISO BMFF box helpers, PAT/PMT/PES builders (including `buildRegistrationDescriptor` for the `"VTT "` 4CC). Useful when you have pre-fetched samples and want to mux them yourself. Constants: `DEFAULT_VIDEO_PID` (0x100), `DEFAULT_AUDIO_PID` (0x101), `DEFAULT_SUBTITLE_PID_BASE` (0x110), `SUBTITLE_FORMAT_ID_WEBVTT` (`"VTT "`).
- **Rendition coordinators**: `AudioCoordinator`, `AudioRenditionExtractor`, `SubtitleCoordinator`, `SubtitleRenditionExtractor` — drive a single or multiple per-language fetch+parse loops directly (bypassing the top-level `Extractor`).
- **Crypto**: `decryptAes128Cbc`, `deriveIv`, `KeyCache`.
- **Types**: `MasterPlaylist`, `MediaPlaylist`, `Variant`, `Segment`, `AlternateRendition`, `LoaderRequest`, `LoaderResult`, `WebVttCue`, `ParsedWebVttSegment`, `SubtitleSampleIn`, `SubtitleStreamIn`.

## What works

**Outputs.** Default `--output=ts-canonical` produces a canonical MPEG-TS regardless of source container — passthrough for MPEG-TS, demux-and-remux for fMP4 / CMAF. Other modes: `--output=ts` (raw passthrough), `--output=es-audio` (AAC / MP3 / AC-3 elementary stream from MPEG-TS sources), `--output=es-video` (H.264 Annex-B from MPEG-TS sources).

**ABR.** On by default for master playlists. EWMA bandwidth estimator (dual fast / slow with pessimistic min), two-pass level selection with starvation tolerance, and **mid-fragment abandon** — the headline slow-network feature, aborts an in-flight segment and re-issues at a lower level if it won't finish before the buffer empties. `--abr-preset=unstable` tightens EWMA half-lives for bad mobile networks; `--cap-bitrate=N` caps the ladder; `--quality=` disables ABR for fixed-variant playback.

**Live streams.** Live-edge-aware buffer model: ABR sees `max(0, liveSyncTarget − lagBehindLive)` so down-switches fire when we fall behind, not a wall-clock estimate. `--live-start=N` (default 6) controls initial head-room; `--live-sync` and `--live-max-lag` tune the targets; `--skip-on-stall` jumps the cursor to the live edge when the lag ceiling is exceeded. Playlist refreshes naturally; exits on `EXT-X-ENDLIST`.

**Multi-language audio.** Two paths, usable together:
- **Inline-mux** (default when the master has audio renditions): every requested language is muxed into one TS with stable PIDs (`0x101`, `0x102`, …), PES interleaved by DTS, one PMT announcing video + N audio streams. `--inline-audio=<list>` for a subset; `--no-inline-audio` to disable.
- **Per-file** (`--audio=<langs>`): one `.aac` file per language in `--audio-out-dir`. Runs in parallel with the main video pipeline.
- A **channel filter** skips AUDIO groups whose renditions are entirely mono when a stereo+ option exists; `--allow-mono-audio` opts back in. **Auto group-selection**; `--audio-group=<id>` to pin.
- The per-file path **follows video ABR across AUDIO groups** — when video crosses a variant with a different `AUDIO="<group-id>"`, each per-language extractor swaps to the rendition in the new group mid-stream and re-anchors by cumulative EXTINF. Inline-mux stays on the initial group for the session (mid-stream codec-config changes in one PMT confuse most decoders).
- **De-dup**: when `--inline-audio=eng` and `--audio=eng,fra` are both set, `eng` isn't fetched twice — the per-file coordinator excludes already-inlined languages.
- **Format-agnostic**: raw-ADTS audio (with the Apple `com.apple.streaming.transportStreamTimestamp` ID3 PRIV anchor used as the segment-start PTS), MPEG-TS audio, and fMP4 / CMAF audio renditions all work.

**Multi-language subtitles (inline-mux only).** WebVTT subtitle renditions are carried inline in the canonical TS — one private-data PID per language. The wire format is opaque to the routing layer (SRT / RIST carry the PIDs transparently); what the consumer does with the cues at the egress is its choice.
- **Wire format.** Each subtitle PID has `stream_type = 0x06` (PES_PRIVATE) and carries PES packets with `stream_id = 0xBD` (private_stream_1). One PES per WebVTT cue. The PES payload is the cue block bytes verbatim — `00:00:01.500 --> 00:00:04.000\ncue text\n`, UTF-8. PTS is the absolute cue start in 90 kHz units, computed from the segment's `X-TIMESTAMP-MAP` (with PDT-derived fallback). PMT advertises each PID with an ISO 639 language descriptor (when the source declared `LANGUAGE=`) plus a `registration_descriptor` (tag 0x05) carrying 4CC `"VTT "`, so any downstream consumer can identify the carriage convention without out-of-band signalling.
- **PID assignment.** PIDs increment from `DEFAULT_SUBTITLE_PID_BASE = 0x110` in user-list order. `--inline-subtitles=eng,nor` lands eng at 0x110 and nor at 0x111. `--inline-subtitles=all` follows master-playlist order.
- **Group selection.** Mirror of inline-audio: filter renditions by language or NAME (case-insensitive), then pick the SUBTITLES `GROUP-ID` covering the most requested languages. Tie-break prefers the group the start variant advertises. Within the chosen group, multiple renditions for the same language dedupe by `DEFAULT=YES`.
- **Cross-variant group following.** When video ABR crosses a variant with a different `SUBTITLES="<group-id>"`, each per-language subtitle extractor swaps to the rendition in the new group and re-anchors by cumulative EXTINF — same machinery as the per-file audio coordinator.
- **Carryover dedup.** HLS WebVTT encoders include in-progress cues in every segment they overlap (so mid-stream joiners don't miss them). The rendition extractor maintains a `lastEmittedPts` watermark so each cue lands downstream exactly once; the watermark resets at `EXT-X-DISCONTINUITY` so post-discontinuity cues with lower MPEGTS PTS aren't dropped, and on seek + rendition swap for the same reason.
- **Live + skip-on-stall.** When `--skip-on-stall` fires, the subtitle coordinator's `skipToLive()` jumps each rendition extractor's cursor to live-edge minus `liveStartOffsetSegments`, flushes the per-language cue buffers, and resets the dedup watermark — without this, late-arriving subtitle segments would emit cues with PTS far behind the new video PTS.

**Source containers.** MPEG-TS native; fMP4 / CMAF demuxed sample-by-sample (moov / moof / traf / trun walked, mdat sliced). Length-prefixed NAL units are converted to Annex-B with SPS/PPS prepended on keyframes. Negative composition-time offsets (B-frame priming, common in CMAF) are handled by shifting PTS forward by `max(0, max(dts − pts))` so PTS ≥ DTS holds in the TS output.

**ABR variant switches.** PMT/PAT `version_number` is bumped and the AF `discontinuity_indicator` is set on the first video packet of the new segment — decoders re-initialize SPS/PPS without disturbing the audio decoder. Continuity counters stay monotonic across segments (one muxer instance reused for the stream lifetime).

**Cross-variant alignment.** `--align=auto` (default): cumulative-EXTINF for VOD, mediaSequence for live. When ABR switches variants the cursor is re-anchored to the segment whose `[startTimeSec, startTimeSec + duration)` brackets the current playhead — a no-op for aligned variants, load-bearing for non-aligned ones (durations drifting mid-playlist). Public helper `findSegmentAtTime(playlist, mediaTime)` exposed.

**Encryption.** AES-128 full-segment decryption with explicit `IV=0x...` or mediaSequence-derived IV per RFC 8216. Uses Node WebCrypto for AES-CBC + PKCS#7 (no JS AES port). Concurrent key fetches dedupe via `KeyCache`. SAMPLE-AES rejected with a clear error.

**Output pipeline.** `StdoutSink` has an optional bounded smoothing queue (10 MB default when stdout is a pipe) that decouples bursty per-segment writes from the consumer — without it, players like ffplay drain their internal packet queues during the inter-segment gap and stutter. Back-pressure honored when the queue fills. Graceful `SIGINT` / `SIGTERM` / `EPIPE`.

**Other.** Byte-range segments (`EXT-X-BYTERANGE`); `EXT-X-MAP` init sections re-emitted on variant change; HTTP retry with exponential backoff on 5xx / network errors; `--verbose` logs ABR decisions to stderr. Public library API mirrors the CLI surface — see [src/index.ts](src/index.ts).

## Buffer model

The "buffer" ABR consults is the constraint it's trying to defend against. For an in-browser player, that's `SourceBuffer.buffered.end − currentTime` — seconds until the playhead runs out of data. We don't have a playhead, so the analog has to be reconstructed:

- **VOD streams**: there is no rebuffer concept. Extraction completes whenever the network allows. ABR sees a generous fixed budget (default 30s) so `findBestLevel` falls through to a pure bandwidth-vs-bitrate decision.
- **Live streams**: the constraint that *actually* matters is "how far behind the live edge are we?" The `LatencyController` tracks `liveTipSeq` from each playlist reload, extrapolates wall-clock between reloads, and exposes `bufferForAbrSec = max(0, liveSyncTarget − lagBehindLive)`. As the network slows and lag grows, the ABR-visible buffer shrinks, triggering down-switches — and if `--skip-on-stall` is set, eventually a cursor jump toward live.

An earlier iteration used `mediaSecondsWritten − wallClockElapsed` from `StdoutSink`. That was wrong for instant-drain consumers (file writes, `head -c`, fast pipes) where the buffer grew unbounded and ABR ignored network signals; the live-edge-aware model replaces it.

## ABR presets

`--abr-preset=default` and `--abr-preset=unstable` (exported as `DEFAULT_ABR_CONFIG` / `UNSTABLE_NETWORK_ABR_CONFIG` from [src/abr/abr-controller.ts](src/abr/abr-controller.ts)) differ on six knobs:

| Knob | default | unstable | Role |
|---|---|---|---|
| `ewmaSlowSec` | 9 | 4 | Slow EWMA half-life (s) — long-window bandwidth baseline. |
| `ewmaFastSec` | 3 | 2 | Fast EWMA half-life (s) — recent-sample reactivity. |
| `defaultEstimateBps` | 500 000 | 250 000 | Cold-start bandwidth guess before any samples land. |
| `bwFactor` | 0.95 | 0.80 | Safety margin used when staying or down-switching. |
| `bwUpFactor` | 0.70 | 0.60 | Stricter margin for up-switching. |
| `maxStarvationDelaySec` | 4 | 2 | Seconds of projected starvation tolerated while picking a level. |

How those flow into the controller (see [src/abr/abr-controller.ts](src/abr/abr-controller.ts) and the call sites in [src/stream/extractor.ts:453](src/stream/extractor.ts#L453) / [src/stream/extractor.ts:1067](src/stream/extractor.ts#L1067)):

1. **Bandwidth estimate.** The EWMA estimator keeps two exponential averages and reports `min(fast, slow)` (pessimistic). Shorter half-lives in `unstable` make the estimate react faster to a sudden drop — fewer in-flight bytes before the controller "sees" the dip. Trade-off: more jitter and more switching on a steady pipe.
2. **Cold start.** Until samples accrue, the estimator returns `defaultEstimateBps`. `unstable` starts at 250 kbps so the first level pick lands lower, avoiding an immediate abandon on a flaky connection.
3. **Level selection (`findBestLevel`, port of hls.js).** The chosen level must satisfy `level.bitrate ≤ estimate × factor`, where `factor = bwUpFactor` on an up-switch and `bwFactor` otherwise. `unstable`'s 0.80 / 0.60 leaves more head-room — the picked level uses less of the estimated pipe, so a slow tick doesn't immediately starve the buffer.
4. **Starvation tolerance.** `maxStarvationDelaySec` is how much projected starvation `findBestLevel` will accept while walking the ladder. Cutting it from 4 s to 2 s makes the search drop a rung sooner the moment `bufferAheadSec` (fed by `LatencyController.bufferForAbrSec()`) shrinks.
5. **Mid-fragment abandon.** Same estimate + factors feed `shouldAbandon` on every progress tick, so `unstable` also abandons earlier and at a lower target level.

Net effect: `unstable` is twitchier, more conservative, and quicker to bail — appropriate for lossy mobile, counter-productive on steady fat pipes (more spurious down-switches). For finer tuning than the two presets offer, pass a `Partial<AbrConfig>` via the library API's `abr:` option to override individual fields.

## What doesn't work yet

- **`--output=es-audio` and `--output=es-video` still require MPEG-TS source.** For fMP4 sources, use `--output=ts-canonical` (re-muxes video to TS) or `--audio=<langs>` (writes per-language ADTS files).
- **`--inline-audio` matches by mediaSequence.** Audio + video renditions are assumed to share segmentation; for streams that don't, the first segment(s) may emit video-only until alignment is restored.
- **`--inline-audio` does NOT follow video ABR groups.** It uses the initial group for the entire session. The per-file audio coordinator (via `--audio=`) DOES follow ABR; if you need that for a single language too, use the per-file path. The reason inline-mux holds the group steady: re-initializing an audio decoder mid-stream produces an audible click (same mechanism we mitigate elsewhere by keeping the AF `discontinuity_indicator` off the audio PIDs at variant switches). The channel filter already biases the initial group toward stereo+, so users aren't trapped on a mono group.
- **`--output=ts-canonical` only supports H.264 video** (`avc1` / `avc3` sample entries). HEVC support is tracked in Future improvements.
- **No SAMPLE-AES.** Full-segment AES-128 works; per-NAL SAMPLE-AES needs the codec parsers in Future improvements.
- **No PTS-explicit audio sync between renditions in the per-file (`--audio=<langs>`) output path.** Each language is emitted as a separate ADTS file with no PTS-metadata sidecar; downstream consumers that recombine the files rely on the source being time-aligned. For every stream tested so far this just works because the encoder aligns them. The inline-mux path (`--inline-audio=`) doesn't have this caveat — every language is muxed into one TS with a shared PTS timebase.
- **Live + non-aligned variants is not yet handled.** For live sources, alignment defaults to `mediaSequence` (cumulative EXTINF is unstable across sliding-window reloads). If a live stream's variants drift, PDT-based alignment is needed — tracked in Future improvements.
- **Audio leads video by ≤ ~80 ms when the source uses negative composition offsets.** The fmp4 video extractor shifts all video PTS forward by `max(0, max(dts − pts))` so PTS ≥ DTS holds in MPEG-TS output; we mirror the same shift onto audio so AV stays in lockstep, but the absolute timeline of audio relative to video's *original* presentation time is offset by the shift. Bounded by the source's B-frame priming (typically 1–2 frames). Within sync-perception tolerance — no resync clicks.
- **EXT-X-DISCONTINUITY in the source playlist resets continuity counters but doesn't set the TS-level discontinuity indicator.** Decoders may log CC errors when an upstream stream actually exercises this (rare — most production HLS streams are continuous). Cheap fix: also call `inlineAvMuxer.signalDiscontinuity()` when `segment.discontinuity` is true.
- **Audio-track switching in ffplay (`a` key) jumps the timeline forward by ~1 s.** This is ffplay's read-ahead behaviour on pipe input: it accumulates ≥ 25 packets / ≥ 1 s of media per audio PID and the new decoder starts at the queue front, not at the current playback position. Not a hls-pipe bug; mpv handles the same input cleanly.
- **`--inline-subtitles` supports plain WebVTT segments only.** HLS subtitle tracks delivered as raw `.vtt` text (the overwhelmingly common case) work. fMP4-wrapped WebVTT (CMAF subtitle tracks with `wvtt` sample entries) is not yet demuxed and would error on the first segment. TTML / IMSC / EBU-TT-D are out of scope for now; the source is already WebVTT and re-encoding into another text-subtitle format is wasted work that the consumer can do downstream if needed.
- **`--inline-subtitles` does NOT carry cue duration as a separate field.** Each PES embeds the timing line (`start --> end`) inside the WebVTT cue block payload — downstream consumers parse it back. Standard WebVTT-aware tools work directly; consumers that expect a fixed-duration metadata frame format (CEA-style) need a small adapter.
- **`--inline-subtitles` + live + non-aligned variants with subtitle-group ABR swaps is untested.** The cross-group swap re-anchors by cumulative EXTINF, which the README already calls out as unstable on live sliding-window playlists for audio. Same caveat applies to subtitles; PDT-based alignment is tracked in Future improvements (would fix both at once).

## Future improvements

Items below are tracked but deferred — useful but not load-bearing for the project's stated goals (multi-language audio extraction over slow networks). Re-prioritize when a real stream demands them or the use case shifts.

- **LL-HLS partials** — `EXT-X-PART`, `EXT-X-PRELOAD-HINT`, `EXT-X-RENDITION-REPORT` for sub-target-duration latency on live streams. Today live latency is bounded by `targetDuration`; LL-HLS gets it under one second.
- **ExpGolomb + H.264 SPS/PPS parsing**: codec params, dimensions, frame rate from the bitstream itself. Today we get these from the master playlist's `RESOLUTION`/`FRAME-RATE`/`CODECS` attributes, which is sufficient for everything currently shipping. Bitstream-derived values become useful only if (a) a master playlist lies or is missing these attributes, or (b) SAMPLE-AES needs precise NAL RBSP parsing.
- **HEVC (H.265) parser**: same shape as the AVC parser plus VPS/SPS/PPS + SEI. Most production HLS is still H.264; HEVC blocks fewer real streams than expected.
- **Emulation-prevention byte stripping** — only matters once we read inside NAL RBSP (SPS/PPS bit fields). Current keyframe detection only reads the header byte which is never affected.
- **AAC ADTS frame validation + MP3 / AC-3 frame parsing + ID3 timed metadata**: structured per-frame audio samples with explicit sample-rate / channel-count / profile. Today the PES audio payload is already on-wire AAC/MP3/AC-3 and directly playable, so frame-level parsing is mostly cosmetic. Becomes load-bearing for tight remuxing or SAMPLE-AES audio.
- **SAMPLE-AES per-NAL / per-frame decryption**: depends on NAL framing (shipped) + ADTS framing (above). Unlocks the SAMPLE-AES error path. SAMPLE-AES is rare in modern HLS — most encrypted streams use AES-128 (already supported) or full DRM via CMAF/CENC (out of scope).
- **PDT-based variant alignment for live**: cumulative EXTINF handles VOD non-alignment but is unstable for live sliding-window playlists. If a live stream with non-aligned variants is encountered, port a PROGRAM-DATE-TIME-based aligner that consumes the `Segment.programDateTime` field (already parsed).
- **Sniff-before-open for audio rendition sinks** — currently FileSink opens before format detection. When `UnsupportedAudioFormatError` fires (fMP4), we leave 0-byte sink files behind. Move the detect step before the sink open.
- **First-auto-level probe** — port hls.js's `firstAutoLevel` / bitrate-test so ABR doesn't stay at lowest for one segment on cold start with no buffer headroom.
- **EXT-X-DATERANGE / SCTE-35** — probably not needed for extraction use case; evaluate when a stream requires it.
- **EXT-X-DEFINE variable substitution** — niche but real (some CDNs use it for cache-busting tokens).

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution to hls.js.

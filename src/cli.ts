#!/usr/bin/env node
/*
 * hls-pipe — command-line entrypoint
 *
 *   hls-pipe <hls-url> [options]
 *
 * Writes MPEG-TS segment bytes to stdout in order. Status / log lines go to
 * stderr so a downstream `ffmpeg -i pipe:0 ...` is unbothered.
 *
 * Examples:
 *   hls-pipe https://example.com/master.m3u8 | ffplay -
 *   hls-pipe URL --quality=lowest | ffmpeg -i pipe:0 -c copy out.ts
 *   hls-pipe URL --abr-preset=unstable --cap-bitrate=1000000 -v
 */

import { Extractor } from './stream/extractor.js';
import { StdoutSink } from './output/stdout-sink.js';
import type { QualityHint } from './stream/variant-selector.js';
import {
  DEFAULT_ABR_CONFIG,
  UNSTABLE_NETWORK_ABR_CONFIG,
  type AbrConfig,
} from './abr/abr-controller.js';
import type { LatencyConfig } from './stream/latency-controller.js';
import { makeOutputMode, type OutputModeId } from './output/output-mode.js';
import type { AudioLanguageSelection } from './stream/audio-coordinator.js';
import type { SubtitleLanguageSelection } from './stream/subtitle-coordinator.js';

interface ParsedArgs {
  url: string;
  /** If set, ABR is disabled and this hint chooses one variant. */
  fixedQuality: QualityHint | undefined;
  abrConfig: Partial<AbrConfig>;
  latencyConfig: Partial<LatencyConfig>;
  liveStartOffsetSegments: number | undefined;
  outputMode: OutputModeId;
  audioSelection: AudioLanguageSelection | undefined;
  audioOutDir: string | undefined;
  audioPreferredGroup: string | undefined;
  alignment: 'auto' | 'mediaSequence' | 'cumulative' | undefined;
  inlineAudioLanguages: 'all' | string[] | undefined;
  inlineSubtitleLanguages: SubtitleLanguageSelection | undefined;
  allowMonoAudio: boolean;
  /** Initial cumulative media time (seconds). VOD only; ignored on live. */
  startTimeSec: number | undefined;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 2 : 0);
  }

  let url: string | undefined;
  let fixedQuality: QualityHint | undefined;
  let abrConfig: Partial<AbrConfig> = {};
  let latencyConfig: Partial<LatencyConfig> = {};
  let liveStartOffsetSegments: number | undefined;
  let outputMode: OutputModeId = 'ts-canonical';
  let audioSelection: AudioLanguageSelection | undefined;
  let audioOutDir: string | undefined;
  let audioPreferredGroup: string | undefined;
  let alignment: 'auto' | 'mediaSequence' | 'cumulative' | undefined;
  let inlineAudioLanguages: 'all' | string[] | undefined;
  let inlineAudioExplicit = false;
  let disableInlineAudio = false;
  let inlineSubtitleLanguages: SubtitleLanguageSelection | undefined;
  let allowMonoAudio = false;
  let startTimeSec: number | undefined;
  let verbose = false;

  for (const arg of args) {
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg.startsWith('--quality=')) {
      fixedQuality = parseQuality(arg.slice('--quality='.length));
    } else if (arg.startsWith('--abr-preset=')) {
      abrConfig = { ...abrConfig, ...parseAbrPreset(arg.slice('--abr-preset='.length)) };
    } else if (arg.startsWith('--cap-bitrate=')) {
      const n = parseInt(arg.slice('--cap-bitrate='.length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`error: invalid --cap-bitrate=${arg}\n`);
        process.exit(2);
      }
      abrConfig.capBitrate = n;
    } else if (arg.startsWith('--live-sync=')) {
      const n = parseFloat(arg.slice('--live-sync='.length));
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`error: invalid --live-sync=${arg}\n`);
        process.exit(2);
      }
      latencyConfig.liveSyncTargetSec = n;
    } else if (arg.startsWith('--live-max-lag=')) {
      const n = parseFloat(arg.slice('--live-max-lag='.length));
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`error: invalid --live-max-lag=${arg}\n`);
        process.exit(2);
      }
      latencyConfig.liveMaxLatencySec = n;
    } else if (arg === '--skip-on-stall') {
      latencyConfig.skipOnStall = true;
    } else if (arg.startsWith('--output=')) {
      const v = arg.slice('--output='.length);
      if (v !== 'ts' && v !== 'es-audio' && v !== 'es-video' && v !== 'ts-canonical') {
        process.stderr.write(
          `error: invalid --output=${v} (expected: ts | es-audio | es-video | ts-canonical)\n`,
        );
        process.exit(2);
      }
      outputMode = v;
    } else if (arg.startsWith('--audio=')) {
      const v = arg.slice('--audio='.length).trim();
      if (v === 'all') {
        audioSelection = 'all';
      } else if (v.length === 0) {
        process.stderr.write(`error: --audio= requires a comma-separated language list or "all"\n`);
        process.exit(2);
      } else {
        audioSelection = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }
    } else if (arg.startsWith('--audio-out-dir=')) {
      audioOutDir = arg.slice('--audio-out-dir='.length);
    } else if (arg.startsWith('--audio-group=')) {
      audioPreferredGroup = arg.slice('--audio-group='.length);
    } else if (arg.startsWith('--inline-audio=')) {
      const v = arg.slice('--inline-audio='.length).trim();
      if (v === 'all') {
        inlineAudioLanguages = 'all';
        inlineAudioExplicit = true;
      } else if (v.length === 0) {
        process.stderr.write(
          `error: --inline-audio= requires a comma-separated language list or "all"\n`,
        );
        process.exit(2);
      } else {
        inlineAudioLanguages = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        inlineAudioExplicit = true;
      }
    } else if (arg === '--no-inline-audio') {
      disableInlineAudio = true;
    } else if (arg.startsWith('--inline-subtitles=')) {
      const v = arg.slice('--inline-subtitles='.length).trim();
      if (v === 'all') {
        inlineSubtitleLanguages = 'all';
      } else if (v.length === 0) {
        process.stderr.write(
          `error: --inline-subtitles= requires a comma-separated language list or "all"\n`,
        );
        process.exit(2);
      } else {
        inlineSubtitleLanguages = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }
    } else if (arg === '--allow-mono-audio') {
      allowMonoAudio = true;
    } else if (arg.startsWith('--align=')) {
      const v = arg.slice('--align='.length);
      if (v !== 'auto' && v !== 'mediaSequence' && v !== 'cumulative') {
        process.stderr.write(
          `error: invalid --align=${v} (expected: auto | mediaSequence | cumulative)\n`,
        );
        process.exit(2);
      }
      alignment = v;
    } else if (arg.startsWith('--live-start=')) {
      const n = parseInt(arg.slice('--live-start='.length), 10);
      if (Number.isFinite(n) && n >= 0) liveStartOffsetSegments = n;
    } else if (arg.startsWith('--seek=')) {
      const n = parseFloat(arg.slice('--seek='.length));
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`error: invalid --seek=${arg} (expected non-negative seconds)\n`);
        process.exit(2);
      }
      startTimeSec = n;
    } else if (!arg.startsWith('-')) {
      if (url) {
        process.stderr.write(`error: multiple URLs given\n`);
        process.exit(2);
      }
      url = arg;
    } else {
      process.stderr.write(`error: unknown option: ${arg}\n`);
      process.exit(2);
    }
  }

  if (!url) {
    printUsage();
    process.exit(2);
  }
  if (audioSelection && !audioOutDir) {
    process.stderr.write(`error: --audio requires --audio-out-dir=<path>\n`);
    process.exit(2);
  }
  if (inlineAudioLanguages && outputMode !== 'ts-canonical') {
    process.stderr.write(`error: --inline-audio requires --output=ts-canonical\n`);
    process.exit(2);
  }
  if (inlineSubtitleLanguages && outputMode !== 'ts-canonical') {
    process.stderr.write(`error: --inline-subtitles requires --output=ts-canonical\n`);
    process.exit(2);
  }
  // Default behavior: with ts-canonical output and no explicit --inline-audio
  // or --no-inline-audio, inline-mux ALL audio renditions (subject to the
  // channel filter). Users get one multi-stream TS by default.
  if (
    outputMode === 'ts-canonical' &&
    !inlineAudioExplicit &&
    !disableInlineAudio &&
    inlineAudioLanguages === undefined
  ) {
    inlineAudioLanguages = 'all';
  }
  if (disableInlineAudio) {
    inlineAudioLanguages = undefined;
  }
  return {
    url,
    fixedQuality,
    abrConfig,
    latencyConfig,
    liveStartOffsetSegments,
    outputMode,
    audioSelection,
    audioOutDir,
    audioPreferredGroup,
    alignment,
    inlineAudioLanguages,
    inlineSubtitleLanguages,
    allowMonoAudio,
    startTimeSec,
    verbose,
  };
}

function parseQuality(s: string): QualityHint {
  if (s === 'highest' || s === 'lowest') return { kind: s };
  if (s.startsWith('index:')) {
    const n = parseInt(s.slice('index:'.length), 10);
    if (!Number.isFinite(n)) throw new Error(`invalid --quality=index:${s}`);
    return { kind: 'index', index: n };
  }
  if (s.startsWith('maxBitrate:')) {
    const n = parseInt(s.slice('maxBitrate:'.length), 10);
    if (!Number.isFinite(n)) throw new Error(`invalid --quality=maxBitrate:${s}`);
    return { kind: 'maxBitrate', bitrate: n };
  }
  throw new Error(`invalid --quality=${s}`);
}

function parseAbrPreset(s: string): Partial<AbrConfig> {
  switch (s) {
    case 'default':
      return { ...DEFAULT_ABR_CONFIG };
    case 'unstable':
      return { ...UNSTABLE_NETWORK_ABR_CONFIG };
    default:
      process.stderr.write(`error: unknown --abr-preset=${s} (try: default|unstable)\n`);
      process.exit(2);
  }
}

function printUsage(): void {
  const msg = [
    'hls-pipe — pipe HLS streams to stdout',
    '',
    'usage: hls-pipe <hls-url> [options]',
    '',
    'options:',
    '  --quality=<spec>      disable ABR; pick one variant statically',
    '                        highest | lowest | index:N | maxBitrate:N',
    '  --abr-preset=<name>   ABR tuning: default | unstable',
    '                        (default: default; unstable: tighter EWMA, lower margin)',
    '  --cap-bitrate=N       maximum variant bitrate ABR may choose (bits/s)',
    '  --live-start=N        start N segments before live edge (default: 6)',
    '  --live-sync=N         target latency from live edge in seconds',
    '                        (default: 2 × targetDuration, auto-tuned)',
    '  --live-max-lag=N      max tolerated live-edge lag (default: 30)',
    '  --skip-on-stall       jump cursor to live edge when --live-max-lag is exceeded',
    '                        (off by default; introduces visible jumps)',
    '  --output=<mode>       output transform: ts-canonical (default) | ts | es-audio | es-video',
    '                        (ts-canonical: emit canonical MPEG-TS regardless of',
    '                         source — fMP4 sources are demuxed + re-muxed. By',
    '                         default ALL audio languages are multiplexed inline;',
    '                         use --no-inline-audio or --inline-audio=<list> to override.)',
    '                        (ts: passthrough — segment bytes go to stdout unchanged.',
    '                         Audio handling is consumer-side.)',
    '                        (es-audio: demux MPEG-TS, emit AAC/MP3/AC-3 elementary',
    '                         stream; pipe to "ffmpeg -f aac -i -")',
    '                        (es-video: demux MPEG-TS, emit H.264/HEVC Annex-B',
    '                         stream; pipe to "ffmpeg -f h264 -i -")',
    '  --audio=<langs>       extract alternate audio renditions in parallel',
    '                        Comma-separated LANGUAGE codes (e.g., eng,fra,nor) or "all"',
    '                        Each rendition writes to its own file in --audio-out-dir',
    '  --audio-out-dir=<p>   directory for per-language audio files (required with --audio)',
    '  --audio-group=<id>    restrict to a specific AUDIO group-id (e.g., audio_hq)',
    '  --inline-audio=<spec> restrict the audio languages multiplexed inline (default: all)',
    '                        spec: comma-separated language codes / names or "all"',
    '                        e.g., --inline-audio=nor,eng,fra',
    '                        Audio streams appear in the PMT in the order given,',
    '                        first-listed at the lowest PID. Each gets an ISO 639',
    '                        language descriptor so ffprobe/mpv/VLC/browsers show',
    '                        and select tracks correctly.',
    '                        KNOWN ISSUE: ffplay\'s default audio selection picks',
    '                        the LAST tied audio stream (av_find_best_stream tie-',
    '                        break), not the first. To force the first listed,',
    '                        pass `-ast 0:a:0` to ffplay. Other players (mpv,',
    '                        VLC, browsers) honor language tags and aren\'t affected.',
    '                        Supports fMP4 and raw-ADTS (with ID3 PTS) audio renditions.',
    '  --no-inline-audio     disable inline audio multiplexing (video-only canonical TS)',
    '  --inline-subtitles=<spec>  multiplex subtitle renditions inline as private PIDs',
    '                        spec: comma-separated language codes / names or "all"',
    '                        e.g., --inline-subtitles=eng,nor',
    '                        Subtitle PIDs are stream_type 0x06 carrying WebVTT cue',
    '                        blocks (one cue per PES on private_stream_1, 0xBD).',
    '                        PMT tags each PID with an ISO 639 language descriptor',
    '                        and a registration_descriptor with 4CC \"VTT \".',
    '                        Requires --output=ts-canonical and a master playlist',
    '                        with EXT-X-MEDIA TYPE=SUBTITLES entries.',
    '  --allow-mono-audio    allow mono audio groups when picking the inline-audio',
    '                        source. Default: prefer stereo+ groups when present and',
    '                        fall back to mono only if no stereo+ group is available.',
    '  --align=<strategy>    cross-variant alignment on ABR switches',
    '                        auto (default) | mediaSequence | cumulative',
    '                        (auto = cumulative for VOD, mediaSequence for live)',
    '  --seek=N              set the initial playhead, in seconds (VOD only;',
    '                        ignored with a warning on live streams).',
    '                        Out-of-range values clamp to the last playable',
    '                        segment with a warning. The library exposes a',
    '                        runtime seek() too; the CLI is single-shot so',
    '                        this flag is the only entry point.',
    '  --verbose, -v         log ABR decisions and segment events to stderr',
    '  --help, -h            print this message',
    '',
    'behavior:',
    '  ABR is ON by default when the URL points to a master playlist.',
    '  Use --quality=... to disable it and pin one variant for the session.',
    '  Use --abr-preset=unstable on slow / lossy mobile connections.',
    '  For live streams on slow networks, --skip-on-stall lets the extractor',
    '  catch up to live by dropping segments instead of falling further behind.',
    '',
    'example:',
    '  hls-pipe https://example.com/master.m3u8 -v | ffplay -',
    '',
  ].join('\n');
  process.stderr.write(msg);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const abort = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    process.stderr.write(`hls-pipe: received ${sig}, aborting\n`);
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // If our consumer (e.g. ffmpeg) exits, stdout EPIPE fires; treat as clean exit.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    process.stderr.write(`hls-pipe: stdout error: ${err.message}\n`);
    process.exit(1);
  });

  // 10 MB smoothing queue when stdout is a pipe (e.g., piped to ffplay /
  // ffmpeg). For a TTY (rare for this CLI but possible during local debug),
  // skip buffering. CI / test paths can override via the constructor.
  const bufferLimitBytes = process.stdout.isTTY ? 0 : 10 * 1024 * 1024;
  const sink = new StdoutSink(process.stdout, { bufferLimitBytes });
  const extractor = new Extractor({
    url: args.url,
    sink,
    signal: abort.signal,
    ...(args.fixedQuality ? { fixedQuality: args.fixedQuality } : {}),
    ...(Object.keys(args.abrConfig).length ? { abr: args.abrConfig } : {}),
    ...(Object.keys(args.latencyConfig).length ? { latency: args.latencyConfig } : {}),
    ...(args.liveStartOffsetSegments !== undefined
      ? { liveStartOffsetSegments: args.liveStartOffsetSegments }
      : {}),
    ...(args.outputMode !== 'ts' ? { outputMode: makeOutputMode(args.outputMode) } : {}),
    ...(args.audioSelection ? { audioSelection: args.audioSelection } : {}),
    ...(args.audioOutDir ? { audioOutDir: args.audioOutDir } : {}),
    ...(args.audioPreferredGroup ? { audioPreferredGroup: args.audioPreferredGroup } : {}),
    ...(args.alignment ? { alignment: args.alignment } : {}),
    ...(args.inlineAudioLanguages ? { inlineAudioLanguages: args.inlineAudioLanguages } : {}),
    ...(args.inlineSubtitleLanguages
      ? { inlineSubtitleLanguages: args.inlineSubtitleLanguages }
      : {}),
    ...(args.allowMonoAudio ? { allowMonoAudio: true } : {}),
    ...(args.startTimeSec !== undefined ? { startTimeSec: args.startTimeSec } : {}),
    log: args.verbose ? (msg) => process.stderr.write(`hls-pipe: ${msg}\n`) : undefined,
  });

  try {
    await extractor.run();
    await sink.end();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      process.exit(130);
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hls-pipe: error: ${msg}\n`);
    process.exit(1);
  }
}

main();

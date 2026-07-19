/*
 * hls-pipe — extraction orchestrator (phase 3: live-edge aware buffer)
 *
 * Inspired by hls.js src/controller/stream-controller.ts. The shape mirrors
 * the upstream's per-segment loop but:
 *
 *   - the upstream pulls buffer state from MediaSource; we read it from the
 *     LatencyController, which models the meaningful constraint as
 *     "distance from the live edge" (live) or "no rebuffer concept" (VOD)
 *   - the upstream's level switching goes through a level-controller; we
 *     query the AbrController directly each iteration
 *   - mid-fragment abandon mirrors hls.js's _abandonRulesCheck: a progress
 *     callback periodically evaluates whether to abort the in-flight request
 *     and retry the same segment at a lower level
 *
 * Phase-3 changes from phase 2:
 *   - ABR's `bufferAheadSec` input now comes from LatencyController, not
 *     StdoutSink.bufferAheadSeconds() (which was wrong for instant-drain
 *     consumers — see src/stream/latency-controller.ts for the rationale)
 *   - playlist reloads feed LatencyController so live-edge tracking is live
 *   - optional skip-to-live behavior when lag exceeds liveMaxLatencySec
 *
 * Phase-2 assumption that still holds: variants have matching mediaSequence
 * numbers (HLS spec recommendation for related variants). Misaligned variants
 * are a phase-7 concern and would need PROGRAM-DATE-TIME or cumulative-duration
 * alignment instead.
 */

import {
  AbrController,
  DEFAULT_ABR_CONFIG,
  type AbrConfig,
  type LevelInfo,
} from '../abr/abr-controller.js';
import {
  findSegmentAtTime,
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  ParseError,
} from '../parser/m3u8-parser.js';
import type { Loader, LoaderRequest, MediaPlaylist, Segment, Variant } from '../types.js';
import { NodeLoader } from '../loader/node-loader.js';
import type { SegmentSink } from '../output/stdout-sink.js';
import { pickVariant, type QualityHint } from './variant-selector.js';
import { PlaylistCache } from './playlist-cache.js';
import { LatencyController, type LatencyConfig } from './latency-controller.js';
import { type OutputMode, TsPassthroughMode, TsCanonicalMode } from '../output/output-mode.js';
import { Fmp4AudioExtractor } from '../demux/fmp4/audio.js';
import { Fmp4VideoExtractor } from '../demux/fmp4/video.js';
import { extractAacFrames, framesFromAdts } from '../demux/raw-aac.js';
import { Demuxer } from '../demux/demuxer.js';
import { MpegTsMuxer, DEFAULT_AUDIO_PID, DEFAULT_SUBTITLE_PID_BASE, videoSpanSeconds } from '../mux/ts/muxer.js';
import { StreamType } from '../demux/pat-pmt.js';
import { detectByContent } from './audio-format.js';
import type { AlternateRendition } from '../types.js';
import { groupHasStereo, groupIsAllMono, renditionMaxChannels } from './rendition-filters.js';
import { AudioCoordinator, type AudioLanguageSelection } from './audio-coordinator.js';
import {
  SubtitleCoordinator,
  type SubtitleLanguageSelection,
  type SubtitleTrackBinding,
} from './subtitle-coordinator.js';
import type { WebVttCue } from '../parser/webvtt-parser.js';
import type { MasterPlaylist } from '../types.js';
import { KeyCache } from '../crypt/key-cache.js';
import { decryptAes128Cbc, deriveIv, UnsupportedKeyMethodError } from '../crypt/decrypter.js';

export interface ExtractorOptions {
  /** HLS URL — master playlist or media playlist. */
  url: string;
  /** Sink to receive segment bytes. */
  sink: SegmentSink;
  /** Loader instance (defaults to NodeLoader). */
  loader?: Loader;
  /**
   * If set, disables ABR — uses this static hint to pick one variant
   * and stays there. Default: ABR enabled when input is a master playlist.
   */
  fixedQuality?: QualityHint;
  /** ABR configuration overrides; ignored when fixedQuality is set. */
  abr?: Partial<AbrConfig>;
  /** Live-edge latency configuration. */
  latency?: Partial<LatencyConfig>;
  /**
   * If true, auto-tune liveSyncTargetSec to 2 × targetDuration once the first
   * live playlist is loaded. Caller-provided latency.liveSyncTargetSec wins
   * over the auto-tune when set explicitly.
   */
  autoTuneLiveSync?: boolean;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Optional logger; receives one-line status events. */
  log?: (msg: string) => void;
  /**
   * For live streams, how many segments back from the live edge to start.
   * Default 3 per HLS recommendation.
   */
  liveStartOffsetSegments?: number;
  /** Progress check interval (ms) for the mid-fragment abandon evaluator. */
  abandonCheckIntervalMs?: number;
  /**
   * Output transform applied to each segment's bytes before writing to the
   * sink. Defaults to TS passthrough. See src/output/output-mode.ts.
   */
  outputMode?: OutputMode;
  /**
   * If set, the extractor spawns an AudioCoordinator after bootstrap that
   * extracts the master playlist's alternate audio renditions matching this
   * selection. Requires `audioOutDir`. The main video / muxed-audio pipeline
   * continues on stdout in parallel. Phase-5 feature.
   */
  audioSelection?: AudioLanguageSelection;
  /** Required when audioSelection is set; directory for per-language output files. */
  audioOutDir?: string;
  /** Optional preferred AUDIO group-id (e.g., "audio_hq" for BCC). */
  audioPreferredGroup?: string;
  /**
   * Cross-variant alignment strategy for ABR switches.
   *
   *   'auto'           (default) — `cumulative` for VOD, `mediaSequence` for live
   *   'mediaSequence'  pre-7b.4 behavior; assumes variants share segment numbering
   *   'cumulative'     align by cumulative EXTINF time; handles non-aligned variants
   *                    (BCC stream-CDN VOD case)
   */
  alignment?: 'auto' | 'mediaSequence' | 'cumulative';
  /**
   * Phase 7b.3.2 + multi-language extension: one or more audio rendition
   * languages to multiplex inline with video in `--output=ts-canonical`.
   * Each language becomes its own audio PID in the resulting TS. Pass `'all'`
   * to include every audio language from the master playlist. Only fMP4
   * audio renditions are supported. Empty list / undefined means video-only TS.
   */
  inlineAudioLanguages?: 'all' | string[];
  /**
   * If true, mono audio renditions are allowed when selecting the inline-audio
   * group. Default: false (prefer stereo+ groups when both exist; falls back
   * to mono only if no stereo+ group is available for any selected language).
   */
  allowMonoAudio?: boolean;
  /**
   * One or more subtitle rendition languages to multiplex inline with video
   * in `--output=ts-canonical`. Each language becomes its own subtitle PID
   * (stream_type 0x06, stream_id 0xBD private_stream_1) carrying WebVTT cues
   * in their original cue-block form. The PMT marks each PID with an ISO-639
   * language descriptor and a registration_descriptor("VTT "). Pass `'all'`
   * to include every subtitle language from the master playlist. Empty list
   * / undefined means no subtitle PIDs.
   */
  inlineSubtitleLanguages?: SubtitleLanguageSelection;
  /**
   * Initial cumulative media time (seconds) to start at. **VOD only.** On
   * live streams a warning is logged and the value is ignored. Out-of-range
   * values are clamped to `[0, totalDuration − lastSegmentDuration]` with a
   * warning. Equivalent of seek(timeSec) applied before the first segment.
   */
  startTimeSec?: number;
}

interface ExtractorState {
  /** Variant list, bitrate-ascending; index aligns with AbrController levels. */
  variants: Variant[];
  /** Level info derived from variants (for the ABR controller). */
  levels: LevelInfo[];
  /** Per-variant media playlist cache. */
  cache: PlaylistCache;
  /** Currently selected level index. */
  currentLevelIdx: number;
  /** Next media sequence number to fetch. */
  cursorMediaSequence: number;
  /**
   * Cumulative media time consumed (seconds, summed from segment.duration).
   * Used by 'cumulative' alignment to re-anchor `cursorMediaSequence` after
   * an ABR variant switch in VOD playlists with non-aligned variants.
   */
  playheadSec: number;
  /** True if any variant's playlist is live (no EXT-X-ENDLIST). */
  isLive: boolean;
  /**
   * URI of the most recently emitted EXT-X-MAP init section, or undefined
   * if none has been emitted yet. We re-emit whenever the upcoming segment
   * references a different init URI — necessary for fMP4 ABR where each
   * variant has its own init segment (different codec params / sample
   * entries / track IDs).
   */
  lastEmittedInitUri: string | undefined;
  /** Master playlist parse result (if input was a master); used to spawn the audio coordinator. */
  master: MasterPlaylist | undefined;
  /** Resolved alignment strategy (after 'auto' is unwrapped at bootstrap). */
  alignment: 'mediaSequence' | 'cumulative';
  /** Level index used on the previous loop iteration — detects switches. */
  previousLevelIdx: number;
  /**
   * Inline-audio contexts (phase 7b.3.2 + multi-language extension). One per
   * audio language to multiplex inline with video. Each gets its own TS PID
   * (assigned at bootstrap). Empty when no inline audio is configured.
   */
  inlineAudios: InlineAudioContext[];
  /**
   * Inline-subtitle contexts. One per subtitle language. Each owns its TS
   * subtitle PID (assigned at bootstrap from DEFAULT_SUBTITLE_PID_BASE) and
   * a per-language cue buffer that the SubtitleCoordinator's rendition
   * extractors append to. The main loop's `muxInlineAv` drains the buffers
   * each iteration.
   */
  inlineSubtitles: InlineSubtitleContext[];
  /**
   * Monotonic counter bumped by every successful `seek()` call. The main loop
   * snapshots this at iteration start; if it changes before the iteration's
   * post-write cursor advance, we skip the advance so the seek's cursor
   * update isn't clobbered by the in-flight pre-seek segment finishing.
   */
  seekEpoch: number;
}

interface InlineAudioContext {
  rendition: AlternateRendition;
  /** Audio rendition's media playlist, refreshed alongside live video. */
  playlist: MediaPlaylist;
  extractor: Fmp4AudioExtractor;
  /**
   * Lazy-allocated TS demuxer for MPEG-TS audio renditions (rare but real —
   * e.g. LongTail's audio group). One instance per language so PMT info
   * (audio PID, stream_type) carries across segments. Undefined until the
   * first TS audio segment is seen for this language.
   */
  tsDemuxer: Demuxer | undefined;
  /** URI of the most recent init segment loaded. */
  lastInitUri: string | undefined;
  /** Stable TS PID for this language in the canonical multi-stream TS. */
  pid: number;
  /** Display label used in log messages. */
  label: string;
  /**
   * Last audio PTS (in 90 kHz output ticks) emitted for this language, used
   * to anchor the next segment's first frame for perfect continuity. Without
   * this, a mid-stream bump of `Fmp4VideoExtractor.ptsShift` would leak into
   * audio as a sub-frame gap — AAC decoders render that as a click.
   */
  lastEmittedPts: number | undefined;
}

interface InlineSubtitleContext {
  rendition: AlternateRendition;
  /** Stable TS PID for this language in the canonical multi-stream TS. */
  pid: number;
  /** Display label used in log messages. */
  label: string;
  /** Stable language key (lowercased language or name). */
  langKey: string;
  /**
   * Cue buffer — appended to by `SubtitleCoordinator`'s rendition extractor
   * for this language, drained by `muxInlineAv` per video segment.
   * Cues are in append (and therefore PTS-ascending) order.
   */
  cueBuffer: WebVttCue[];
}

export class Extractor {
  private readonly opts: ExtractorOptions;
  private readonly loader: Loader;
  private readonly log: (msg: string) => void;
  private readonly abr: AbrController;
  private readonly latency: LatencyController;
  /** Whether ABR is consulting for level decisions (false = fixed). */
  private readonly abrEnabled: boolean;
  private readonly abandonCheckIntervalMs: number;
  /** True iff caller pinned liveSyncTargetSec explicitly. */
  private readonly liveSyncTargetPinned: boolean;
  private readonly outputMode: OutputMode;
  private readonly keyCache: KeyCache;
  /** Set when an audio coordinator is configured (phase 5 + phase 7.audio-abr). */
  private audioCoordinator: AudioCoordinator | undefined;
  /** Set when inline-subtitle muxing is configured. */
  private subtitleCoordinator: SubtitleCoordinator | undefined;
  /**
   * Stream-lifetime muxer for inline-AV output. Reused across segments so CC
   * counters and PCR continue cleanly — a fresh muxer per segment would cause
   * ffmpeg / ffplay to flag "Packet corrupt" at each segment boundary.
   */
  private readonly inlineAvMuxer = new MpegTsMuxer();

  /**
   * Pause gate awaited at the top of each main-loop (and audio-rendition) iteration.
   * Resolved by default; pause() replaces it with a pending promise, resume() resolves it.
   * In-flight segment fetches finish first — the pause takes effect between iterations.
   */
  private pauseGate: Promise<void> = Promise.resolve();
  private resumePause: (() => void) | undefined;
  private paused = false;
  /** Set after bootstrap; needed by seek() to guard against live, and to re-anchor. */
  private state: ExtractorState | undefined;

  constructor(opts: ExtractorOptions) {
    this.opts = opts;
    this.loader = opts.loader ?? new NodeLoader();
    this.log = opts.log ?? (() => undefined);
    this.abrEnabled = opts.fixedQuality === undefined;
    this.abr = new AbrController({ ...DEFAULT_ABR_CONFIG, ...(opts.abr ?? {}) });
    this.latency = new LatencyController(opts.latency ?? {});
    this.liveSyncTargetPinned = !!opts.latency?.liveSyncTargetSec;
    this.abandonCheckIntervalMs = opts.abandonCheckIntervalMs ?? 100;
    this.outputMode = opts.outputMode ?? new TsPassthroughMode();
    this.keyCache = new KeyCache(this.loader, opts.signal);
  }

  async run(): Promise<void> {
    const state = await this.bootstrap();
    this.state = state;
    this.log(
      `bootstrap: ${state.variants.length} variant(s), ABR=${this.abrEnabled ? 'on' : 'off'}, ${state.isLive ? 'LIVE' : 'VOD'}`,
    );

    // Phase-5: when an audio coordinator is configured, run it alongside the
    // main loop. Promise.allSettled lets one fail without leaking an unhandled
    // rejection while the other is still in flight; we then surface the first
    // non-abort error.
    const audio = this.maybeMakeAudioCoordinator(state);
    // Audio-ABR coupling (phase 7.audio-abr): make the coordinator available
    // to the main loop so it can notify on each ABR variant switch.
    this.audioCoordinator = audio;
    const subtitle = this.maybeMakeSubtitleCoordinator(state);
    this.subtitleCoordinator = subtitle;
    const tasks: Promise<void>[] = [this.runMainLoop(state)];
    if (audio) tasks.push(audio.run());
    if (subtitle) tasks.push(subtitle.run());

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        const err = r.reason;
        if (err instanceof Error && err.name === 'AbortError') continue;
        throw err;
      }
    }
  }

  // -- playback controls (phase 7c.playback) ---------------------------------

  /**
   * Pause the extraction loop. Idempotent. The currently in-flight segment
   * fetch (if any) completes and is written; the next iteration then awaits
   * the gate until `resume()` is called.
   *
   * Works on both VOD and live. On live, a long pause may exceed
   * `latency.liveMaxLatencySec` and the existing skip-to-live logic will
   * fast-forward to the live edge on resume (logged).
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pauseGate = new Promise<void>((res) => {
      this.resumePause = res;
    });
    this.log('pause requested — will hold after current segment');
  }

  /** Resume after a pause. Idempotent. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const res = this.resumePause;
    this.resumePause = undefined;
    this.pauseGate = Promise.resolve();
    if (res) res();
    this.log('resume requested');
  }

  /** True iff `pause()` has been called and `resume()` has not yet been called. */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Move the playhead to a given cumulative media time. **VOD only** — on
   * live streams a warning is logged and the call is a no-op (returns the
   * unchanged current playhead). Out-of-range values clamp to
   * `[0, totalDuration − lastSegmentDuration]` with a warning.
   *
   * Re-anchors:
   *   - main video cursor (`cursorMediaSequence`, `playheadSec`)
   *   - latency controller cursor
   *   - every inline-audio context's `lastEmittedPts` and `lastInitUri`
   *     (the per-context audio playlist follows video by mediaSequence, so
   *     no cursor needs explicit moving — only continuity state is reset)
   *   - per-file audio coordinator (forwards to every rendition extractor)
   *   - output mode + inline-AV muxer discontinuity flags
   *
   * Callers should pause before seeking and resume after:
   *   `extractor.pause(); await extractor.seek(t); extractor.resume();`
   * Seeking without pausing still works; up to one stale segment may be
   * written before the loop honors the new cursor.
   *
   * Returns the actual (possibly clamped) playhead position.
   */
  async seek(timeSec: number): Promise<number> {
    if (!this.state) {
      throw new Error('seek() called before run() has bootstrapped the stream');
    }
    const state = this.state;
    if (state.isLive) {
      this.log(`seek(${timeSec}s) ignored on live stream`);
      return state.playheadSec;
    }
    const variant = state.variants[state.currentLevelIdx]!;
    const playlist = await state.cache.get(variant);
    const clamped = clampStartTime(timeSec, playlist);
    if (clamped !== timeSec) {
      this.log(`seek: clamped ${timeSec}s → ${clamped}s (asset duration ${playlist.totalDuration.toFixed(2)}s)`);
    }
    const target = findSegmentAtTime(playlist, clamped);
    if (!target) {
      this.log(`seek(${clamped}s): no matching segment; no-op`);
      return state.playheadSec;
    }
    state.cursorMediaSequence = target.mediaSequence;
    state.playheadSec = target.startTimeSec;
    state.seekEpoch++;
    this.latency.setCursor(state.cursorMediaSequence);
    // Inline-audio: contexts follow video by mediaSequence each iteration; we
    // only need to break PTS continuity and drop init binding so a new init
    // is fetched if the audio rendition uses one.
    for (const ctx of state.inlineAudios) {
      ctx.lastEmittedPts = undefined;
      ctx.lastInitUri = undefined;
    }
    // Per-file audio coordinator: forward to every rendition extractor.
    if (this.audioCoordinator) await this.audioCoordinator.seek(clamped);
    // Inline-subtitle coordinator: forward, and drop buffered cues — they
    // belong to the pre-seek timeline and would emit at wrong positions
    // after the seek otherwise.
    for (const ctx of state.inlineSubtitles) ctx.cueBuffer.length = 0;
    if (this.subtitleCoordinator) await this.subtitleCoordinator.seek(clamped);
    // Discontinuity signaling — PTS will jump, decoders must reset.
    this.outputMode.resetContiguity?.();
    this.inlineAvMuxer.signalDiscontinuity();
    this.log(`seek → playhead=${state.playheadSec.toFixed(2)}s, seq=${state.cursorMediaSequence}`);
    return state.playheadSec;
  }

  private maybeMakeAudioCoordinator(state: ExtractorState): AudioCoordinator | undefined {
    if (!this.opts.audioSelection) return undefined;
    if (!this.opts.audioOutDir) {
      throw new Error('audioSelection requires audioOutDir');
    }
    if (!state.master) {
      this.log('audio-coordinator: input is a media playlist (no master); skipping');
      return undefined;
    }
    // De-dup: any language already being inline-muxed shouldn't ALSO go to
    // the per-file coordinator (we'd fetch the same rendition twice).
    let selection = this.opts.audioSelection;
    if (state.inlineAudios.length > 0 && Array.isArray(selection)) {
      const inlineLangs = new Set(
        state.inlineAudios.map((c) => (c.rendition.language ?? c.rendition.name).toLowerCase()),
      );
      const filtered = selection.filter((s) => !inlineLangs.has(s.toLowerCase()));
      if (filtered.length !== selection.length) {
        const dropped = selection.filter((s) => inlineLangs.has(s.toLowerCase()));
        this.log(
          `audio-coordinator: excluding ${dropped.join(',')} from per-file output (already inline-muxed)`,
        );
      }
      selection = filtered;
      if (selection.length === 0) {
        this.log('audio-coordinator: every requested language is inline-muxed; per-file coordinator disabled');
        return undefined;
      }
    }
    const coordOpts: ConstructorParameters<typeof AudioCoordinator>[0] = {
      master: state.master,
      selection,
      outDir: this.opts.audioOutDir,
      loader: this.loader,
    };
    if (this.opts.signal) coordOpts.signal = this.opts.signal;
    if (this.opts.log) coordOpts.log = this.opts.log;
    if (this.opts.liveStartOffsetSegments !== undefined) {
      coordOpts.liveStartOffsetSegments = this.opts.liveStartOffsetSegments;
    }
    if (this.opts.audioPreferredGroup) {
      coordOpts.preferredGroup = this.opts.audioPreferredGroup;
    }
    // Pass the initial variant's AUDIO group so the coordinator starts on
    // the group paired with the video bitrate we'll begin with.
    const initialGroup = state.variants[state.currentLevelIdx]!.audioGroup;
    if (initialGroup) coordOpts.initialGroup = initialGroup;
    // Pause is video+audio in lockstep — share the same gate.
    coordOpts.pauseGate = () => this.pauseGate;
    // VOD start-time: forward the same seed time the main loop is using.
    // For live, state.isLive is true and the rendition-extractor self-guards,
    // but skip the option entirely to keep the contract clean.
    if (!state.isLive && this.opts.startTimeSec !== undefined && this.opts.startTimeSec > 0) {
      coordOpts.initialPlayheadSec = state.playheadSec;
    }
    return new AudioCoordinator(coordOpts);
  }

  private async runMainLoop(state: ExtractorState): Promise<void> {
    while (true) {
      this.throwIfAborted();
      if (this.paused) await this.pauseGate;
      this.throwIfAborted();
      // Capture the seek epoch at iteration start. If seek() bumps it before
      // we reach the post-write cursor advance, the seek has retargeted
      // cursorMediaSequence/playheadSec — we must NOT advance over it.
      const iterationSeekEpoch = state.seekEpoch;

      // 1. Decide next level. Buffer signal comes from LatencyController
      //    (live-edge aware for live, generous constant for VOD).
      const bufferAhead = this.latency.bufferForAbrSec();
      const nextLevelIdx = this.abrEnabled
        ? this.abr.getNextLevel(state.currentLevelIdx, state.levels, bufferAhead)
        : state.currentLevelIdx;

      if (nextLevelIdx !== state.currentLevelIdx) {
        const lag = this.latency.lagBehindLiveSec();
        const lagPart = state.isLive ? `, lag=${lag.toFixed(1)}s` : '';
        this.log(
          `ABR switch: level ${state.currentLevelIdx} → ${nextLevelIdx} (${state.variants[nextLevelIdx]!.bitrate} bps, buffer=${bufferAhead.toFixed(1)}s${lagPart}, est=${Math.round(this.abr.getEstimate())} bps)`,
        );
        state.currentLevelIdx = nextLevelIdx;
        // Phase 7.audio-abr: tell the coordinator about the new variant so it
        // can follow into the matching AUDIO group.
        if (this.audioCoordinator) {
          this.audioCoordinator.onVideoVariantChange(state.variants[nextLevelIdx]!);
        }
        if (this.subtitleCoordinator) {
          this.subtitleCoordinator.onVideoVariantChange(state.variants[nextLevelIdx]!);
        }
        // Variant switches typically change SPS/PPS (and may change codec
        // profile, resolution, frame rate). Signal a TS-level discontinuity
        // so downstream decoders re-initialize — otherwise ffmpeg can try to
        // decode new-variant bytes against the old SPS and produce garbage
        // (e.g. "cabac decode of qscale diff failed" when profiles differ).
        this.inlineAvMuxer.signalDiscontinuity();
      }

      // 2. Resolve the playlist for that level and locate the segment.
      const variant = state.variants[state.currentLevelIdx]!;
      const playlist = await this.getPlaylist(state.cache, variant);

      // Re-anchor cursor on variant change when cumulative alignment is active.
      // For aligned variants this typically yields the same mediaSequence; for
      // misaligned variants (BCC stream-CDN VOD), this is the load-bearing fix.
      if (
        state.alignment === 'cumulative' &&
        state.currentLevelIdx !== state.previousLevelIdx
      ) {
        const aligned = findSegmentAtTime(playlist, state.playheadSec);
        if (aligned) {
          if (aligned.mediaSequence !== state.cursorMediaSequence) {
            this.log(
              `alignment: variant switch retargeted cursor seq=${state.cursorMediaSequence} → ${aligned.mediaSequence} (playhead=${state.playheadSec.toFixed(2)}s, segStart=${aligned.startTimeSec.toFixed(2)}s)`,
            );
            state.cursorMediaSequence = aligned.mediaSequence;
            this.latency.setCursor(aligned.mediaSequence);
          }
        }
        state.previousLevelIdx = state.currentLevelIdx;
      }

      // Skip-to-live if configured and we've fallen too far behind.
      if (state.isLive) {
        const liveOffset = this.opts.liveStartOffsetSegments ?? 6;
        const skipTo = this.latency.recommendedSkipTarget(liveOffset);
        if (skipTo !== undefined && skipTo > state.cursorMediaSequence) {
          const dropped = skipTo - state.cursorMediaSequence;
          this.log(
            `live: lag exceeded max (${this.latency.lagBehindLiveSec().toFixed(1)}s); skipping ${dropped} segment(s) to seq=${skipTo}`,
          );
          state.cursorMediaSequence = skipTo;
          this.latency.setCursor(skipTo);
          // Inline-subtitle: each rendition extractor runs independently with
          // its own cursor in its own playlist's media-sequence space — it
          // does NOT auto-follow video like inline-audio (which is looked up
          // per video segment by mediaSequence in `collectAudioFramesForSegment`).
          // Without this fan-out, the subtitle extractor would keep emitting
          // cues whose PTS is far behind the new video PTS after a stall-skip.
          // Also flush any cues already drained into per-language buffers —
          // those belong to the pre-skip timeline.
          if (this.subtitleCoordinator && state.inlineSubtitles.length > 0) {
            for (const ctx of state.inlineSubtitles) ctx.cueBuffer.length = 0;
            // Fire-and-forget: the coordinator awaits its own playlist
            // refresh internally. Keeping it non-blocking here matches the
            // main loop's existing pattern of synchronous cursor bumps.
            void this.subtitleCoordinator.skipToLive(liveOffset);
          }
        }
      }

      const segment = this.findSegment(playlist, state.cursorMediaSequence);
      if (!segment) {
        const live = !playlist.endList;
        state.isLive = state.isLive || live;
        if (!live) {
          this.log('reached end of stream');
          return;
        }
        const waitMs = Math.max(500, (playlist.targetDuration * 1000) / 2);
        this.log(`live: waiting ${Math.round(waitMs)}ms for new segments`);
        await delay(waitMs, this.opts.signal);
        const refreshed = await state.cache.refresh(variant);
        this.latency.onPlaylistUpdate(refreshed);
        continue;
      }

      // 3. Handle EXT-X-MAP when the upcoming segment's init URI differs
      //    from the last one we processed. Two paths:
      //      a) outputMode.setInit consumes the init bytes (e.g., ts-canonical
      //         demuxes them for re-muxing)
      //      b) outputMode.forwardInitSection writes the raw init bytes
      //         straight through to the sink (default ts mode for fMP4 ABR)
      //    Either or both may apply.
      if (
        segment.initSection &&
        segment.initSection.uri !== state.lastEmittedInitUri &&
        (this.outputMode.setInit !== undefined || this.outputMode.forwardInitSection)
      ) {
        const initBytes = await this.fetchInitBytes(segment.initSection);
        if (this.outputMode.setInit) this.outputMode.setInit(initBytes);
        if (this.outputMode.forwardInitSection) await this.opts.sink.write(initBytes, 0);
        state.lastEmittedInitUri = segment.initSection.uri;
      }

      if (segment.key && segment.key.method === 'SAMPLE-AES') {
        throw new UnsupportedKeyMethodError('SAMPLE-AES');
      }

      // 4. Fetch the segment, with mid-fragment abandon.
      const fetched = await this.fetchSegmentWithAbandon(segment, state);
      if (fetched.abandoned) {
        // Don't advance cursor; loop will re-pick (now at the lower level).
        state.currentLevelIdx = fetched.targetLevel;
        this.log(
          `abandon: retrying seq=${segment.mediaSequence} at level ${fetched.targetLevel} (${state.variants[fetched.targetLevel]!.bitrate} bps)`,
        );
        continue;
      }

      // Decrypt AES-128 before any format-specific transform.
      const plaintext = await this.maybeDecrypt(fetched.body, segment);

      // Inline-audio / inline-subtitle path (phase 7b.3.2 + multi-language +
      // inline-subtitle): mux video + N audio + N subtitle streams into one
      // TS. Bypasses outputMode.transform.
      if (
        (state.inlineAudios.length > 0 || state.inlineSubtitles.length > 0) &&
        this.outputMode instanceof TsCanonicalMode
      ) {
        const batches = await this.muxInlineAv(
          plaintext,
          segment,
          state.inlineAudios,
          state.inlineSubtitles,
        );
        let written = 0;
        for (const b of batches) {
          await this.opts.sink.write(b.bytes, b.mediaSeconds);
          // Let the event loop TURN between writes: when the read-ahead
          // buffer isn't full, sink.write resolves through microtasks only,
          // so a whole segment's writes would otherwise run as one macrotask
          // and starve the paced sink's drain timer — measured as a ~100 ms
          // wire stall at every segment boundary.
          if ((++written & 15) === 0) await new Promise<void>((r) => setImmediate(r));
        }
      } else {
        // Transform via the output mode; zero-length output still advances the
        // sink's media clock so back-pressure math stays consistent.
        const outBytes = this.outputMode.transform(plaintext);
        await this.opts.sink.write(outBytes, segment.duration);
      }
      if (state.seekEpoch === iterationSeekEpoch) {
        state.cursorMediaSequence = segment.mediaSequence + 1;
        state.playheadSec += segment.duration;
        this.latency.setCursor(state.cursorMediaSequence);
      } else {
        this.log(
          `seek occurred during fetch of seq=${segment.mediaSequence}; keeping cursor at seq=${state.cursorMediaSequence}`,
        );
      }
      if (segment.discontinuity) {
        this.outputMode.resetContiguity?.();
        this.inlineAvMuxer.reset();
      }
    }
  }

  /**
   * Inline-audio AV mux: takes the just-fetched video segment bytes, fetches
   * the matching audio rendition segment(s), demuxes both, and produces a
   * combined TS bytestream via MpegTsMuxer.muxAv.
   *
   * Phase 7b.3.2 simplification: audio segment is matched by mediaSequence
   * (assumes audio + video renditions are produced with aligned segmentation,
   * which the Brunstad reference stream and most HLS production setups do).
   */
  private async muxInlineAv(
    videoBytes: Uint8Array,
    videoSegment: Segment,
    audios: InlineAudioContext[],
    subtitles: InlineSubtitleContext[] = [],
  ): Promise<Array<{ bytes: Uint8Array; mediaSeconds: number }>> {
    const tsMode = this.outputMode as TsCanonicalMode;
    const videoSamples = tsMode.extractVideoSamples(videoBytes);
    const ptsShift = tsMode.getVideoPtsShift();

    // Fetch + demux every language's matching audio segment in parallel.
    // Each language is independent; one failure shouldn't poison the others.
    const audioTracks = await Promise.all(
      audios.map((audio) => this.collectAudioFramesForSegment(videoSegment, audio)),
    );

    const audioStreams = audios.flatMap((audio, idx) => {
      const frames = audioTracks[idx];
      if (!frames || frames.length === 0) {
        // Empty audio segment for this language. Advance lastEmittedPts by
        // the video segment's nominal duration so the NEXT segment's anchor
        // lands at the right wall-clock position — otherwise audio for this
        // language would resume 6 s "behind" video and ffplay would click on
        // resync. The user hears silence for this segment, not a click.
        const advanceTicks = Math.round(videoSegment.duration * 90000);
        if (audio.lastEmittedPts !== undefined) {
          audio.lastEmittedPts += advanceTicks;
        }
        this.log(
          `inline-audio[${audio.label}]: empty audio frames for seq=${videoSegment.mediaSequence}; advancing lastEmittedPts by ${advanceTicks} ticks (likely audio fetch/demux returned 0 frames)`,
        );
        return [];
      }
      // Continuity anchor: the first segment uses (source_pts + ptsShift) as
      // its baseline; subsequent segments emit their first frame at
      // `lastEmittedPts + frameDuration` regardless of source. This shields
      // the audio timeline from any mid-stream bump of ptsShift, encoder
      // tfdt jitter, or other source-side PTS oddities that would otherwise
      // appear as sub-frame gaps and audible clicks.
      const frameDuration =
        frames.length > 1 ? frames[1]!.pts - frames[0]!.pts : 1920;
      const sourceFirstShifted = frames[0]!.pts + ptsShift;
      const targetFirstPts =
        audio.lastEmittedPts === undefined
          ? sourceFirstShifted
          : audio.lastEmittedPts + frameDuration;
      const delta = targetFirstPts - sourceFirstShifted;
      const samples = frames.map((f) => ({
        data: f.data,
        pts: f.pts + ptsShift + delta,
      }));
      // Diagnostic: if a segment has unexpectedly few frames vs. its nominal
      // duration, audio for this language ends early and the next segment's
      // anchor still expects only frameDuration ticks of gap — short by the
      // missing-frames duration, which ffplay renders as a click. Threshold:
      // ≥ 100 ms shortfall.
      const expectedTicks = Math.round(videoSegment.duration * 90000);
      const actualTicks = samples[samples.length - 1]!.pts - samples[0]!.pts + frameDuration;
      const shortfall = expectedTicks - actualTicks;
      if (shortfall > 9000) {
        this.log(
          `inline-audio[${audio.label}]: short segment seq=${videoSegment.mediaSequence}: ${frames.length} frames, ${actualTicks} ticks vs nominal ${expectedTicks} (short by ${shortfall} ≈ ${(shortfall / 90).toFixed(1)}ms)`,
        );
      }
      audio.lastEmittedPts = samples[samples.length - 1]!.pts;
      // Surface the rendition's language to the muxer so it lands as an
      // ISO 639 language descriptor in the PMT — downstream tools (ffprobe,
      // mpv --alang, VLC) see `TAG:language=<code>` per stream.
      const lang = audio.rendition.language;
      return [{
        pid: audio.pid,
        streamType: StreamType.AAC_ADTS,
        samples,
        ...(lang ? { language: lang } : {}),
      }];
    });

    // Drain each subtitle context's cue buffer. Cues carry absolute 90 kHz
    // PTS from the WebVTT parser; we apply the same ptsShift the audio path
    // applies so subtitles stay in sync with the (shifted) video timeline.
    // Buffer is monotonically PTS-ascending (cues appended in segment order
    // by the background subtitle extractor).
    const subtitleStreams = subtitles.flatMap((sub) => {
      const cues = sub.cueBuffer.splice(0);
      if (cues.length === 0) return [];
      const lang = sub.rendition.language;
      return [{
        pid: sub.pid,
        samples: cues.map((c) => ({
          data: c.payload,
          pts: c.pts + ptsShift,
        })),
        ...(lang ? { language: lang } : {}),
      }];
    });

    // Mux in per-video-AU content-time buckets instead of one whole-segment
    // batch (see AV_WRITE_BUCKET_TICKS): each write completes on the wire by
    // its own content position, so downstream tsdemux!mpegtsmux consumers
    // see a ~frame-interval AU cadence instead of a 130-220 ms void + flood
    // around every large I-frame, and audio stays interleaved per frame.
    // The muxer instance persists across calls, so CC and PSI stay
    // continuous (PSI repeats per AU — 20 ms cadence at 50 fps, well inside
    // the spec's ≤100 ms and ~2 % overhead). Declared spans come from each
    // bucket's video DTS ladder, never EXTINF (see videoSpanSeconds).
    const buckets = partitionAvByDts(videoSamples, audioStreams, subtitleStreams);
    if (buckets.length === 0) {
      // Degenerate segment with no video ladder — one batch, EXTINF span.
      const bytes = this.inlineAvMuxer.muxMulti({
        video: videoSamples,
        audios: audioStreams,
        subtitles: subtitleStreams,
      });
      return [{ bytes, mediaSeconds: videoSegment.duration }];
    }
    // Mux bucket-by-bucket with periodic event-loop yields (same rationale
    // as the write loop: keep the paced drain timer serviced while a whole
    // segment's worth of per-AU buckets is muxed).
    const out: Array<{ bytes: Uint8Array; mediaSeconds: number }> = [];
    for (const b of buckets) {
      out.push({
        bytes: this.inlineAvMuxer.muxMulti({
          video: b.video,
          audios: b.audios,
          subtitles: b.subtitles,
        }),
        mediaSeconds: b.spanSec,
      });
      if ((out.length & 31) === 0) await new Promise<void>((r) => setImmediate(r));
    }
    return out;
  }

  /**
   * Returns this language's ADTS-framed audio samples covering the video
   * segment's time range. Reloads the audio playlist if the matching segment
   * isn't visible yet (live race condition). Returns an empty list when no
   * matching segment exists (logged at warn level).
   */
  private async collectAudioFramesForSegment(
    videoSegment: Segment,
    audio: InlineAudioContext,
  ): Promise<{ data: Uint8Array; pts: number }[]> {
    let audioSegment = this.findSegment(audio.playlist, videoSegment.mediaSequence);
    if (!audioSegment) {
      const reloaded = await this.loadText({ url: audio.rendition.uri!, kind: 'playlist' });
      audio.playlist = parseMedia(reloaded.text, reloaded.url);
      audioSegment = this.findSegment(audio.playlist, videoSegment.mediaSequence);
    }
    if (!audioSegment) {
      this.log(
        `inline-audio[${audio.label}]: no matching audio segment for seq=${videoSegment.mediaSequence}; emitting silence for this segment`,
      );
      return [];
    }

    if (audioSegment.initSection && audioSegment.initSection.uri !== audio.lastInitUri) {
      const initBytes = await this.fetchInitBytes(audioSegment.initSection);
      audio.extractor.setInit(initBytes);
      audio.lastInitUri = audioSegment.initSection.uri;
    }

    const req: LoaderRequest = { url: audioSegment.uri, kind: 'segment' };
    if (this.opts.signal) req.signal = this.opts.signal;
    if (audioSegment.byteRange) req.byteRange = audioSegment.byteRange;
    const res = await this.loader.fetch(req);
    const sniffed = detectByContent(res.body);

    // Format branch:
    //   raw ADTS (BCC-shape, possibly with leading ID3 PTS anchor)
    //   MPEG-TS-wrapped AAC (LongTail-shape — AAC ADTS frames inside an
    //     audio PID's PES packets; PTS comes from the PES header)
    //   fMP4 (Brunstad-shape, with EXT-X-MAP init)
    if (sniffed === 'aac' || isId3Prefixed(res.body)) {
      // No init segment needed; ADTS frame split + ID3 PRIV timestamp anchors PTS.
      return extractAacFrames(res.body).map((f) => ({ data: f.data, pts: f.pts }));
    }
    if (sniffed === 'ts') {
      if (!audio.tsDemuxer) audio.tsDemuxer = new Demuxer();
      const demuxed = audio.tsDemuxer.demux(res.body);
      // Each PES carries one or more concatenated ADTS frames. The PES header
      // PTS is the timestamp of the first frame; subsequent frames within
      // the same PES advance by `ticksPerFrame` (1024 samples × 90000 ÷ Hz).
      // Only AAC ADTS is supported — LATM/LOAS or MP3/AC-3 inside TS would
      // hit the sync-byte check in `framesFromAdts` and throw with context.
      const out: { data: Uint8Array; pts: number }[] = [];
      for (const pes of demuxed.audio) {
        if (pes.pts === undefined) continue;
        const frames = framesFromAdts(pes.data, pes.pts);
        for (const f of frames) out.push({ data: f.data, pts: f.pts });
      }
      return out;
    }
    if (sniffed !== 'fmp4' && sniffed !== 'unknown') {
      throw new Error(
        `inline-audio: unsupported audio rendition format ${sniffed} for ${audioSegment.uri}`,
      );
    }
    if (!audio.extractor.isReady()) {
      throw new Error(
        `inline-audio[${audio.label}]: extractor missing init segment for ${audioSegment.uri}`,
      );
    }
    return audio.extractor.frames(res.body);
  }

  /**
   * Get a variant's playlist via the cache, notifying LatencyController of
   * the load so its live-edge state stays current. Refreshes happen
   * transparently inside cache.get() for stale live playlists; we only see
   * the resulting playlist here, which is fine — the live tip can only
   * monotonically grow, and the controller takes the max.
   */
  private async getPlaylist(cache: PlaylistCache, variant: Variant): Promise<MediaPlaylist> {
    const playlist = await cache.get(variant);
    this.latency.onPlaylistUpdate(playlist);
    return playlist;
  }

  /**
   * If `segment` carries EXT-X-KEY METHOD=AES-128, fetch the key (from cache
   * when warm) and AES-CBC decrypt. SAMPLE-AES is rejected earlier in the
   * loop; this method only sees AES-128 or NONE.
   */
  private async maybeDecrypt(bytes: Uint8Array, segment: Segment): Promise<Uint8Array> {
    const key = segment.key;
    if (!key || key.method === 'NONE') return bytes;
    if (key.method !== 'AES-128') throw new UnsupportedKeyMethodError(key.method);
    if (!key.uri) throw new Error(`EXT-X-KEY METHOD=AES-128 missing URI for seq ${segment.mediaSequence}`);
    const keyBytes = await this.keyCache.get(key.uri);
    const iv = key.iv ?? deriveIv(segment.mediaSequence);
    return decryptAes128Cbc(bytes, keyBytes, iv);
  }

  // -- bootstrap --------------------------------------------------------------

  private async bootstrap(): Promise<ExtractorState> {
    this.log(`fetching manifest: ${this.opts.url}`);
    const root = await this.loadText({ url: this.opts.url, kind: 'manifest' });

    let variants: Variant[];
    let initialPlaylistUrl: string;
    let initialPlaylistText: string;
    let usingMaster: boolean;
    let master: MasterPlaylist | undefined;

    if (isMasterPlaylist(root.text)) {
      usingMaster = true;
      master = parseMaster(root.text, root.url);
      if (master.variants.length === 0) throw new ParseError('master playlist has no variants');
      variants = [...master.variants].sort((a, b) => a.bitrate - b.bitrate);

      if (this.opts.fixedQuality) {
        const picked = pickVariant(variants, this.opts.fixedQuality);
        variants = [picked];
        this.log(
          `fixed variant: bitrate=${picked.bitrate}${picked.resolution ? ` ${picked.resolution.width}x${picked.resolution.height}` : ''}`,
        );
      } else {
        this.log(
          `ABR ladder: ${variants.map((v) => `${Math.round(v.bitrate / 1000)}k`).join(', ')}`,
        );
      }
      // Need to load *some* variant's playlist to learn segment count / live state.
      // Pick the lowest level for the bootstrap probe — it loads fastest and gives
      // us the same media-sequence shape as any sibling variant.
      initialPlaylistUrl = variants[0]!.uri;
      const probe = await this.loadText({ url: initialPlaylistUrl, kind: 'playlist' });
      initialPlaylistText = probe.text;
      initialPlaylistUrl = probe.url;
    } else {
      usingMaster = false;
      // Synthetic single-variant: no bitrate signal, so ABR is meaningless
      // and we tag a placeholder. Caller's fixedQuality (if any) is ignored.
      variants = [
        {
          uri: root.url,
          bitrate: 0,
        },
      ];
      initialPlaylistUrl = root.url;
      initialPlaylistText = root.text;
    }

    const probePlaylist = parseMedia(initialPlaylistText, initialPlaylistUrl);
    const levels: LevelInfo[] = variants.map((v) => ({
      bitrate: v.bitrate,
      avgSegmentDuration: probePlaylist.targetDuration || 6,
    }));

    const cache = new PlaylistCache(this.loader, this.opts.signal);
    // Seed the cache for the variant we just probed so we don't refetch it.
    if (usingMaster) {
      await cache.get(variants[0]!); // populate via the cache code path
    }

    // Pick a sensible starting level: lowest for first pass, ABR will pick up
    // from there. Phase 7 will replace this with a proper "first auto level"
    // probe per hls.js firstAutoLevel logic.
    const startLevel = 0;

    const isLive = !probePlaylist.endList;
    let cursorMediaSequence = this.initialCursor(probePlaylist, isLive);

    // Seed the latency controller with the bootstrap playlist + cursor so
    // the first ABR decision sees a sensible buffer signal.
    this.latency.onPlaylistUpdate(probePlaylist);
    this.latency.setCursor(cursorMediaSequence);
    if (isLive && this.opts.autoTuneLiveSync !== false && !this.liveSyncTargetPinned) {
      this.latency.autoTuneSyncTarget(2);
      this.log(
        `latency: auto-tuned liveSyncTarget=${this.latency.getConfig().liveSyncTargetSec}s (2 × targetDuration)`,
      );
    }

    // Resolve alignment strategy. 'auto' → 'cumulative' for VOD,
    // 'mediaSequence' for live (where sliding-window playlists make
    // cumulative-EXTINF unstable across reloads).
    let alignment: 'mediaSequence' | 'cumulative';
    const requested = this.opts.alignment ?? 'auto';
    if (requested === 'auto') {
      alignment = isLive ? 'mediaSequence' : 'cumulative';
    } else {
      alignment = requested;
    }

    // Seed playhead from the first segment to be played: its startTimeSec.
    let firstSeg = this.findSegment(probePlaylist, cursorMediaSequence);
    let playheadSec = firstSeg?.startTimeSec ?? 0;

    // Apply startTimeSec if requested. VOD-only; warn-and-ignore on live.
    // Clamp out-of-range to the last playable segment with a warning.
    if (this.opts.startTimeSec !== undefined && this.opts.startTimeSec > 0) {
      if (isLive) {
        this.log(`startTimeSec=${this.opts.startTimeSec}s ignored on live stream`);
      } else {
        const clamped = clampStartTime(this.opts.startTimeSec, probePlaylist);
        if (clamped !== this.opts.startTimeSec) {
          this.log(
            `startTimeSec clamped: ${this.opts.startTimeSec}s → ${clamped}s (asset duration ${probePlaylist.totalDuration.toFixed(2)}s)`,
          );
        }
        const target = findSegmentAtTime(probePlaylist, clamped);
        if (target) {
          cursorMediaSequence = target.mediaSequence;
          firstSeg = target;
          playheadSec = target.startTimeSec;
          this.latency.setCursor(cursorMediaSequence);
          this.log(
            `startTimeSec applied: playhead=${playheadSec.toFixed(2)}s, seq=${cursorMediaSequence}`,
          );
        }
      }
    }

    // Phase 7b.3.2 + multi-language inline-audio bootstrap.
    const inlineAudios = await this.bootstrapInlineAudios(master);
    // Inline-subtitle bootstrap (private PIDs starting at 0x110).
    const inlineSubtitles = this.bootstrapInlineSubtitles(
      master,
      variants[startLevel]!.subtitleGroup,
    );

    return {
      variants,
      levels,
      cache,
      currentLevelIdx: startLevel,
      cursorMediaSequence,
      playheadSec,
      isLive,
      lastEmittedInitUri: undefined,
      master,
      alignment,
      previousLevelIdx: startLevel,
      inlineAudios,
      inlineSubtitles,
      seekEpoch: 0,
    };
  }

  private async bootstrapInlineAudios(
    master: MasterPlaylist | undefined,
  ): Promise<InlineAudioContext[]> {
    const sel = this.opts.inlineAudioLanguages;
    if (!sel || (Array.isArray(sel) && sel.length === 0)) return [];
    if (!(this.outputMode instanceof TsCanonicalMode)) {
      throw new Error(
        'inlineAudioLanguages requires outputMode = ts-canonical (current mode does not support inline audio)',
      );
    }
    if (!master) {
      throw new Error('inlineAudioLanguages requires a master playlist with audio renditions');
    }

    // 1. Filter master.audio by the requested languages (or take all).
    //
    // When `sel` is an explicit list, the Map's insertion order determines
    // PID assignment AND the order of audio entries in the canonical TS PMT.
    // Most players (ffplay, mpv with default settings) pick the first audio
    // stream in the PMT as the default for playback — so `--inline-audio=nor,eng,fra`
    // must produce Norwegian as the first PMT entry. Pre-seed the Map with
    // empty entries in the user's order so iteration honors that order even
    // when master.audio lists the renditions in a different order.
    const wantedList = sel === 'all' ? undefined : sel.map((s) => s.toLowerCase());
    const wantedSet = wantedList ? new Set(wantedList) : undefined;
    const matchedByLang = new Map<string, AlternateRendition[]>();
    if (wantedList) {
      for (const lang of wantedList) matchedByLang.set(lang, []);
    }
    for (const r of master.audio) {
      if (!r.uri) continue;
      const langKey = (r.language ?? r.name).toLowerCase();
      const nameKey = r.name ? r.name.toLowerCase() : undefined;
      // Match: any of langKey or nameKey appears in the requested set.
      // Store under whichever matched the wantedList so the pre-seeded
      // order is preserved.
      let key: string;
      if (!wantedSet) {
        key = langKey;
      } else if (wantedSet.has(langKey)) {
        key = langKey;
      } else if (nameKey && wantedSet.has(nameKey)) {
        key = nameKey;
      } else {
        continue;
      }
      if (!matchedByLang.has(key)) matchedByLang.set(key, []);
      matchedByLang.get(key)!.push(r);
    }
    // Drop pre-seeded entries for languages that didn't resolve to any
    // rendition in master.audio (user typo / unavailable language).
    for (const [k, v] of matchedByLang) {
      if (v.length === 0) matchedByLang.delete(k);
    }
    if (matchedByLang.size === 0) {
      throw new Error(
        `inlineAudioLanguages: none of [${(sel === 'all' ? ['all'] : sel).join(',')}] found in master.audio`,
      );
    }

    // 2. Pick the best AUDIO group covering the most languages, honoring the
    //    mono filter (default skips groups whose renditions are entirely mono).
    const allowMono = this.opts.allowMonoAudio === true;
    const candidateGroups = new Map<string, AlternateRendition[]>();
    for (const langRenditions of matchedByLang.values()) {
      for (const r of langRenditions) {
        if (!candidateGroups.has(r.groupId)) candidateGroups.set(r.groupId, []);
        candidateGroups.get(r.groupId)!.push(r);
      }
    }
    let eligibleGroups: string[];
    if (allowMono) {
      eligibleGroups = [...candidateGroups.keys()];
    } else {
      eligibleGroups = [...candidateGroups.entries()]
        .filter(([_, rs]) => !groupIsAllMono(rs))
        .map(([g]) => g);
      if (eligibleGroups.length === 0) {
        // Nothing stereo+; fall back to mono with a warning.
        this.log(
          'inline-audio: no stereo+ group found across selected languages — falling back to mono (use --allow-mono-audio=false explicit if this is unexpected)',
        );
        eligibleGroups = [...candidateGroups.keys()];
      }
    }
    // Among eligible groups, pick the one covering the most languages.
    // Tiebreak by preferring groups with a stereo rendition.
    let bestGroup: string | undefined;
    let bestCoverage = -1;
    let bestHasStereo = false;
    for (const g of eligibleGroups) {
      const renditions = candidateGroups.get(g)!;
      const langs = new Set(renditions.map((r) => (r.language ?? r.name).toLowerCase()));
      const coverage = langs.size;
      const hasStereo = groupHasStereo(renditions);
      if (
        coverage > bestCoverage ||
        (coverage === bestCoverage && !bestHasStereo && hasStereo)
      ) {
        bestGroup = g;
        bestCoverage = coverage;
        bestHasStereo = hasStereo;
      }
    }
    if (!bestGroup) {
      throw new Error('inlineAudioLanguages: failed to resolve a suitable AUDIO group');
    }
    this.log(
      `inline-audio: selected group=${bestGroup} covering ${bestCoverage} language(s) (stereo=${bestHasStereo})`,
    );

    // 3. For each requested language, pick its rendition in the chosen group.
    const ctxs: InlineAudioContext[] = [];
    let nextPid = DEFAULT_AUDIO_PID;
    for (const [langKey, langRenditions] of matchedByLang) {
      const rendition = langRenditions.find((r) => r.groupId === bestGroup);
      if (!rendition) {
        this.log(
          `inline-audio: language=${langKey} missing in group=${bestGroup}; skipped`,
        );
        continue;
      }
      const label = rendition.language ?? rendition.name;
      const channels = renditionMaxChannels(rendition) ?? 0;
      this.log(
        `inline-audio[${label}]: PID=0x${nextPid.toString(16)} group=${rendition.groupId} channels=${channels} uri=${rendition.uri}`,
      );
      const playlistRes = await this.loadText({ url: rendition.uri!, kind: 'playlist' });
      const playlist = parseMedia(playlistRes.text, playlistRes.url);
      ctxs.push({
        rendition,
        playlist,
        extractor: new Fmp4AudioExtractor(),
        tsDemuxer: undefined,
        lastInitUri: undefined,
        pid: nextPid,
        label,
        lastEmittedPts: undefined,
      });
      nextPid++;
    }
    return ctxs;
  }

  /**
   * Inline-subtitle bootstrap. Mirrors `bootstrapInlineAudios` selection
   * semantics: filter by language-or-name, preserve user-specified order,
   * pick the SUBTITLES group covering the most requested languages (tied
   * groups break in favour of the one the start variant advertises), dedupe
   * by `isDefault=true` within a group. PIDs assigned from
   * DEFAULT_SUBTITLE_PID_BASE in user order.
   *
   * Unlike audio, subtitles don't need a media-playlist preload — the
   * SubtitleRenditionExtractor loads its own when it starts. We just need
   * to pick the rendition + assign the PID + create the cue buffer here.
   *
   * Returns [] when no inline-subtitle selection is configured — and ALSO
   * when the selection cannot be satisfied by the CONTENT (no master
   * playlist, no subtitle renditions, or none of the requested languages
   * present), logged as a warning. Subtitles are additive: a URL swap to a
   * source without them must degrade to audio+video, not crash-loop the
   * player (a sticky module config outlives any one playlist). Only a true
   * configuration error (wrong output mode) still throws.
   */
  private bootstrapInlineSubtitles(
    master: MasterPlaylist | undefined,
    initialVariantSubtitleGroup: string | undefined,
  ): InlineSubtitleContext[] {
    const sel = this.opts.inlineSubtitleLanguages;
    if (!sel || (Array.isArray(sel) && sel.length === 0)) return [];
    if (!(this.outputMode instanceof TsCanonicalMode)) {
      throw new Error(
        'inlineSubtitleLanguages requires outputMode = ts-canonical (current mode does not support inline subtitles)',
      );
    }
    if (!master || master.subtitles.length === 0) {
      this.log(
        'inline-subtitles: source has no subtitle renditions — continuing without subtitles',
      );
      return [];
    }

    // 1. Filter master.subtitles by the requested languages (or take all),
    //    preserving user list order so PMT entries land in that order.
    const wantedList = sel === 'all' ? undefined : sel.map((s) => s.toLowerCase());
    const wantedSet = wantedList ? new Set(wantedList) : undefined;
    const matchedByLang = new Map<string, AlternateRendition[]>();
    if (wantedList) {
      for (const lang of wantedList) matchedByLang.set(lang, []);
    }
    for (const r of master.subtitles) {
      if (!r.uri) continue;
      const langKey = (r.language ?? r.name).toLowerCase();
      const nameKey = r.name ? r.name.toLowerCase() : undefined;
      let key: string;
      if (!wantedSet) {
        key = langKey;
      } else if (wantedSet.has(langKey)) {
        key = langKey;
      } else if (nameKey && wantedSet.has(nameKey)) {
        key = nameKey;
      } else {
        continue;
      }
      if (!matchedByLang.has(key)) matchedByLang.set(key, []);
      matchedByLang.get(key)!.push(r);
    }
    for (const [k, v] of matchedByLang) {
      if (v.length === 0) matchedByLang.delete(k);
    }
    if (matchedByLang.size === 0) {
      this.log(
        `inline-subtitles: none of [${(sel === 'all' ? ['all'] : sel).join(',')}] found in master.subtitles — continuing without subtitles`,
      );
      return [];
    }

    // 2. Build candidateGroups; pick group covering most languages.
    //    Tiebreak: prefer the group the start variant declares (so we begin
    //    on the same SUBTITLES group video advertises).
    const candidateGroups = new Map<string, AlternateRendition[]>();
    for (const langRenditions of matchedByLang.values()) {
      for (const r of langRenditions) {
        if (!candidateGroups.has(r.groupId)) candidateGroups.set(r.groupId, []);
        candidateGroups.get(r.groupId)!.push(r);
      }
    }
    let bestGroup: string | undefined;
    let bestCoverage = -1;
    let bestIsVariantGroup = false;
    for (const [g, rs] of candidateGroups) {
      const langs = new Set(rs.map((r) => (r.language ?? r.name).toLowerCase()));
      const coverage = langs.size;
      const isVariantGroup = g === initialVariantSubtitleGroup;
      if (
        coverage > bestCoverage ||
        (coverage === bestCoverage && !bestIsVariantGroup && isVariantGroup)
      ) {
        bestGroup = g;
        bestCoverage = coverage;
        bestIsVariantGroup = isVariantGroup;
      }
    }
    if (!bestGroup) {
      throw new Error('inlineSubtitleLanguages: failed to resolve a suitable SUBTITLES group');
    }
    this.log(
      `inline-subtitle: selected group=${bestGroup} covering ${bestCoverage} language(s)${bestIsVariantGroup ? ' (matches start variant)' : ''}`,
    );

    // 3. For each requested language, pick its rendition in the chosen group.
    //    Dedupe duplicates inside the group by preferring DEFAULT.
    const ctxs: InlineSubtitleContext[] = [];
    let nextPid = DEFAULT_SUBTITLE_PID_BASE;
    for (const [langKey, langRenditions] of matchedByLang) {
      const candidates = langRenditions.filter((r) => r.groupId === bestGroup);
      if (candidates.length === 0) {
        this.log(
          `inline-subtitle: language=${langKey} missing in group=${bestGroup}; skipped`,
        );
        continue;
      }
      const rendition =
        candidates.find((r) => r.isDefault) ?? candidates[0]!;
      const label = rendition.language ?? rendition.name;
      this.log(
        `inline-subtitle[${label}]: PID=0x${nextPid.toString(16)} group=${rendition.groupId} uri=${rendition.uri}`,
      );
      ctxs.push({
        rendition,
        pid: nextPid,
        label,
        langKey,
        cueBuffer: [],
      });
      nextPid++;
    }
    return ctxs;
  }

  private maybeMakeSubtitleCoordinator(state: ExtractorState): SubtitleCoordinator | undefined {
    if (state.inlineSubtitles.length === 0) return undefined;
    if (!state.master) return undefined;
    // The bootstrap step already picked a chosen group — pass it through so
    // the coordinator only fires onVideoVariantChange when the new variant
    // names a DIFFERENT group.
    const initialGroup = state.inlineSubtitles[0]!.rendition.groupId;
    const tracks: SubtitleTrackBinding[] = state.inlineSubtitles.map((ctx) => ({
      langKey: ctx.langKey,
      rendition: ctx.rendition,
      onCues: (cues) => {
        // Append in PTS-ascending order. The rendition extractor processes
        // segments sequentially, so cues from a single call are already in
        // PTS order; concatenation preserves that across calls.
        for (const c of cues) ctx.cueBuffer.push(c);
      },
    }));
    const coordOpts: ConstructorParameters<typeof SubtitleCoordinator>[0] = {
      master: state.master,
      tracks,
      initialGroup,
      loader: this.loader,
    };
    if (this.opts.signal) coordOpts.signal = this.opts.signal;
    if (this.opts.log) coordOpts.log = this.opts.log;
    if (this.opts.liveStartOffsetSegments !== undefined) {
      coordOpts.liveStartOffsetSegments = this.opts.liveStartOffsetSegments;
    }
    coordOpts.pauseGate = () => this.pauseGate;
    if (!state.isLive && this.opts.startTimeSec !== undefined && this.opts.startTimeSec > 0) {
      coordOpts.initialPlayheadSec = state.playheadSec;
    }
    return new SubtitleCoordinator(coordOpts);
  }

  // -- segment fetch with abandon --------------------------------------------

  private async fetchSegmentWithAbandon(
    segment: Segment,
    state: ExtractorState,
  ): Promise<
    | { abandoned: false; body: Uint8Array }
    | { abandoned: true; targetLevel: number }
  > {
    const abandonCtrl = new AbortController();
    const combined = anySignal(this.opts.signal, abandonCtrl.signal);

    let lastCheckMs = 0;
    let abandonTarget = -1;
    const expectedBytesFallback = Math.ceil(
      (state.variants[state.currentLevelIdx]!.bitrate * segment.duration) / 8,
    );

    const onProgress = (p: { loaded: number; total: number | undefined; elapsedMs: number; ttfbMs: number | undefined }) => {
      if (!this.abrEnabled) return;
      if (p.elapsedMs - lastCheckMs < this.abandonCheckIntervalMs) return;
      lastCheckMs = p.elapsedMs;

      const expectedBytes = p.total ?? expectedBytesFallback;
      const target = this.abr.shouldAbandon({
        currentLevelIdx: state.currentLevelIdx,
        levels: state.levels,
        bufferAheadSec: this.latency.bufferForAbrSec(),
        loaded: p.loaded,
        expectedBytes,
        elapsedMs: p.elapsedMs,
        ttfbMs: p.ttfbMs,
        segmentDuration: segment.duration,
      });
      if (target !== -1 && target < state.currentLevelIdx) {
        abandonTarget = target;
        // Sample partial download into estimator BEFORE aborting; mirrors hls.js
        // which trains the estimator on the bad bandwidth signal immediately.
        const timeStreaming = Math.max(1, p.elapsedMs - (p.ttfbMs ?? 0));
        this.abr.samplePartialLoad(p.loaded, timeStreaming);
        abandonCtrl.abort(new AbandonReason(target));
      }
    };

    const req: LoaderRequest = { url: segment.uri, kind: 'segment', signal: combined };
    if (segment.byteRange) req.byteRange = segment.byteRange;

    try {
      const res = await this.loader.fetch(req, onProgress);
      // Feed the estimator with the completed sample.
      this.abr.sampleFragmentLoad({
        totalMs: res.stats.totalMs,
        ttfbMs: res.stats.ttfbMs,
        bytes: res.stats.bytes,
      });
      return { abandoned: false, body: res.body };
    } catch (err) {
      if (abandonTarget !== -1 && err instanceof Error && err.name === 'AbortError') {
        return { abandoned: true, targetLevel: abandonTarget };
      }
      throw err;
    }
  }

  // -- helpers ----------------------------------------------------------------

  private async loadText(req: LoaderRequest): Promise<{ url: string; text: string }> {
    if (this.opts.signal) req.signal = this.opts.signal;
    const res = await this.loader.fetch(req);
    return { url: res.url, text: new TextDecoder('utf-8').decode(res.body) };
  }

  private async fetchAndForward(
    url: string,
    byteRange: { length: number; offset: number } | undefined,
    mediaSeconds: number,
  ): Promise<void> {
    const req: LoaderRequest = { url, kind: 'segment' };
    if (this.opts.signal) req.signal = this.opts.signal;
    if (byteRange) req.byteRange = byteRange;
    const res = await this.loader.fetch(req);
    await this.opts.sink.write(res.body, mediaSeconds);
  }

  private async fetchInitBytes(init: {
    uri: string;
    byteRange?: { length: number; offset: number };
  }): Promise<Uint8Array> {
    const req: LoaderRequest = { url: init.uri, kind: 'init' };
    if (this.opts.signal) req.signal = this.opts.signal;
    if (init.byteRange) req.byteRange = init.byteRange;
    const res = await this.loader.fetch(req);
    return res.body;
  }

  private initialCursor(playlist: MediaPlaylist, isLive: boolean): number {
    if (!isLive || playlist.segments.length === 0) return playlist.mediaSequence;
    const offset = this.opts.liveStartOffsetSegments ?? 6;
    const last = playlist.segments[playlist.segments.length - 1]!.mediaSequence;
    return Math.max(playlist.mediaSequence, last - offset + 1);
  }

  private findSegment(playlist: MediaPlaylist, mediaSequence: number): Segment | undefined {
    if (playlist.segments.length === 0) return undefined;
    const first = playlist.mediaSequence;
    const idx = mediaSequence - first;
    if (idx < 0 || idx >= playlist.segments.length) return undefined;
    return playlist.segments[idx];
  }

  private throwIfAborted(): void {
    if (this.opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

/** Custom abort reason so we can distinguish our abandon from upstream cancel. */
class AbandonReason {
  constructor(public readonly targetLevel: number) {}
}

/**
 * Clamp a requested start time to the asset's playable range. Negative values
 * snap to 0; values past the last segment's start snap to it. Returns the
 * clamped value; callers compare to the input to detect (and log) a clamp.
 *
 * Upper bound is `totalDuration − lastSegmentDuration` (start of the last
 * segment), not `totalDuration` itself, so the clamped value always resolves
 * to a fetchable segment via `findSegmentAtTime`.
 */
export function clampStartTime(t: number, playlist: MediaPlaylist): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  const last = playlist.segments[playlist.segments.length - 1];
  if (!last) return 0;
  const upper = Math.max(0, playlist.totalDuration - last.duration);
  return Math.min(t, upper);
}

/**
 * Content-time write granularity for the inline-AV mux: one bucket per video
 * access unit (any DTS advance starts a new bucket).
 *
 * Per-AU is load-bearing for downstream re-mux consumers, not a tuning
 * choice: a paced byte-uniform sink spreads each write's bytes across its
 * span, so a large I-frame inside a multi-frame bucket only finishes
 * arriving `I-frame bytes ÷ bucket rate` after the previous AU. A
 * `tsdemux ! mpegtsmux` consumer releases whole AUs on COMPLETION, so that
 * arrival lag reproduces at its output as a total wire void followed by a
 * line-rate flood (measured on .211 with 250 ms buckets: 130–220 ms voids
 * every GOP/segment at the muxer output and at the SRT receiver — small
 * receiver buffers drop frames on it). With one AU per write, the video
 * pad's starvation is bounded by ~one frame interval, matching how every
 * live gst producer on the bus emits. Egress pacing downstream cannot fix
 * this instead: it can hold early data but never advance late data.
 */
const AV_WRITE_BUCKET_TICKS = 1;

/** Span fallback when a bucket's frame duration is unknowable (single-frame
 *  segment): one 25 fps frame @ 90 kHz. */
const FALLBACK_FRAME_TICKS = 3_600;

/** One content-time mux batch produced by `partitionAvByDts`. */
export interface AvWriteBucket<V, A, S> {
  video: V[];
  audios: A[];
  subtitles: S[];
  /** True media span (s) this bucket covers on the output timeline. */
  spanSec: number;
}

/**
 * Partition one segment's mux inputs into content-time buckets cut on the
 * video DTS ladder — by default one bucket per video AU (see the
 * `AV_WRITE_BUCKET_TICKS` rationale: whole-AU completion cadence on the wire
 * is what keeps a downstream `tsdemux ! mpegtsmux` consumer from starving
 * through large I-frames; coarser buckets re-create the void). `bucketTicks`
 * stays a parameter for callers that want coarser runs.
 *
 * Every bucket keeps the FULL audio/subtitle stream list (possibly with
 * empty sample arrays) so the per-call PMT always announces the same stream
 * set. Bucket spans telescope exactly: bucket k spans to bucket k+1's first
 * video DTS; the last bucket adds one average frame duration — summing to
 * precisely the whole segment's ladder span. Audio/subtitle samples index by
 * PTS into the video buckets (clamped to the ends). Returns [] when there is
 * no video to cut on — the caller falls back to a single whole-segment batch.
 */
export function partitionAvByDts<
  V extends { dts: number },
  A extends { samples: Array<{ pts: number }> },
  S extends { samples: Array<{ pts: number }> },
>(video: V[], audios: A[], subtitles: S[], bucketTicks = AV_WRITE_BUCKET_TICKS): Array<AvWriteBucket<V, A, S>> {
  if (video.length === 0) return [];
  const firstDts = video[0]!.dts;
  const lastDts = video[video.length - 1]!.dts;
  const avgFrameTicks =
    video.length > 1 ? (lastDts - firstDts) / (video.length - 1) : FALLBACK_FRAME_TICKS;

  // Cut the video ladder into runs of >= bucketTicks.
  const starts: number[] = []; // index into `video` where each bucket begins
  let bucketStartDts = -Infinity;
  for (let i = 0; i < video.length; i++) {
    if (video[i]!.dts >= bucketStartDts + bucketTicks) {
      starts.push(i);
      bucketStartDts = video[i]!.dts;
    }
  }

  const buckets = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]! : video.length;
    const spanTicks =
      k + 1 < starts.length
        ? video[starts[k + 1]!]!.dts - video[s]!.dts
        : video[video.length - 1]!.dts - video[s]!.dts + avgFrameTicks;
    return {
      video: video.slice(s, end),
      audios: audios.map((a) => ({ ...a, samples: [] as typeof a.samples })),
      subtitles: subtitles.map((x) => ({ ...x, samples: [] as typeof x.samples })),
      spanSec: spanTicks / 90000,
    };
  });

  // Route audio/subtitle samples into buckets by PTS (clamped to the ends).
  const startDts = starts.map((s) => video[s]!.dts);
  const bucketIdx = (pts: number): number => {
    let lo = 0;
    let hi = startDts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (startDts[mid]! <= pts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  audios.forEach((a, ai) => {
    for (const smp of a.samples) buckets[bucketIdx(smp.pts)]!.audios[ai]!.samples.push(smp);
  });
  subtitles.forEach((x, si) => {
    for (const smp of x.samples) buckets[bucketIdx(smp.pts)]!.subtitles[si]!.samples.push(smp);
  });
  return buckets as Array<AvWriteBucket<V, A, S>>;
}

/** True if the buffer starts with an ID3v2 tag ("ID3" magic bytes). */
function isId3Prefixed(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0]!;
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  const ctrl = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

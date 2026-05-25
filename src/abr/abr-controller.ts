/*
 * hls-pipe — Adaptive Bitrate Controller
 *
 * Fresh implementation, inspired by hls.js src/controller/abr-controller.ts.
 * The algorithm mirrors hls.js but the wiring is rebuilt for our extractor:
 *
 *   - the upstream is event-driven (FRAG_LOADED, FRAG_BUFFERED, etc.); here
 *     the extractor calls us directly per segment and per progress tick
 *   - the upstream reads buffer state from MediaSource; we read it from the
 *     virtual buffer maintained by StdoutSink
 *   - the upstream has codec-tier / HDR rules; phase 2 ignores those
 *     (will land in phase 7 polish)
 *
 * Algorithmic provenance:
 *   - level selection:          hls.js src/controller/abr-controller.ts:findBestLevel
 *   - two-pass auto level:      hls.js src/controller/abr-controller.ts:getNextABRAutoLevel
 *   - mid-fragment abandon:     hls.js src/controller/abr-controller.ts:_abandonRulesCheck
 *   - bandwidth math:           ported in src/abr/bandwidth-estimator.ts (Apache 2.0 port)
 *
 * Defaults are tuned per hls.js config.ts (475-486) with optional caller overrides.
 */

import { EwmaBandWidthEstimator } from './bandwidth-estimator.js';

export interface AbrConfig {
  /** EWMA slow half-life in seconds. hls.js default: 9 (live & VoD). */
  ewmaSlowSec: number;
  /** EWMA fast half-life in seconds. hls.js default: 3. */
  ewmaFastSec: number;
  /** Cold-start bandwidth estimate (bits/s). hls.js default: 500 kbps. */
  defaultEstimateBps: number;
  /** Down/stay multiplier on bandwidth estimate. hls.js default: 0.95. */
  bwFactor: number;
  /** Up-switch multiplier (more conservative). hls.js default: 0.70. */
  bwUpFactor: number;
  /** Seconds of starvation we tolerate when searching for a level. hls.js default: 4. */
  maxStarvationDelaySec: number;
  /** Optional hard upper bound on selected variant bitrate. */
  capBitrate: number | undefined;
}

export const DEFAULT_ABR_CONFIG: AbrConfig = {
  ewmaSlowSec: 9,
  ewmaFastSec: 3,
  defaultEstimateBps: 500_000,
  bwFactor: 0.95,
  bwUpFactor: 0.7,
  maxStarvationDelaySec: 4,
  capBitrate: undefined,
};

/**
 * Suggested tuning preset for "bad mobile network" scenarios, derived from
 * hls.js wisdom + the notes we developed during phase planning. Tighter EWMA
 * half-lives, more conservative margin, shorter starvation tolerance.
 */
export const UNSTABLE_NETWORK_ABR_CONFIG: AbrConfig = {
  ewmaSlowSec: 4,
  ewmaFastSec: 2,
  defaultEstimateBps: 250_000,
  bwFactor: 0.8,
  bwUpFactor: 0.6,
  maxStarvationDelaySec: 2,
  capBitrate: undefined,
};

/** Minimum data required for the level ladder ABR consults. */
export interface LevelInfo {
  /** Bitrate in bits/s (master playlist BANDWIDTH). */
  bitrate: number;
  /**
   * Representative segment duration (seconds). hls.js uses avg segment
   * duration; we use the variant's targetDuration when available, else 6.
   */
  avgSegmentDuration: number;
}

export interface AbandonArgs {
  /** Currently downloading level index. */
  currentLevelIdx: number;
  /** Full ladder (bitrate-ascending) of available levels. */
  levels: LevelInfo[];
  /** Seconds of media buffered ahead of consumer cursor. */
  bufferAheadSec: number;
  /** Bytes received so far on the in-flight fragment. */
  loaded: number;
  /** Total expected bytes (Content-Length or bitrate*duration estimate). */
  expectedBytes: number;
  /** ms since the request was dispatched. */
  elapsedMs: number;
  /** ms to first-byte for this request, undefined if headers not received yet. */
  ttfbMs: number | undefined;
  /** EXTINF duration of the fragment being downloaded (seconds). */
  segmentDuration: number;
}

export interface FragmentLoadStats {
  /** Total wall-clock ms from request dispatch to last byte. */
  totalMs: number;
  /** ms to first byte. */
  ttfbMs: number;
  /** Bytes received. */
  bytes: number;
}

export class AbrController {
  private readonly config: AbrConfig;
  private readonly estimator: EwmaBandWidthEstimator;
  /**
   * Floor level — once we abandon down, we won't immediately try to switch
   * back up above this level until the EWMA window relaxes the constraint
   * organically. Mirrors hls.js's `bitrateTestDelay`/abandon ceiling logic.
   */
  private abandonFloorIdx: number | undefined;
  private abandonFloorUntilSec: number;

  constructor(config: Partial<AbrConfig> = {}) {
    this.config = { ...DEFAULT_ABR_CONFIG, ...config };
    this.estimator = new EwmaBandWidthEstimator(
      this.config.ewmaSlowSec,
      this.config.ewmaFastSec,
      this.config.defaultEstimateBps,
    );
    this.abandonFloorUntilSec = 0;
  }

  // -- sampling --------------------------------------------------------------

  /** Feed a completed fragment download's stats into the estimator. */
  sampleFragmentLoad(stats: FragmentLoadStats): void {
    // hls.js samples (timeStreaming, bytes). timeStreaming = total - ttfb.
    const timeStreamingMs = Math.max(1, stats.totalMs - stats.ttfbMs);
    this.estimator.sample(timeStreamingMs, stats.bytes);
    this.estimator.sampleTTFB(stats.ttfbMs);
  }

  /**
   * Feed a *partial* (in-flight) download into the estimator.
   *
   * Called when we abandon a fragment so the estimator is pessimistic
   * about the network *immediately*, before the next selection.
   * Mirrors hls.js abr-controller.ts where the abandon path emits a sample
   * with the partial bytes and partial duration.
   */
  samplePartialLoad(loaded: number, timeStreamingMs: number): void {
    this.estimator.sample(Math.max(1, timeStreamingMs), loaded);
  }

  /** Latest bandwidth estimate in bits/s. */
  getEstimate(): number {
    return this.estimator.getEstimate();
  }

  /** Latest time-to-first-byte estimate in milliseconds. */
  getEstimateTTFB(): number {
    return this.estimator.getEstimateTTFB();
  }

  // -- level selection -------------------------------------------------------

  /**
   * Pick the level for the next segment.
   *
   * Two-pass algorithm modeled on hls.js getNextABRAutoLevel:
   *   1. Strict: maxStarvation = 0 — pick the highest level whose fetch
   *      time fits inside the existing buffer.
   *   2. Relaxed: maxStarvation = config.maxStarvationDelaySec — allow
   *      brief anticipated rebuffer to keep quality higher.
   * If both fail, return the lowest level.
   *
   * `currentLevelIdx` distinguishes stay/up-switch from down-switch for the
   * bandwidth factor (bwFactor vs bwUpFactor in hls.js).
   */
  getNextLevel(currentLevelIdx: number, levels: LevelInfo[], bufferAheadSec: number): number {
    if (levels.length === 0) return 0;
    if (levels.length === 1) return 0;

    const nowSec = performance.now() / 1000;
    if (this.abandonFloorIdx !== undefined && nowSec >= this.abandonFloorUntilSec) {
      this.abandonFloorIdx = undefined;
    }

    const maxIdx = this.effectiveMaxLevel(levels);
    const minIdx = this.abandonFloorIdx ?? 0;
    const safeMin = Math.min(minIdx, maxIdx);

    const strict = this.findBestLevel(
      levels,
      currentLevelIdx,
      safeMin,
      maxIdx,
      bufferAheadSec,
      0,
    );
    if (strict !== -1) return strict;

    const relaxed = this.findBestLevel(
      levels,
      currentLevelIdx,
      safeMin,
      maxIdx,
      bufferAheadSec,
      this.config.maxStarvationDelaySec,
    );
    if (relaxed !== -1) return relaxed;

    return safeMin; // floor of acceptable range
  }

  /**
   * The core "highest level whose fetch fits in `bufferAhead + slack`" search.
   * Mirrors hls.js findBestLevel without the codec-tier branches.
   */
  private findBestLevel(
    levels: LevelInfo[],
    currentIdx: number,
    minIdx: number,
    maxIdx: number,
    bufferAheadSec: number,
    starvationSlackSec: number,
  ): number {
    const bw = this.estimator.getEstimate();
    const ttfbSec = this.estimator.getEstimateTTFB() / 1000;
    const budget = bufferAheadSec + starvationSlackSec;

    for (let i = maxIdx; i >= minIdx; i--) {
      const level = levels[i]!;
      const factor = i > currentIdx ? this.config.bwUpFactor : this.config.bwFactor;
      const adjustedBw = bw * factor;
      const bitsPerSegment = level.bitrate * level.avgSegmentDuration;
      // Mirrors hls.js getTimeToLoadFrag: ttfb + bits/bw
      const fetchSec = ttfbSec + bitsPerSegment / adjustedBw;

      // adjustedBw must at least match this level's bitrate; otherwise even a
      // theoretical infinite-buffer scenario can't sustain this quality.
      if (adjustedBw < level.bitrate && i !== minIdx) continue;
      if (fetchSec <= budget) return i;
    }
    return -1;
  }

  private effectiveMaxLevel(levels: LevelInfo[]): number {
    const cap = this.config.capBitrate;
    if (cap === undefined) return levels.length - 1;
    let maxIdx = 0;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i]!.bitrate <= cap) maxIdx = i;
      else break;
    }
    return maxIdx;
  }

  // -- abandon ---------------------------------------------------------------

  /**
   * Inspect an in-flight download. Returns:
   *   - -1 if the download should continue
   *   - otherwise the level index to switch to (always < currentLevelIdx)
   *
   * Mirrors hls.js _abandonRulesCheck. Decisions:
   *   1. Bail early if we haven't loaded enough to measure (< half expected).
   *   2. Compute remaining seconds at observed download rate.
   *   3. For each lower level, see if a same-duration segment at *its* bitrate
   *      would finish faster than the current one is currently projected to,
   *      and inside the remaining buffer + a bit of grace.
   *   4. Pick the highest such lower level.
   */
  shouldAbandon(args: AbandonArgs): number {
    if (args.currentLevelIdx <= 0) return -1;
    if (args.ttfbMs === undefined) return -1; // headers not yet received
    if (args.expectedBytes <= 0) return -1;
    // Require at least half the fragment supposedly downloaded by now
    // (matches hls.js's behavior of waiting for sufficient signal).
    if (args.loaded * 2 < args.expectedBytes) return -1;

    const timeStreamingMs = Math.max(1, args.elapsedMs - args.ttfbMs);
    const loadRateBytesPerSec = (args.loaded * 1000) / timeStreamingMs;
    const loadRateBitsPerSec = loadRateBytesPerSec * 8;

    const ttfbSec = args.ttfbMs / 1000;
    const remainingBytes = Math.max(0, args.expectedBytes - args.loaded);
    const remainingSec = remainingBytes / loadRateBytesPerSec;
    const projectedTotalSec = ttfbSec + (args.expectedBytes * 8) / loadRateBitsPerSec;

    // If we'll comfortably finish within the buffer, no reason to abandon.
    if (remainingSec < args.bufferAheadSec) return -1;

    // Find the highest lower level whose hypothetical fetch time fits the
    // buffer-plus-segment-duration window AND is faster than the current
    // fragment's remaining time.
    const tolerance = Math.min(args.bufferAheadSec, args.segmentDuration + ttfbSec);
    let candidate = -1;
    for (let i = args.currentLevelIdx - 1; i >= 0; i--) {
      const lvl = args.levels[i]!;
      const levelBits = lvl.bitrate * args.segmentDuration;
      const levelSec = ttfbSec + levelBits / loadRateBitsPerSec;
      if (levelSec < tolerance && levelSec < projectedTotalSec) {
        candidate = i;
        break;
      }
    }
    if (candidate === -1) return -1;

    // Cement the new ceiling for a short cooldown so we don't immediately
    // try to up-switch back into the same bad network.
    this.abandonFloorIdx = candidate;
    this.abandonFloorUntilSec = performance.now() / 1000 + this.config.ewmaSlowSec;

    return candidate;
  }
}

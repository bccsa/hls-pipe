/*
 * hls-pipe — live-edge latency controller
 *
 * Inspired by hls.js src/controller/latency-controller.ts. The upstream
 * concept is: track distance from the live edge and adjust playback rate
 * (via HTMLMediaElement.playbackRate) to converge on a target latency.
 * We don't have a playbackRate — our pacing is implicit through segment
 * availability and consumer back-pressure — so this controller is reduced
 * to its tracking + ABR-input role.
 *
 * Why this exists (vs. just using StdoutSink.bufferAheadSeconds):
 *
 *   Phase-2 used `mediaSecondsWritten - wallClockElapsed` as the buffer
 *   input to ABR. That was wrong for two common consumer profiles:
 *
 *     1. Instant-drain consumer (file write, head -c, fast pipe).
 *        Wall-clock alone governed; buffer grew unbounded; ABR thought
 *        it had infinite headroom and ignored network signals.
 *
 *     2. Realtime-paced live re-streamer.
 *        The signal that *actually* matters is "how far behind the live
 *        edge are we?" — not the local wall-clock vs. media-time delta.
 *
 *   Phase-3 model:
 *     - VOD streams: pass a generous constant buffer to ABR. There is no
 *       rebuffer concept for VOD-to-stdout — extraction completes whenever
 *       it completes — so ABR should choose on bandwidth-vs-bitrate fit
 *       alone (which findBestLevel naturally does when buffer is large).
 *     - Live streams: buffer = max(0, liveSyncTargetSec - lagBehindLiveSec).
 *       As we fall behind the live edge, the buffer ABR sees shrinks,
 *       triggering down-switches. Once we're caught up, the buffer is the
 *       full target latency.
 *
 * Live-edge math:
 *   - liveTipSeq = max mediaSequence observed in any playlist reload
 *   - lagSegments = max(0, liveTipSeq - cursorSeq + 1)
 *   - lagSec     = lagSegments × targetDuration  (approximation; phase-7
 *                  will use cumulative EXTINF for accuracy)
 *
 *   Between playlist reloads, the live edge moves forward at 1×. We
 *   extrapolate by adding wall-clock-since-reload to lagSec to reflect
 *   this, capped at targetDuration (the next reload will catch up).
 */

import type { MediaPlaylist } from '../types.js';

export interface LatencyConfig {
  /**
   * Target latency from the live edge, in seconds. ABR will see this as
   * the "available buffer" when we are at the live edge.
   *
   * hls.js parallel: liveSyncDuration / liveSyncDurationCount * targetDuration.
   * HLS RFC 8216 recommends ~3× targetDuration. We default to 2× to skew
   * lower-latency for slow-network extraction use cases.
   */
  liveSyncTargetSec: number;
  /**
   * Maximum tolerated latency from the live edge. Beyond this, if
   * `skipOnStall` is set, the cursor jumps to the live edge.
   *
   * Default: 4× targetDuration — generous, fits typical broadcast windows.
   */
  liveMaxLatencySec: number;
  /**
   * If true, jump the cursor toward the live edge when lag exceeds
   * `liveMaxLatencySec`. Off by default (skipping introduces visible jumps
   * that the consumer may not want).
   */
  skipOnStall: boolean;
  /**
   * Generous synthetic buffer reported to ABR for VOD streams (seconds).
   * Large enough that ABR's findBestLevel relies solely on bandwidth fit.
   */
  vodBufferBudgetSec: number;
}

export const DEFAULT_LATENCY_CONFIG: LatencyConfig = {
  liveSyncTargetSec: 12, // overridden at runtime to 2 × targetDuration when known
  liveMaxLatencySec: 30,
  skipOnStall: false,
  vodBufferBudgetSec: 30,
};

export class LatencyController {
  private readonly config: LatencyConfig;
  private isLive = false;
  /** Highest mediaSequence we've ever seen in any playlist reload. */
  private liveTipSeq = -1;
  /** Wall-clock (ms) of the most recent playlist reload that updated liveTipSeq. */
  private liveTipObservedAtMs = 0;
  /** targetDuration of the last live playlist seen. */
  private targetDurationSec = 6;
  /** Next mediaSequence the extractor will fetch. */
  private cursorSeq = 0;

  constructor(config: Partial<LatencyConfig> = {}) {
    this.config = { ...DEFAULT_LATENCY_CONFIG, ...config };
  }

  /** Called by the extractor after each playlist reload (any variant). */
  onPlaylistUpdate(playlist: MediaPlaylist): void {
    this.targetDurationSec = playlist.targetDuration || this.targetDurationSec;
    if (!playlist.endList) {
      this.isLive = true;
      if (playlist.segments.length > 0) {
        const tip = playlist.segments[playlist.segments.length - 1]!.mediaSequence;
        if (tip > this.liveTipSeq) {
          this.liveTipSeq = tip;
          this.liveTipObservedAtMs = performance.now();
        }
      }
    } else {
      this.isLive = false;
    }
  }

  /** Called by the extractor whenever the cursor advances or is initialized. */
  setCursor(mediaSequence: number): void {
    this.cursorSeq = mediaSequence;
  }

  /**
   * Effective live-edge lag in seconds, extrapolated between reloads.
   * Returns 0 for VOD or when no live segments have been observed yet.
   */
  lagBehindLiveSec(): number {
    if (!this.isLive || this.liveTipSeq < 0) return 0;
    const lagSegments = Math.max(0, this.liveTipSeq - this.cursorSeq + 1);
    const baseLagSec = lagSegments * this.targetDurationSec;
    const sinceReloadSec = (performance.now() - this.liveTipObservedAtMs) / 1000;
    // Extrapolate: live edge moves forward at 1× between reloads, but cap the
    // extrapolation at one targetDuration (the next reload will correct it).
    const extrapolated = Math.min(sinceReloadSec, this.targetDurationSec);
    return baseLagSec + extrapolated;
  }

  /**
   * Buffer ABR should see when making a per-segment level decision.
   *
   * Live: liveSyncTarget − lagBehindLive, clamped ≥ 0.
   * VOD:  generous constant (no rebuffer constraint).
   */
  bufferForAbrSec(): number {
    if (!this.isLive) return this.config.vodBufferBudgetSec;
    const lag = this.lagBehindLiveSec();
    return Math.max(0, this.config.liveSyncTargetSec - lag);
  }

  /**
   * If skip-on-stall is enabled and we exceed the max latency, return the
   * mediaSequence to jump to. The extractor uses this to fast-forward the
   * cursor. Returns undefined if no skip should happen.
   */
  recommendedSkipTarget(liveStartOffsetSegments: number): number | undefined {
    if (!this.isLive || !this.config.skipOnStall) return undefined;
    if (this.liveTipSeq < 0) return undefined;
    const lag = this.lagBehindLiveSec();
    if (lag <= this.config.liveMaxLatencySec) return undefined;
    // Jump to N segments behind live edge.
    return Math.max(this.cursorSeq, this.liveTipSeq - liveStartOffsetSegments + 1);
  }

  /** Diagnostic snapshot for logging. */
  snapshot(): {
    isLive: boolean;
    lagSec: number;
    bufferSec: number;
    liveTipSeq: number;
    cursorSeq: number;
  } {
    return {
      isLive: this.isLive,
      lagSec: this.lagBehindLiveSec(),
      bufferSec: this.bufferForAbrSec(),
      liveTipSeq: this.liveTipSeq,
      cursorSeq: this.cursorSeq,
    };
  }

  /**
   * Auto-tune the sync target to a multiple of targetDuration when the
   * caller hasn't pinned it explicitly. Mirrors HLS RFC 8216 §6.3.3 which
   * recommends holding back >= 3× targetDuration from the live edge.
   */
  autoTuneSyncTarget(multiplier = 2): void {
    if (this.targetDurationSec > 0) {
      this.config.liveSyncTargetSec = this.targetDurationSec * multiplier;
    }
  }

  getConfig(): Readonly<LatencyConfig> {
    return this.config;
  }
}

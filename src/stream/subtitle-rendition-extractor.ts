/*
 * hls-pipe — single-rendition WebVTT subtitle extractor
 *
 * Structural mirror of `audio-rendition-extractor.ts`: one language, one
 * subtitle media playlist, segment-fetch loop with live refresh + cursor +
 * seek + cross-rendition swap. Differences:
 *
 *   - The "sink" is a per-segment `onCues` callback (no file output, no
 *     per-sample PTS plumbing). The Extractor's inline-mux path buffers cues
 *     and drains them per video segment.
 *   - The segment transform is `parseWebVttSegment(bytes, fallbackBaseTicks)`.
 *     `fallbackBaseTicks` is `playheadSec * 90000` so a WebVTT segment without
 *     an X-TIMESTAMP-MAP still lands on a plausible timeline.
 *   - No format-detection branching — we only support plain WebVTT today.
 *     fMP4-wrapped WebVTT (CMAF) is rare in HLS and can be added later.
 *
 * Inspired by hls.js src/controller/subtitle-stream-controller.ts (orchestration
 * only — hls.js writes cues into a DOM TextTrack, we feed a PES framer).
 */

import { findSegmentAtTime, parseMedia } from '../parser/m3u8-parser.js';
import type { Loader, LoaderRequest, MediaPlaylist, Segment } from '../types.js';
import type { AlternateRendition } from '../types.js';
import { parseWebVttSegment, type WebVttCue } from '../parser/webvtt-parser.js';
import { KeyCache } from '../crypt/key-cache.js';
import { decryptAes128Cbc, deriveIv, UnsupportedKeyMethodError } from '../crypt/decrypter.js';

export interface SubtitleRenditionExtractorOptions {
  rendition: AlternateRendition;
  /**
   * Called once per parsed WebVTT segment with the segment's cues + the
   * source HLS segment. Cues carry absolute 90 kHz PTS; the caller is
   * responsible for applying any further ptsShift (e.g. B-frame priming
   * shift mirrored from the inline-AV muxer).
   */
  onCues: (cues: WebVttCue[], segment: Segment) => void;
  loader: Loader;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  liveStartOffsetSegments?: number;
  pauseGate?: () => Promise<void>;
  initialPlayheadSec?: number;
}

export class SubtitleRenditionExtractor {
  private readonly opts: SubtitleRenditionExtractorOptions;
  private readonly log: (msg: string) => void;
  private readonly keyCache: KeyCache;
  private rendition: AlternateRendition;
  private playlist: MediaPlaylist | undefined;
  private isLive = false;
  private cursorMediaSequence = 0;
  private playheadSec = 0;
  private pendingRendition: AlternateRendition | undefined;
  private seekEpoch = 0;
  /**
   * Highest cue PTS already emitted via `onCues`. HLS WebVTT encoders
   * commonly include cues from the previous segment in the current segment
   * (so a player joining mid-stream doesn't miss an in-progress cue). That
   * means parsing every segment yields each cue 1-2 times. We filter cues
   * whose pts is ≤ this watermark so each cue lands downstream exactly once.
   * Reset on seek and on rendition swap.
   */
  private lastEmittedPts = -Infinity;

  constructor(opts: SubtitleRenditionExtractorOptions) {
    if (!opts.rendition.uri) throw new Error('rendition has no URI');
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
    this.keyCache = new KeyCache(opts.loader, opts.signal);
    this.rendition = opts.rendition;
  }

  setRendition(r: AlternateRendition): void {
    if (!r.uri) throw new Error('rendition has no URI');
    if (r === this.rendition && !this.pendingRendition) return;
    this.pendingRendition = r;
  }

  label(): string {
    return this.rendition.language ?? this.rendition.name;
  }

  async run(): Promise<void> {
    this.log(`subtitle[${this.label()}]: starting (${this.rendition.uri})`);
    await this.loadCurrentPlaylist();

    while (true) {
      this.throwIfAborted();
      if (this.opts.pauseGate) await this.opts.pauseGate();
      this.throwIfAborted();
      const iterationSeekEpoch = this.seekEpoch;

      if (this.pendingRendition) {
        await this.applyRenditionSwap();
      }

      const segment = this.findSegment(this.playlist!, this.cursorMediaSequence);
      if (!segment) {
        if (!this.isLive || this.playlist!.endList) {
          this.log(`subtitle[${this.label()}]: end of stream`);
          return;
        }
        const waitMs = Math.max(500, (this.playlist!.targetDuration * 1000) / 2);
        await delay(waitMs, this.opts.signal);
        await this.refreshCurrentPlaylist();
        continue;
      }

      if (segment.key && segment.key.method === 'SAMPLE-AES') {
        throw new UnsupportedKeyMethodError('SAMPLE-AES');
      }

      // EXT-X-DISCONTINUITY: the encoder may restart MPEGTS-PTS (ad insertion,
      // splice boundary, encoder restart). Cue PTS values from the new segment
      // could land below the previous high-water mark, which would cause the
      // dedup filter to drop every post-discontinuity cue. Reset the watermark
      // so the new MPEGTS domain starts fresh. The parser handles the new
      // X-TIMESTAMP-MAP correctly, so cue PTS values themselves are right —
      // only the dedup watermark needs to forget.
      if (segment.discontinuity) {
        this.log(
          `subtitle[${this.label()}]: discontinuity at seq=${segment.mediaSequence}; resetting dedup watermark`,
        );
        this.lastEmittedPts = -Infinity;
      }

      const ciphertextOrPlain = await this.fetchSegment(segment);
      const bytes = await this.maybeDecrypt(ciphertextOrPlain, segment);

      // Parse this segment. `fallbackBaseTicks = playheadSec * 90000` is the
      // anchor used when X-TIMESTAMP-MAP is missing — almost never happens for
      // production HLS subtitles, but covers hand-crafted streams.
      const fallbackBase = Math.round(this.playheadSec * 90000);
      let parsed;
      try {
        parsed = parseWebVttSegment(bytes, fallbackBase);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(
          `subtitle[${this.label()}]: failed to parse segment seq=${segment.mediaSequence} (${msg}); skipping`,
        );
        if (this.seekEpoch === iterationSeekEpoch) {
          this.cursorMediaSequence = segment.mediaSequence + 1;
          this.playheadSec += segment.duration;
        }
        continue;
      }

      // Dedupe carryover cues from the previous segment.
      const newCues = parsed.cues.filter((c) => c.pts > this.lastEmittedPts);
      if (newCues.length > 0) {
        this.opts.onCues(newCues, segment);
        this.lastEmittedPts = newCues[newCues.length - 1]!.pts;
      }

      if (this.seekEpoch === iterationSeekEpoch) {
        this.cursorMediaSequence = segment.mediaSequence + 1;
        this.playheadSec += segment.duration;
      }

      if (this.isLive && this.cursorMediaSequence > lastSeq(this.playlist!)) {
        const waitMs = Math.max(500, (this.playlist!.targetDuration * 1000) / 2);
        await delay(waitMs, this.opts.signal);
        await this.refreshCurrentPlaylist();
      }
    }
  }

  private async applyRenditionSwap(): Promise<void> {
    const target = this.pendingRendition!;
    this.pendingRendition = undefined;
    if (target === this.rendition) return;
    const oldGroup = this.rendition.groupId;
    this.log(
      `subtitle[${this.label()}]: swap rendition group=${oldGroup} → ${target.groupId} (uri=${target.uri})`,
    );
    this.rendition = target;
    // A new rendition (different language stream entirely, or different
    // group) has its own cue sequence — the watermark from the previous
    // rendition is meaningless. Allow the first cue from the new rendition
    // to pass through even if its pts happens to land at/below the old one.
    this.lastEmittedPts = -Infinity;
    await this.loadCurrentPlaylist();
    const matched = findSegmentAtTime(this.playlist!, this.playheadSec);
    if (matched) {
      this.cursorMediaSequence = matched.mediaSequence;
    } else if (this.playlist!.segments.length > 0) {
      this.cursorMediaSequence = lastSeq(this.playlist!);
    }
  }

  private async loadCurrentPlaylist(): Promise<void> {
    const fresh = await this.loadPlaylist(this.rendition.uri!);
    this.playlist = fresh;
    this.isLive = !fresh.endList;
    if (this.cursorMediaSequence === 0 && this.playheadSec === 0) {
      const startAt = this.opts.initialPlayheadSec;
      if (!this.isLive && startAt !== undefined && startAt > 0) {
        const matched = findSegmentAtTime(fresh, startAt);
        if (matched) {
          this.cursorMediaSequence = matched.mediaSequence;
          this.playheadSec = matched.startTimeSec;
        } else {
          this.cursorMediaSequence = this.initialCursor(fresh, this.isLive);
          const firstSeg = this.findSegment(fresh, this.cursorMediaSequence);
          this.playheadSec = firstSeg?.startTimeSec ?? 0;
        }
      } else {
        this.cursorMediaSequence = this.initialCursor(fresh, this.isLive);
        const firstSeg = this.findSegment(fresh, this.cursorMediaSequence);
        this.playheadSec = firstSeg?.startTimeSec ?? 0;
      }
    }
  }

  /**
   * Jump the cursor to `liveStartOffsetSegments` behind the live edge in the
   * current playlist. Called by the coordinator when the main video loop
   * triggers `--skip-on-stall`. Without this, the subtitle extractor would
   * keep fetching sequentially from far behind video and emit cues whose
   * PTS is in the past relative to the current video PTS.
   *
   * Resets the dedup watermark because the new segments are likely outside
   * the PTS range we'd been tracking. No-op on VOD.
   */
  async skipToLiveEdge(liveStartOffsetSegments: number): Promise<void> {
    if (!this.isLive) return;
    // Refresh so we see the current live tip.
    await this.refreshCurrentPlaylist();
    if (this.playlist!.segments.length === 0) return;
    const last = lastSeq(this.playlist!);
    const target = Math.max(
      this.playlist!.mediaSequence,
      last - liveStartOffsetSegments + 1,
    );
    if (target <= this.cursorMediaSequence) {
      // Already at or past the target — nothing to do.
      return;
    }
    const targetSeg = this.findSegment(this.playlist!, target);
    const newPlayhead = targetSeg?.startTimeSec ?? this.playheadSec;
    this.log(
      `subtitle[${this.label()}]: skip-to-live: seq=${this.cursorMediaSequence} → ${target} (playhead=${newPlayhead.toFixed(2)}s, dropped ${target - this.cursorMediaSequence} seg)`,
    );
    this.cursorMediaSequence = target;
    this.playheadSec = newPlayhead;
    this.lastEmittedPts = -Infinity;
    this.seekEpoch++;
  }

  async seek(timeSec: number): Promise<void> {
    if (this.isLive) {
      this.log(`subtitle[${this.label()}]: seek(${timeSec}s) ignored on live rendition`);
      return;
    }
    if (!this.playlist) await this.loadCurrentPlaylist();
    const target = findSegmentAtTime(this.playlist!, Math.max(0, timeSec));
    if (!target) {
      this.log(`subtitle[${this.label()}]: seek(${timeSec}s) past end; no-op`);
      return;
    }
    this.cursorMediaSequence = target.mediaSequence;
    this.playheadSec = target.startTimeSec;
    this.seekEpoch++;
    // Seeks can move backwards in the timeline — drop the dedup watermark.
    this.lastEmittedPts = -Infinity;
    this.log(
      `subtitle[${this.label()}]: seek → playhead=${this.playheadSec.toFixed(2)}s, seq=${this.cursorMediaSequence}`,
    );
  }

  private async refreshCurrentPlaylist(): Promise<void> {
    this.playlist = await this.loadPlaylist(this.rendition.uri!);
    this.isLive = !this.playlist.endList;
  }

  private async loadPlaylist(url: string): Promise<MediaPlaylist> {
    const req: LoaderRequest = { url, kind: 'playlist' };
    if (this.opts.signal) req.signal = this.opts.signal;
    const res = await this.opts.loader.fetch(req);
    return parseMedia(new TextDecoder('utf-8').decode(res.body), res.url);
  }

  private async fetchSegment(segment: Segment): Promise<Uint8Array> {
    const req: LoaderRequest = { url: segment.uri, kind: 'segment' };
    if (this.opts.signal) req.signal = this.opts.signal;
    if (segment.byteRange) req.byteRange = segment.byteRange;
    const res = await this.opts.loader.fetch(req);
    return res.body;
  }

  private async maybeDecrypt(bytes: Uint8Array, segment: Segment): Promise<Uint8Array> {
    const key = segment.key;
    if (!key || key.method === 'NONE') return bytes;
    if (key.method !== 'AES-128') throw new UnsupportedKeyMethodError(key.method);
    if (!key.uri) {
      throw new Error(`EXT-X-KEY METHOD=AES-128 missing URI for seq ${segment.mediaSequence}`);
    }
    const keyBytes = await this.keyCache.get(key.uri);
    const iv = key.iv ?? deriveIv(segment.mediaSequence);
    return decryptAes128Cbc(bytes, keyBytes, iv);
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

function lastSeq(playlist: MediaPlaylist): number {
  if (playlist.segments.length === 0) return playlist.mediaSequence - 1;
  return playlist.segments[playlist.segments.length - 1]!.mediaSequence;
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

/*
 * hls-pipe — single-rendition audio extractor
 *
 * Inspired by hls.js src/controller/audio-stream-controller.ts. One language,
 * one playlist, one sink. The audio coordinator owns a Map<language, this>
 * and can mid-flight swap the underlying rendition (e.g., when video ABR
 * crosses an AUDIO group boundary) via `setRendition()`.
 *
 * Phase 7.audio-abr changes:
 *   - per-rendition state moved into mutable instance fields so swaps can
 *     mutate them between iterations
 *   - playheadSec tracked alongside cursorMediaSequence so a swap can
 *     re-anchor the cursor in the new rendition's playlist via cumulative
 *     EXTINF (same machinery as phase 7b.4's cross-variant alignment)
 *   - `setRendition()` queues a swap; the next loop iteration loads the
 *     new playlist, resets format/fMP4 state, and re-anchors the cursor
 */

import { findSegmentAtTime, parseMedia } from '../parser/m3u8-parser.js';
import type { Loader, LoaderRequest, MediaPlaylist, Segment } from '../types.js';
import type { AlternateRendition } from '../types.js';
import type { FileSink } from '../output/file-sink.js';
import type { StdoutSink } from '../output/stdout-sink.js';
import { EsAudioMode } from '../output/output-mode.js';
import {
  detectAudioFormat,
  type AudioFormat,
  UnsupportedAudioFormatError,
} from './audio-format.js';
import { KeyCache } from '../crypt/key-cache.js';
import { decryptAes128Cbc, deriveIv, UnsupportedKeyMethodError } from '../crypt/decrypter.js';
import { Fmp4AudioExtractor } from '../demux/fmp4/audio.js';

type AudioSink = FileSink | StdoutSink;

export interface AudioRenditionExtractorOptions {
  rendition: AlternateRendition;
  sink: AudioSink;
  loader: Loader;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** For live streams, segments behind the live edge to start from. Default 3. */
  liveStartOffsetSegments?: number;
  /**
   * Override the detected audio format. If undefined the format is detected
   * from the first segment URI (and content if URI is ambiguous).
   */
  formatOverride?: AudioFormat;
  /**
   * Promise gate awaited at the top of each iteration. Used by the parent
   * Extractor to pause all audio extractors in lockstep with video.
   */
  pauseGate?: () => Promise<void>;
  /**
   * Initial cumulative media time (seconds) to start at. VOD-only; ignored
   * on live. When set and the playlist is VOD, the first-load cursor seeds
   * from `findSegmentAtTime(playlist, initialPlayheadSec)` instead of from
   * the playlist head.
   */
  initialPlayheadSec?: number;
}

export class AudioRenditionExtractor {
  private readonly opts: AudioRenditionExtractorOptions;
  private readonly log: (msg: string) => void;
  private readonly keyCache: KeyCache;
  // Per-rendition mutable state — replaced en-bloc on swap.
  private rendition: AlternateRendition;
  private playlist: MediaPlaylist | undefined;
  private isLive = false;
  private format: AudioFormat = 'unknown';
  private firstSegmentSeen = false;
  private fmp4Extractor = new Fmp4AudioExtractor();
  private fmp4InitUri: string | undefined;
  private tsMode = new EsAudioMode();
  // Cursor state — carries across swaps.
  private cursorMediaSequence = 0;
  private playheadSec = 0;
  // Pending swap signaled by AudioCoordinator.
  private pendingRendition: AlternateRendition | undefined;

  constructor(opts: AudioRenditionExtractorOptions) {
    if (!opts.rendition.uri) throw new Error('rendition has no URI');
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
    this.keyCache = new KeyCache(opts.loader, opts.signal);
    this.rendition = opts.rendition;
  }

  /**
   * Request a swap to a different rendition. The actual switch happens at the
   * top of the next loop iteration so any in-flight fetch completes first
   * (audio fetches are cheap; no benefit to interrupting).
   */
  setRendition(r: AlternateRendition): void {
    if (!r.uri) throw new Error('rendition has no URI');
    if (r === this.rendition && !this.pendingRendition) return;
    this.pendingRendition = r;
  }

  /** The language code or NAME for log labels. */
  label(): string {
    return this.rendition.language ?? this.rendition.name;
  }

  async run(): Promise<void> {
    this.log(`audio[${this.label()}]: starting (${this.rendition.uri})`);
    await this.loadCurrentPlaylist();

    while (true) {
      this.throwIfAborted();
      if (this.opts.pauseGate) await this.opts.pauseGate();
      this.throwIfAborted();

      if (this.pendingRendition) {
        await this.applyRenditionSwap();
      }

      const segment = this.findSegment(this.playlist!, this.cursorMediaSequence);
      if (!segment) {
        if (!this.isLive || this.playlist!.endList) {
          this.log(`audio[${this.label()}]: end of stream`);
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

      if (this.format === 'fmp4' && segment.initSection) {
        const initUri = segment.initSection.uri;
        if (initUri !== this.fmp4InitUri) {
          const initBytes = await this.fetchInit(segment.initSection);
          this.fmp4Extractor.setInit(initBytes);
          this.fmp4InitUri = initUri;
          this.log(
            `audio[${this.label()}]: loaded fMP4 init segment (${initBytes.byteLength} bytes)`,
          );
        }
      }

      const ciphertextOrPlain = await this.fetchSegment(segment);
      const bytes = await this.maybeDecrypt(ciphertextOrPlain, segment);

      // Content-sniff on the first segment if URI didn't tell us anything.
      if (!this.firstSegmentSeen) {
        const sniffed = detectAudioFormat(segment.uri, bytes);
        if (sniffed !== 'unknown' && sniffed !== this.format) {
          this.log(
            `audio[${this.label()}]: format URI-hint=${this.format} but content sniffed ${sniffed}; using ${sniffed}`,
          );
          this.format = sniffed;
        }
        if (this.format === 'fmp4' && !this.fmp4Extractor.isReady() && segment.initSection) {
          const initBytes = await this.fetchInit(segment.initSection);
          this.fmp4Extractor.setInit(initBytes);
          this.fmp4InitUri = segment.initSection.uri;
        }
        if (this.format === 'fmp4' && !this.fmp4Extractor.isReady()) {
          throw new UnsupportedAudioFormatError('fmp4', segment.uri);
        }
        this.firstSegmentSeen = true;
      }

      let out: Uint8Array;
      if (this.format === 'ts') {
        out = this.tsMode.transform(bytes);
      } else if (this.format === 'fmp4') {
        out = this.fmp4Extractor.transform(bytes);
      } else {
        out = bytes;
      }
      await this.opts.sink.write(out, segment.duration);
      this.cursorMediaSequence = segment.mediaSequence + 1;
      this.playheadSec += segment.duration;

      // For live, refresh playlist after consuming the known segments.
      if (this.isLive && this.cursorMediaSequence > lastSeq(this.playlist!)) {
        const waitMs = Math.max(500, (this.playlist!.targetDuration * 1000) / 2);
        await delay(waitMs, this.opts.signal);
        await this.refreshCurrentPlaylist();
      }
    }
  }

  // -- swap mechanics --------------------------------------------------------

  private async applyRenditionSwap(): Promise<void> {
    const target = this.pendingRendition!;
    this.pendingRendition = undefined;
    if (target === this.rendition) return;
    const oldGroup = this.rendition.groupId;
    this.log(
      `audio[${this.label()}]: swap rendition group=${oldGroup} → ${target.groupId} (uri=${target.uri})`,
    );
    this.rendition = target;
    // Reset per-rendition state — format + fMP4 init may differ in the new group.
    this.firstSegmentSeen = false;
    this.format = 'unknown';
    this.fmp4Extractor = new Fmp4AudioExtractor();
    this.fmp4InitUri = undefined;
    this.tsMode = new EsAudioMode();
    // Load the new playlist + re-anchor the cursor by playheadSec.
    await this.loadCurrentPlaylist();
    const matched = findSegmentAtTime(this.playlist!, this.playheadSec);
    if (matched) {
      this.cursorMediaSequence = matched.mediaSequence;
    } else if (this.playlist!.segments.length > 0) {
      // Past the end of the new playlist's known segments. For live this
      // means the new rendition hasn't caught up yet — start at its last
      // known segment and let the live-refresh path catch up.
      this.cursorMediaSequence = lastSeq(this.playlist!);
    }
  }

  private async loadCurrentPlaylist(): Promise<void> {
    const fresh = await this.loadPlaylist(this.rendition.uri!);
    this.playlist = fresh;
    this.isLive = !fresh.endList;
    // Re-detect format from URI hint of the first segment.
    if (this.format === 'unknown' && fresh.segments.length > 0) {
      this.format = this.opts.formatOverride ?? detectAudioFormat(fresh.segments[0]!.uri);
      if (this.format === 'unknown') this.format = 'aac';
    }
    // Initialize cursor on first-ever load (cursorMediaSequence === 0).
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
   * Re-anchor the cursor to a given cumulative media time. VOD-only — the
   * coordinator gates the call, but we still check defensively. Resets fMP4
   * init state so a fresh init is fetched if needed at the new position.
   * Caller is expected to pause the extractor first; if not, one stale
   * segment may flush before the new cursor takes effect.
   */
  async seek(timeSec: number): Promise<void> {
    if (this.isLive) {
      this.log(`audio[${this.label()}]: seek(${timeSec}s) ignored on live rendition`);
      return;
    }
    if (!this.playlist) await this.loadCurrentPlaylist();
    const target = findSegmentAtTime(this.playlist!, Math.max(0, timeSec));
    if (!target) {
      this.log(`audio[${this.label()}]: seek(${timeSec}s) past end; no-op`);
      return;
    }
    this.cursorMediaSequence = target.mediaSequence;
    this.playheadSec = target.startTimeSec;
    // Drop fMP4 init binding so the next iteration re-checks initSection;
    // also reset format-first-sniff so an unusual seek-to-front-of-stream
    // re-runs detection.
    this.fmp4InitUri = undefined;
    this.log(
      `audio[${this.label()}]: seek → playhead=${this.playheadSec.toFixed(2)}s, seq=${this.cursorMediaSequence}`,
    );
  }

  private async refreshCurrentPlaylist(): Promise<void> {
    this.playlist = await this.loadPlaylist(this.rendition.uri!);
    this.isLive = !this.playlist.endList;
  }

  // -- helpers ---------------------------------------------------------------

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

  private async fetchInit(
    init: { uri: string; byteRange?: { length: number; offset: number } },
  ): Promise<Uint8Array> {
    const req: LoaderRequest = { url: init.uri, kind: 'init' };
    if (this.opts.signal) req.signal = this.opts.signal;
    if (init.byteRange) req.byteRange = init.byteRange;
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

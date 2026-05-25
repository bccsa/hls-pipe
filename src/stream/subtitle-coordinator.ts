/*
 * hls-pipe — subtitle rendition coordinator with video-ABR-following
 *
 * Mirror of `audio-coordinator.ts` but specialised for the inline-mux path:
 *
 *   - Spawns one `SubtitleRenditionExtractor` per language.
 *   - Each extractor's `onCues` callback writes into a caller-provided per-
 *     language buffer (the `InlineSubtitleContext.cueBuffer`). The main
 *     Extractor's inline-mux step drains those buffers per video segment.
 *   - Tracks per-language rendition maps so `onVideoVariantChange()` can
 *     swap each extractor to the new variant's `subtitleGroup` mid-flight.
 *     If no rendition exists in the new group for a language we stay on the
 *     previous group for that language (same posture as audio).
 *
 * Because the user's chosen output surface is inline-mux only, there is no
 * per-file `.vtt` output and therefore no `outDir`, `fileExtension`, or
 * `FileSink` plumbing. The cue buffer IS the sink.
 */

import type { AlternateRendition, Loader, MasterPlaylist, Variant } from '../types.js';
import {
  SubtitleRenditionExtractor,
} from './subtitle-rendition-extractor.js';
import type { WebVttCue } from '../parser/webvtt-parser.js';
import type { Segment } from '../types.js';

export type SubtitleLanguageSelection = 'all' | string[];

export interface SubtitleTrackBinding {
  /** Stable language key (lowercased language or name). */
  langKey: string;
  /** Initial rendition (the one in the chosen group). */
  rendition: AlternateRendition;
  /** Called by the rendition extractor for every parsed segment's cues. */
  onCues: (cues: WebVttCue[], segment: Segment) => void;
}

export interface SubtitleCoordinatorOptions {
  master: MasterPlaylist;
  /**
   * Pre-built per-language bindings. The Extractor bootstrap picks the group
   * + assigns PIDs + creates the cue buffer, so by the time we get here every
   * language already has a definite starting rendition.
   */
  tracks: SubtitleTrackBinding[];
  /**
   * GROUP-ID we picked at bootstrap. Used to detect when video ABR moves us
   * to a variant with a different `subtitleGroup`.
   */
  initialGroup: string;
  loader: Loader;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  liveStartOffsetSegments?: number;
  pauseGate?: () => Promise<void>;
  initialPlayheadSec?: number;
}

export class SubtitleCoordinator {
  private readonly opts: SubtitleCoordinatorOptions;
  private readonly log: (msg: string) => void;
  /** Per-language map of every rendition across every group (for swap lookup). */
  private readonly languageGroups = new Map<string, Map<string, AlternateRendition>>();
  private readonly extractors = new Map<string, SubtitleRenditionExtractor>();
  private currentGroupId: string;

  constructor(opts: SubtitleCoordinatorOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
    this.currentGroupId = opts.initialGroup;
    this.buildLanguageGroups();
  }

  /**
   * Called by the main extractor when it switches video variants. Looks up
   * the new variant's `subtitleGroup` and swaps each tracked language to the
   * rendition in that group. No-op when the new group matches the current
   * one, or when the variant has no `subtitleGroup`.
   */
  onVideoVariantChange(variant: Variant): void {
    const newGroup = variant.subtitleGroup;
    if (!newGroup) return;
    if (newGroup === this.currentGroupId) return;
    this.log(
      `subtitle-coordinator: video variant subtitle group ${this.currentGroupId} → ${newGroup}`,
    );
    this.currentGroupId = newGroup;
    for (const [lang, extractor] of this.extractors) {
      const rendition = this.languageGroups.get(lang)?.get(newGroup);
      if (rendition) {
        extractor.setRendition(rendition);
      } else {
        this.log(
          `subtitle-coordinator: language=${lang} has no rendition in group=${newGroup}; staying on previous group`,
        );
      }
    }
  }

  /**
   * Re-anchor every spawned subtitle extractor to a new media-time. VOD-only.
   */
  async seek(timeSec: number): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const extractor of this.extractors.values()) {
      tasks.push(extractor.seek(timeSec));
    }
    await Promise.all(tasks);
  }

  /**
   * Fan out `--skip-on-stall` to every spawned subtitle extractor so they
   * jump to live edge alongside video. Caller is responsible for flushing
   * any buffered cues from the InlineSubtitleContext.cueBuffer — those are
   * the cues that were already drained from the rendition extractor but
   * haven't been muxed yet, and they belong to the pre-skip timeline.
   */
  async skipToLive(liveStartOffsetSegments: number): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const extractor of this.extractors.values()) {
      tasks.push(extractor.skipToLiveEdge(liveStartOffsetSegments));
    }
    await Promise.all(tasks);
  }

  async run(): Promise<void> {
    if (this.opts.tracks.length === 0) return;

    const tasks: Promise<void>[] = [];
    for (const track of this.opts.tracks) {
      const extractor = new SubtitleRenditionExtractor({
        rendition: track.rendition,
        onCues: track.onCues,
        loader: this.opts.loader,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        ...(this.opts.log ? { log: this.opts.log } : {}),
        ...(this.opts.liveStartOffsetSegments !== undefined
          ? { liveStartOffsetSegments: this.opts.liveStartOffsetSegments }
          : {}),
        ...(this.opts.pauseGate ? { pauseGate: this.opts.pauseGate } : {}),
        ...(this.opts.initialPlayheadSec !== undefined
          ? { initialPlayheadSec: this.opts.initialPlayheadSec }
          : {}),
      });
      this.extractors.set(track.langKey, extractor);
      tasks.push(extractor.run());
    }

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        const err = r.reason;
        if (err instanceof Error && err.name === 'AbortError') continue;
        throw err;
      }
    }
  }

  /**
   * Build `language → group → rendition` map across every SUBTITLES rendition
   * in the master playlist. Used for cross-group swaps. Within a group, prefer
   * the DEFAULT-marked rendition when multiple match the same language key.
   * Mirrors `AudioCoordinator.buildLanguageGroups()`.
   */
  private buildLanguageGroups(): void {
    const all = this.opts.master.subtitles.filter((r) => !!r.uri);
    // Restrict the swap map to languages we actually track (so a swap into
    // an unrelated language in the same group doesn't accidentally fire).
    const wantedLangs = new Set(this.opts.tracks.map((t) => t.langKey));

    for (const r of all) {
      const langKey = (r.language ?? r.name).toLowerCase();
      if (!wantedLangs.has(langKey)) continue;
      let groupMap = this.languageGroups.get(langKey);
      if (!groupMap) {
        groupMap = new Map();
        this.languageGroups.set(langKey, groupMap);
      }
      const existing = groupMap.get(r.groupId);
      if (!existing || (!existing.isDefault && r.isDefault)) {
        groupMap.set(r.groupId, r);
      }
    }
  }
}

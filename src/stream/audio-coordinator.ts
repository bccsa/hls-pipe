/*
 * hls-pipe — audio rendition coordinator with video-ABR-following
 *
 * Selects renditions from the master playlist's EXT-X-MEDIA TYPE=AUDIO
 * entries, spawns one AudioRenditionExtractor per selected language, and
 * writes each to its own per-language sink.
 *
 * Audio-ABR coupling (phase 7.audio-abr):
 *   HLS encodes audio quality tiers via AUDIO group IDs on EXT-X-STREAM-INF.
 *   When the main extractor's ABR switches to a video variant that declares
 *   a different AUDIO group (e.g., BCC's 144p uses `audio_mono`, 720p uses
 *   `audio_hq`), the coordinator follows: each language's rendition is
 *   swapped to the new group's URI mid-stream. The cursor re-anchors by
 *   cumulative-EXTINF (same machinery as phase 7b.4 video alignment).
 *
 *   If `preferredGroup` is set explicitly, the coordinator pins to that
 *   group for the entire session and ignores variant changes — the "static"
 *   behavior from before phase 7.audio-abr.
 */

import { join } from 'node:path';
import type { AlternateRendition, Loader, MasterPlaylist, Variant } from '../types.js';
import { FileSink } from '../output/file-sink.js';
import {
  AudioRenditionExtractor,
  type AudioRenditionExtractorOptions,
} from './audio-rendition-extractor.js';

export type AudioLanguageSelection = 'all' | string[];

export interface AudioCoordinatorOptions {
  master: MasterPlaylist;
  selection: AudioLanguageSelection;
  /** Directory where per-language files will be written. Created if missing. */
  outDir: string;
  /**
   * If set, pin to this GROUP-ID for the entire session and ignore
   * subsequent `onVideoVariantChange` notifications. Use when the user
   * explicitly wants a specific quality tier regardless of video ABR.
   */
  preferredGroup?: string;
  /**
   * Initial group when `preferredGroup` is absent. Typically the AUDIO group
   * of the variant the main extractor starts at; the coordinator follows
   * from there.
   */
  initialGroup?: string;
  loader: Loader;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  liveStartOffsetSegments?: number;
  /** Per-language file extension. Default '.aac'. */
  fileExtension?: string;
  /**
   * Promise gate awaited at the top of each rendition extractor's iteration.
   * Forwarded to every spawned AudioRenditionExtractor so pause/resume is
   * applied uniformly across video + every audio language.
   */
  pauseGate?: () => Promise<void>;
  /**
   * Initial cumulative media time (seconds) to start each rendition at.
   * VOD-only; ignored on live. Forwarded to AudioRenditionExtractor.
   */
  initialPlayheadSec?: number;
}

export class AudioCoordinator {
  private readonly opts: AudioCoordinatorOptions;
  private readonly log: (msg: string) => void;
  /** Per-language map of every rendition across every group (for swap lookup). */
  private readonly languageGroups = new Map<string, Map<string, AlternateRendition>>();
  /** Per-language live extractor (one per language, reused across group swaps). */
  private readonly extractors = new Map<string, AudioRenditionExtractor>();
  /** Currently-active group (the one extractors are bound to). */
  private currentGroupId: string | undefined;

  constructor(opts: AudioCoordinatorOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  /**
   * Called by the main extractor when it switches video variants. Looks up
   * the new variant's audioGroup and swaps each tracked language to the
   * rendition in that group. No-op when the new group matches the current
   * one, when `preferredGroup` is pinned, or when the variant has no audioGroup.
   */
  /**
   * Re-anchor every spawned rendition extractor to a new media-time. VOD-only;
   * each rendition self-guards on live. Called by the parent Extractor when
   * the user invokes `seek()`.
   */
  async seek(timeSec: number): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const extractor of this.extractors.values()) {
      tasks.push(extractor.seek(timeSec));
    }
    await Promise.all(tasks);
  }

  onVideoVariantChange(variant: Variant): void {
    if (this.opts.preferredGroup) return;
    const newGroup = variant.audioGroup;
    if (!newGroup) return;
    if (newGroup === this.currentGroupId) return;
    this.log(
      `audio-coordinator: video variant audio group ${this.currentGroupId ?? 'none'} → ${newGroup}`,
    );
    this.currentGroupId = newGroup;
    for (const [lang, extractor] of this.extractors) {
      const rendition = this.languageGroups.get(lang)?.get(newGroup);
      if (rendition) {
        extractor.setRendition(rendition);
      } else {
        this.log(
          `audio-coordinator: language=${lang} has no rendition in group=${newGroup}; staying on previous group`,
        );
      }
    }
  }

  async run(): Promise<void> {
    // 1. Build the language × group rendition map.
    this.buildLanguageGroups();
    if (this.languageGroups.size === 0) {
      this.log('audio-coordinator: no matching renditions; nothing to do');
      return;
    }

    // 2. Resolve the initial group.
    this.currentGroupId = this.resolveInitialGroup();
    if (!this.currentGroupId) {
      this.log('audio-coordinator: no audio group resolvable; nothing to do');
      return;
    }
    this.log(
      `audio-coordinator: extracting ${this.languageGroups.size} language(s), starting group=${this.currentGroupId}${this.opts.preferredGroup ? ' (pinned)' : ' (follows video ABR)'} → ${this.opts.outDir}`,
    );

    // 3. Construct one extractor per language for the initial group.
    const tasks: Array<{ extractor: AudioRenditionExtractor; sink: FileSink; path: string; lang: string }> = [];
    for (const [lang, groupMap] of this.languageGroups) {
      const rendition = groupMap.get(this.currentGroupId);
      if (!rendition) {
        this.log(`audio-coordinator: language=${lang} missing in initial group; skipped`);
        continue;
      }
      const ext = this.opts.fileExtension ?? '.aac';
      const filename = renditionFilename(lang, ext);
      const path = join(this.opts.outDir, filename);
      const sink = await FileSink.open(path);
      const extOpts: AudioRenditionExtractorOptions = {
        rendition,
        sink,
        loader: this.opts.loader,
      };
      if (this.opts.signal) extOpts.signal = this.opts.signal;
      if (this.opts.log) extOpts.log = this.opts.log;
      if (this.opts.liveStartOffsetSegments !== undefined) {
        extOpts.liveStartOffsetSegments = this.opts.liveStartOffsetSegments;
      }
      if (this.opts.pauseGate) extOpts.pauseGate = this.opts.pauseGate;
      if (this.opts.initialPlayheadSec !== undefined) {
        extOpts.initialPlayheadSec = this.opts.initialPlayheadSec;
      }
      const extractor = new AudioRenditionExtractor(extOpts);
      this.extractors.set(lang, extractor);
      tasks.push({ extractor, sink, path, lang });
    }

    // 4. Run all extractors concurrently.
    const results = await Promise.allSettled(
      tasks.map(async ({ extractor, sink, path, lang }) => {
        try {
          await extractor.run();
        } finally {
          await sink.end().catch(() => undefined);
        }
        this.log(`audio[${lang}]: closed → ${path}`);
      }),
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        const err = r.reason;
        if (err instanceof Error && err.name === 'AbortError') continue;
        throw err;
      }
    }
  }

  private buildLanguageGroups(): void {
    const all = this.opts.master.audio.filter((r) => !!r.uri);
    if (all.length === 0) return;

    const matchesSelection = (r: AlternateRendition): boolean => {
      if (this.opts.selection === 'all') return true;
      const wanted = new Set(this.opts.selection.map((l) => l.toLowerCase()));
      const langs: string[] = [];
      if (r.language) langs.push(r.language.toLowerCase());
      if (r.name) langs.push(r.name.toLowerCase());
      return langs.some((l) => wanted.has(l));
    };

    for (const r of all) {
      if (!matchesSelection(r)) continue;
      const langKey = (r.language ?? r.name).toLowerCase();
      let groupMap = this.languageGroups.get(langKey);
      if (!groupMap) {
        groupMap = new Map();
        this.languageGroups.set(langKey, groupMap);
      }
      // Prefer DEFAULT-marked rendition if multiple in the same group match.
      const existing = groupMap.get(r.groupId);
      if (!existing || (!existing.isDefault && r.isDefault)) {
        groupMap.set(r.groupId, r);
      }
    }
  }

  private resolveInitialGroup(): string | undefined {
    if (this.opts.preferredGroup) return this.opts.preferredGroup;
    if (this.opts.initialGroup) {
      // Verify the initial group covers at least one of our languages.
      for (const groupMap of this.languageGroups.values()) {
        if (groupMap.has(this.opts.initialGroup)) return this.opts.initialGroup;
      }
    }
    // Fallback: pick the group with the most language coverage.
    const groupCounts = new Map<string, number>();
    for (const groupMap of this.languageGroups.values()) {
      for (const groupId of groupMap.keys()) {
        groupCounts.set(groupId, (groupCounts.get(groupId) ?? 0) + 1);
      }
    }
    let best: string | undefined;
    let bestCount = -1;
    for (const [g, c] of groupCounts) {
      if (c > bestCount) {
        bestCount = c;
        best = g;
      }
    }
    return best;
  }
}

/**
 * Pure selection helper exported for tests + library users. Returns the
 * deduped per-language rendition list in a single chosen group, mirroring
 * the pre-7.audio-abr behavior used by external consumers of the API.
 */
export function selectAudioRenditions(
  master: MasterPlaylist,
  selection: AudioLanguageSelection,
  preferredGroup?: string,
): AlternateRendition[] {
  const all = master.audio.filter((r) => !!r.uri);
  if (all.length === 0) return [];

  let candidates = all;
  if (selection !== 'all') {
    const wanted = new Set(selection.map((l) => l.toLowerCase()));
    candidates = all.filter((r) => {
      const langs: string[] = [];
      if (r.language) langs.push(r.language.toLowerCase());
      if (r.name) langs.push(r.name.toLowerCase());
      return langs.some((l) => wanted.has(l));
    });
  }
  if (candidates.length === 0) return [];

  let group = preferredGroup;
  if (!group) {
    const counts = new Map<string, number>();
    for (const r of candidates) counts.set(r.groupId, (counts.get(r.groupId) ?? 0) + 1);
    let bestCount = -1;
    for (const [g, c] of counts) {
      if (c > bestCount) {
        bestCount = c;
        group = g;
      }
    }
  }
  if (group) candidates = candidates.filter((r) => r.groupId === group);

  const dedup = new Map<string, AlternateRendition>();
  for (const r of candidates) {
    const key = (r.language ?? r.name).toLowerCase();
    const existing = dedup.get(key);
    if (!existing) dedup.set(key, r);
    else if (!existing.isDefault && r.isDefault) dedup.set(key, r);
  }
  return Array.from(dedup.values());
}

function renditionFilename(languageKey: string, ext: string): string {
  // Normalize the language label for safe filenames. (Pre-7.audio-abr we
  // appended the rendition NAME too; now that group can swap mid-stream
  // the NAME is unstable, so we use the language key only.)
  const slug = languageKey.replace(/[^a-z0-9._-]+/g, '-');
  return `audio-${slug}${ext}`;
}

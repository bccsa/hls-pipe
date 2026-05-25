/*
 * hls-pipe — rendition filtering helpers
 *
 * Small pure helpers for picking renditions by attributes. Used by the audio
 * coordinator + inline-audio path to default to stereo+ groups when the
 * master offers both mono and stereo.
 *
 * The CHANNELS attribute on EXT-X-MEDIA is a quoted-string per RFC 8216 §4.3.4.1.1.
 * The first comma-separated parameter is the channel count as a decimal
 * integer (e.g., "1" = mono, "2" = stereo, "6" = 5.1 surround). Subsequent
 * parameters describe spatial / object-based properties. We only inspect the
 * first parameter and treat absent CHANNELS as "unknown — don't filter".
 */

import type { AlternateRendition } from '../types.js';

/** Parse the first parameter of CHANNELS as an integer. Returns undefined when absent. */
export function renditionMaxChannels(r: AlternateRendition): number | undefined {
  if (!r.channels) return undefined;
  const head = r.channels.split(',')[0]?.trim();
  if (!head) return undefined;
  const n = parseInt(head, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** True if the rendition explicitly declares 1-channel audio. */
export function isMonoRendition(r: AlternateRendition): boolean {
  return renditionMaxChannels(r) === 1;
}

/**
 * True if at least one rendition in the group is multichannel (2+).
 * Returns false for groups that are entirely mono OR for groups whose
 * renditions don't carry CHANNELS (in which case we can't tell — caller
 * decides whether to include).
 */
export function groupHasStereo(renditions: AlternateRendition[]): boolean {
  for (const r of renditions) {
    const ch = renditionMaxChannels(r);
    if (ch !== undefined && ch >= 2) return true;
  }
  return false;
}

/**
 * True if EVERY rendition in the group declares CHANNELS=1.
 *   - All-mono group (entirely declared as mono) → true
 *   - Mixed group → false (at least one stereo+)
 *   - Group with no CHANNELS info → false (conservative — don't reject)
 */
export function groupIsAllMono(renditions: AlternateRendition[]): boolean {
  if (renditions.length === 0) return false;
  let hasMono = false;
  for (const r of renditions) {
    const ch = renditionMaxChannels(r);
    if (ch === undefined) return false; // unknown, don't classify as mono
    if (ch !== 1) return false;
    hasMono = true;
  }
  return hasMono;
}

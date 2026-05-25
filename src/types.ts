/*
 * hls-pipe — shared types
 *
 * Inspired by hls.js types in src/types/*.ts. These are minimal phase-1
 * counterparts; the upstream definitions carry more fields than we use.
 *
 * Upstream references:
 *   - src/loader/level-details.ts        (LevelDetails)
 *   - src/loader/fragment.ts             (Fragment, Part)
 *   - src/types/loader.ts                (Loader contract, stats)
 *   - src/types/level.ts                 (Level, LevelAttributes)
 *   - src/types/media-playlist.ts        (MediaPlaylist)
 */

/** A single video/audio variant from a master playlist (EXT-X-STREAM-INF). */
export interface Variant {
  uri: string; // absolute URL of the media playlist
  bitrate: number; // BANDWIDTH attribute, bits per second
  averageBitrate?: number; // AVERAGE-BANDWIDTH if present
  codecs?: string; // CODECS attribute (raw)
  resolution?: { width: number; height: number };
  frameRate?: number;
  audioGroup?: string; // AUDIO group id, links to AlternateRendition[]
  subtitleGroup?: string;
  name?: string;
}

/** An EXT-X-MEDIA entry (alternate audio / subtitles / closed captions). */
export interface AlternateRendition {
  type: 'AUDIO' | 'SUBTITLES' | 'CLOSED-CAPTIONS' | 'VIDEO';
  groupId: string;
  name: string;
  language?: string;
  assocLanguage?: string;
  isDefault: boolean;
  autoselect: boolean;
  forced: boolean;
  characteristics?: string;
  channels?: string;
  uri?: string; // absent for CLOSED-CAPTIONS
}

/** A parsed master (multivariant) playlist. */
export interface MasterPlaylist {
  variants: Variant[];
  audio: AlternateRendition[];
  subtitles: AlternateRendition[];
  closedCaptions: AlternateRendition[];
  /** Independent segments hint (EXT-X-INDEPENDENT-SEGMENTS). */
  independentSegments: boolean;
}

/** A single segment in a media playlist (EXTINF line). */
export interface Segment {
  /** 0-indexed position in the playlist as loaded, NOT mediaSequence. */
  index: number;
  /** EXT-X-MEDIA-SEQUENCE + index — stable across playlist reloads for live. */
  mediaSequence: number;
  uri: string; // absolute URL
  duration: number; // EXTINF duration in seconds
  /**
   * Cumulative start time in seconds from the playlist's first segment,
   * computed as the running sum of prior EXTINF durations. Stable across the
   * playlist (does NOT account for sliding-window shifts in live playlists)
   * but useful for cross-variant alignment in VOD where variants share an
   * absolute media-time origin even when their mediaSequence numbers differ.
   */
  startTimeSec: number;
  title?: string;
  byteRange?: { length: number; offset: number };
  discontinuity: boolean; // EXT-X-DISCONTINUITY directly before this segment
  /** EXT-X-MAP for this segment (initialization section), if any. */
  initSection?: { uri: string; byteRange?: { length: number; offset: number } };
  /** Encryption key applying to this segment, if any. */
  key?: SegmentKey;
  /** EXT-X-PROGRAM-DATE-TIME if present. */
  programDateTime?: number; // ms since epoch
}

export interface SegmentKey {
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES';
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
  keyFormatVersions?: string;
}

/** A parsed media playlist (variant or alternate rendition). */
export interface MediaPlaylist {
  /** Absolute URL the playlist was loaded from. Used to resolve relative URIs. */
  uri: string;
  version: number;
  targetDuration: number;
  mediaSequence: number;
  discontinuitySequence: number;
  /** true if EXT-X-ENDLIST is present (VOD or terminated live). */
  endList: boolean;
  /** EXT-X-PLAYLIST-TYPE if set. */
  playlistType?: 'VOD' | 'EVENT';
  segments: Segment[];
  /** Total duration sum of EXTINF — for VOD, this is the asset duration. */
  totalDuration: number;
}

// -- Loader contract --------------------------------------------------------

/** What the loader is fetching. Influences retry policy & log labels. */
export type LoaderRequestKind = 'manifest' | 'playlist' | 'segment' | 'key' | 'init';

export interface LoaderRequest {
  url: string;
  kind: LoaderRequestKind;
  byteRange?: { length: number; offset: number };
  /** Abort signal — host wires this from AbortController.signal. */
  signal?: AbortSignal;
  /** Optional per-request timeout override (ms). */
  timeoutMs?: number;
}

export interface LoaderProgress {
  /** Bytes received so far. Updated as the body streams in. */
  loaded: number;
  /** Total bytes expected (from Content-Length), or undefined if chunked/unknown. */
  total: number | undefined;
  /** Wall-clock ms since the loader started this request. */
  elapsedMs: number;
  /** Time-to-first-byte in ms, populated once the first byte arrives. */
  ttfbMs: number | undefined;
}

export interface LoaderResult {
  url: string; // final URL after redirects
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  stats: {
    ttfbMs: number;
    totalMs: number;
    bytes: number;
  };
}

/**
 * The host-facing Loader contract.
 *
 * Modeled on hls.js src/types/loader.ts Loader<T>. Differences:
 *   - returns a Promise instead of using callbacks
 *   - exposes a separate `onProgress` so ABR can observe in-flight downloads
 *   - aborts via AbortSignal rather than a .abort() method
 *
 * Implementations: see src/loader/node-loader.ts (default, uses global fetch).
 */
export interface Loader {
  fetch(req: LoaderRequest, onProgress?: (p: LoaderProgress) => void): Promise<LoaderResult>;
}

/*
 * hls-pipe — variant playlist cache
 *
 * For ABR we need to switch between variants without re-fetching their media
 * playlists from scratch every time. Inspired by hls.js src/loader/level-controller.ts
 * which keeps per-level Level objects with their LevelDetails cached and refreshed
 * on a schedule for live streams.
 *
 * Phase 2 scope:
 *   - cache one MediaPlaylist per variant URL
 *   - for VOD (endList=true), cache forever
 *   - for live, mark cache stale after targetDuration/2 ms
 */

import { parseMedia } from '../parser/m3u8-parser.js';
import type { Loader, LoaderRequest, MediaPlaylist, Variant } from '../types.js';

interface CachedEntry {
  playlist: MediaPlaylist;
  fetchedAt: number; // performance.now() ms
}

export class PlaylistCache {
  private readonly cache = new Map<string, CachedEntry>();

  constructor(
    private readonly loader: Loader,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Return the playlist for a variant, fetching it if absent or stale (live).
   * For VOD playlists (endList=true) we never re-fetch.
   */
  async get(variant: Variant): Promise<MediaPlaylist> {
    const cached = this.cache.get(variant.uri);
    if (cached && !this.isStale(cached)) return cached.playlist;
    return this.refresh(variant);
  }

  async refresh(variant: Variant): Promise<MediaPlaylist> {
    const req: LoaderRequest = { url: variant.uri, kind: 'playlist' };
    if (this.signal) req.signal = this.signal;
    const res = await this.loader.fetch(req);
    const text = new TextDecoder('utf-8').decode(res.body);
    const playlist = parseMedia(text, res.url);
    this.cache.set(variant.uri, { playlist, fetchedAt: performance.now() });
    return playlist;
  }

  private isStale(entry: CachedEntry): boolean {
    if (entry.playlist.endList) return false;
    // HLS recommends reloading after targetDuration / 2 for live (RFC 8216 §6.3.4).
    const maxAgeMs = Math.max(1000, (entry.playlist.targetDuration * 1000) / 2);
    return performance.now() - entry.fetchedAt > maxAgeMs;
  }
}

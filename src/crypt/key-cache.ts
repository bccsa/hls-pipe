/*
 * hls-pipe — AES key cache
 *
 * Fresh module. Fetches AES-128 keys via the existing Loader and caches by
 * URI so live streams that reference the same EXT-X-KEY URI repeatedly only
 * pay the network cost once.
 *
 * hls.js parallel: src/loader/key-loader.ts — also URI-keyed, but their
 * caching is bound to the larger Fragment lifecycle. Ours is simpler.
 */

import type { Loader, LoaderRequest } from '../types.js';
import { DecryptError } from './decrypter.js';

export class KeyCache {
  private readonly cache = new Map<string, Promise<Uint8Array>>();

  constructor(
    private readonly loader: Loader,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Fetch + cache the 16-byte AES-128 key at the given URI. Returns the same
   * Promise on subsequent calls so concurrent fetches dedupe naturally.
   */
  get(uri: string): Promise<Uint8Array> {
    const cached = this.cache.get(uri);
    if (cached) return cached;
    const promise = this.fetch(uri).catch((err) => {
      // Don't cache failures — the next call should retry.
      this.cache.delete(uri);
      throw err;
    });
    this.cache.set(uri, promise);
    return promise;
  }

  private async fetch(uri: string): Promise<Uint8Array> {
    const req: LoaderRequest = { url: uri, kind: 'key' };
    if (this.signal) req.signal = this.signal;
    const res = await this.loader.fetch(req);
    if (res.body.byteLength !== 16) {
      throw new DecryptError(
        `AES-128 key at ${uri} must be 16 bytes, got ${res.body.byteLength}`,
      );
    }
    return res.body;
  }
}

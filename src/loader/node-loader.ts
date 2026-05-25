/*
 * hls-pipe — Node.js HTTP loader
 *
 * Implements the `Loader` contract from src/types.ts using Node's global
 * fetch (Node 20+). Streaming body read with per-chunk progress reporting
 * is required so future ABR can abort slow downloads mid-flight. This is the
 * same property that hls.js's src/utils/fetch-loader.ts FetchLoader provides
 * via its onProgress callback path.
 *
 * Differences from hls.js's fetch-loader:
 *   - returns a Promise, not callback-based
 *   - AbortSignal-driven cancellation
 *   - retry policy lives outside the loader (callers wrap as needed)
 */

import type { Loader, LoaderProgress, LoaderRequest, LoaderResult } from '../types.js';
import { backoffMs, DEFAULT_RETRY, isRetryable, sleep, type RetryPolicy } from './retry.js';

export interface NodeLoaderOptions {
  /** Default timeout for any single request (ms). */
  timeoutMs?: number;
  /** Retry policy applied around each fetch. */
  retry?: RetryPolicy;
  /** Optional User-Agent header. */
  userAgent?: string;
  /** Additional headers applied to every request. */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class NodeLoader implements Loader {
  private readonly opts: Required<Omit<NodeLoaderOptions, 'headers' | 'userAgent'>> & {
    headers: Record<string, string>;
    userAgent: string | undefined;
  };

  constructor(opts: NodeLoaderOptions = {}) {
    this.opts = {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: opts.retry ?? DEFAULT_RETRY,
      headers: opts.headers ?? {},
      userAgent: opts.userAgent,
    };
  }

  async fetch(req: LoaderRequest, onProgress?: (p: LoaderProgress) => void): Promise<LoaderResult> {
    let lastError: unknown;
    const maxAttempts = this.opts.retry.maxRetries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.attempt(req, onProgress);
      } catch (err) {
        lastError = err;
        // Caller aborted — propagate immediately.
        if (err instanceof Error && err.name === 'AbortError') throw err;

        const retryable =
          err instanceof HttpError ? isRetryable(err.status) : isRetryable(err as Error);
        const isLast = attempt === maxAttempts - 1;
        if (!retryable || isLast) throw err;

        const delay = backoffMs(this.opts.retry, attempt);
        await sleep(delay, req.signal);
      }
    }
    throw lastError;
  }

  private async attempt(
    req: LoaderRequest,
    onProgress?: (p: LoaderProgress) => void,
  ): Promise<LoaderResult> {
    const startedAt = performance.now();
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs;
    const timeoutCtrl = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutCtrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);

    // Compose host signal + timeout signal
    const signal = anySignal(req.signal, timeoutCtrl.signal);

    const headers: Record<string, string> = { ...this.opts.headers };
    if (this.opts.userAgent && !('User-Agent' in headers)) {
      headers['User-Agent'] = this.opts.userAgent;
    }
    if (req.byteRange) {
      const { offset, length } = req.byteRange;
      // HTTP Range is inclusive on both ends.
      headers['Range'] = `bytes=${offset}-${offset + length - 1}`;
    }

    let response: Response;
    try {
      response = await fetch(req.url, { headers, signal });
    } finally {
      clearTimeout(timeoutTimer);
    }

    const ttfbMs = performance.now() - startedAt;
    if (!response.ok && !(req.byteRange && response.status === 206)) {
      // Drain & throw — Body must be consumed even on error.
      try {
        await response.arrayBuffer();
      } catch {
        // swallow
      }
      throw new HttpError(response.status, `HTTP ${response.status} for ${req.url}`);
    }

    const total = parseContentLength(response.headers.get('content-length'));
    const body = response.body;

    if (!body) {
      // No streaming body — shouldn't happen with fetch, but be defensive.
      const buf = new Uint8Array(await response.arrayBuffer());
      const totalMs = performance.now() - startedAt;
      onProgress?.({ loaded: buf.byteLength, total, elapsedMs: totalMs, ttfbMs });
      return {
        url: response.url,
        status: response.status,
        headers: headerMap(response.headers),
        body: buf,
        stats: { ttfbMs, totalMs, bytes: buf.byteLength },
      };
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          loaded += value.byteLength;
          onProgress?.({ loaded, total, elapsedMs: performance.now() - startedAt, ttfbMs });
        }
      }
    } catch (err) {
      try {
        reader.cancel(err).catch(() => undefined);
      } catch {
        // swallow
      }
      throw err;
    }

    const totalMs = performance.now() - startedAt;
    const buf = concat(chunks, loaded);
    return {
      url: response.url,
      status: response.status,
      headers: headerMap(response.headers),
      body: buf,
      stats: { ttfbMs, totalMs, bytes: buf.byteLength },
    };
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function parseContentLength(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function headerMap(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function concat(chunks: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Combine multiple AbortSignals into one. Node 20 lacks AbortSignal.any in older releases. */
function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0]!;
  // Prefer the platform implementation if available
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
  }
  const ctrl = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

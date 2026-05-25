/*
 * hls-pipe — retry policy
 *
 * Inspired by hls.js src/utils/error-helper.ts retry logic. The defaults here
 * are conservative for slow / unstable networks: exponential backoff with
 * jitter, low ceiling so we don't sit blocked on a dead segment forever.
 */

export interface RetryPolicy {
  /** Maximum retry attempts after the initial try. 0 = no retries. */
  maxRetries: number;
  /** Initial backoff delay in ms. */
  initialDelayMs: number;
  /** Backoff growth factor; delay = initial * factor^attempt. */
  factor: number;
  /** Cap on a single backoff delay (ms). */
  maxDelayMs: number;
  /** Random jitter fraction added to each delay (0..1). */
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 4,
  initialDelayMs: 200,
  factor: 2,
  maxDelayMs: 5_000,
  jitter: 0.3,
};

export function backoffMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.initialDelayMs * Math.pow(policy.factor, attempt);
  const capped = Math.min(raw, policy.maxDelayMs);
  const jitter = capped * policy.jitter * Math.random();
  return capped + jitter;
}

/** Whether a given HTTP status / error is worth retrying. */
export function isRetryable(statusOrError: number | Error): boolean {
  if (statusOrError instanceof Error) {
    // Network-level: AbortError must NOT be retried (caller cancelled).
    if (statusOrError.name === 'AbortError') return false;
    return true;
  }
  // HTTP: 408 (request timeout), 425 (too early), 429 (rate limit), 5xx
  return (
    statusOrError === 408 ||
    statusOrError === 425 ||
    statusOrError === 429 ||
    (statusOrError >= 500 && statusOrError < 600)
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

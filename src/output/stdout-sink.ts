/*
 * hls-pipe — stdout sink with back-pressure
 *
 * Phase 1: a thin async-wrapped wrapper around process.stdout.write that
 * honors the drain event. Back-pressure from the downstream consumer
 * (typically a piped ffmpeg) flows backwards into the fragment scheduler:
 * if stdout blocks, the next fragment fetch is delayed.
 *
 * Phase 7b.6: optional bounded internal queue. HLS segments arrive in bursts
 * (whole segment fetched in 1s, then nothing for ~5s until the next segment
 * publishes). Without buffering between us and the consumer, the consumer's
 * own packet queues drain during the gap — players like ffplay underrun. A
 * bounded internal queue smooths the bursts: `write()` returns as soon as
 * bytes are enqueued, a single drain task feeds the underlying stream
 * continuously, and `write()` only blocks once the queue exceeds its limit.
 *
 * In later phases this becomes the input to the "virtual buffer" clock that
 * the ABR controller reads as `bufferStarvationDelay`. The relationship is:
 *   media-time-written (sum of segment durations we've flushed to stdout)
 *   minus
 *   media-time-read (estimated from elapsed wall-clock since the consumer
 *                    started reading, since ffmpeg consumes a TS pipe at 1x).
 */

import type { Writable } from 'node:stream';

export interface SinkStats {
  /** Total bytes written and acknowledged by the underlying stream. */
  bytesWritten: number;
  /** Total media-time (sum of segment durations) committed. */
  mediaSecondsWritten: number;
  /** Wall-clock timestamp (ms since session start) of last successful write. */
  lastWriteAt: number;
}

export interface StdoutSinkOptions {
  /**
   * Maximum bytes held in the internal smoothing queue. When > 0, `write()`
   * returns as soon as bytes are enqueued (until the limit is reached) and a
   * background task drains the queue to the underlying stream. Set to 0 (the
   * default for backwards-compat in tests) to disable buffering — `write()`
   * then writes synchronously, honoring drain events as before.
   */
  bufferLimitBytes?: number;
}

interface QueueEntry {
  chunk: Uint8Array;
  mediaSeconds: number;
}

export class StdoutSink {
  private readonly out: Writable;
  private readonly stats: SinkStats = { bytesWritten: 0, mediaSecondsWritten: 0, lastWriteAt: 0 };
  private readonly startedAt = performance.now();
  private closed = false;

  private readonly bufferLimitBytes: number;
  private readonly queue: QueueEntry[] = [];
  private queueBytes = 0;
  private readonly waiters: (() => void)[] = [];
  private drainErr: Error | undefined;
  private drainTask: Promise<void> | undefined;

  constructor(out: Writable = process.stdout, opts: StdoutSinkOptions = {}) {
    this.out = out;
    this.bufferLimitBytes = opts.bufferLimitBytes ?? 0;
  }

  getStats(): Readonly<SinkStats> {
    return this.stats;
  }

  /** Bytes currently held in the smoothing queue (not yet written downstream). */
  getQueuedBytes(): number {
    return this.queueBytes;
  }

  /**
   * Estimated wall-clock seconds the downstream consumer is "behind" what we
   * have written. Phase 1 uses simple assumption: the consumer reads at 1x
   * realtime starting from our first write. Phase 3 replaces this with a
   * measured estimate, but the contract is what ABR will consume.
   */
  bufferAheadSeconds(): number {
    if (this.stats.bytesWritten === 0) return 0;
    const elapsedSec = (performance.now() - this.startedAt) / 1000;
    return Math.max(0, this.stats.mediaSecondsWritten - elapsedSec);
  }

  /**
   * Write a fragment. With `bufferLimitBytes = 0` (default), writes go
   * straight to the underlying stream and honor its drain event. With
   * `bufferLimitBytes > 0`, the chunk is enqueued and a background drain task
   * feeds the stream — `write()` only awaits once the queue exceeds the
   * limit.
   *
   * `mediaSeconds` is the segment's EXTINF duration — used for buffer math.
   */
  async write(chunk: Uint8Array, mediaSeconds: number): Promise<void> {
    if (this.closed) throw new Error('sink is closed');
    if (this.drainErr) throw this.drainErr;

    if (this.bufferLimitBytes <= 0) {
      return this.directWrite(chunk, mediaSeconds);
    }

    // Wait for room. Always allow at least one chunk through to avoid
    // deadlock when a single chunk exceeds the limit.
    while (this.queueBytes > 0 && this.queueBytes + chunk.byteLength > this.bufferLimitBytes) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.closed) throw new Error('sink is closed');
      if (this.drainErr) throw this.drainErr;
    }

    this.queue.push({ chunk, mediaSeconds });
    this.queueBytes += chunk.byteLength;

    if (!this.drainTask) {
      this.drainTask = this.runDrainLoop();
    }
  }

  private async runDrainLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const entry = this.queue[0]!;
        // Keep the chunk accounted as "queued" until it's actually written
        // downstream — otherwise the in-flight chunk wouldn't count against
        // bufferLimitBytes and backpressure on the next write would misfire.
        await this.directWrite(entry.chunk, entry.mediaSeconds);
        this.queue.shift();
        this.queueBytes -= entry.chunk.byteLength;
        // Wake writers waiting on queue space.
        while (this.waiters.length > 0) this.waiters.shift()!();
      }
    } catch (err) {
      this.drainErr = err instanceof Error ? err : new Error(String(err));
      while (this.waiters.length > 0) this.waiters.shift()!();
    } finally {
      this.drainTask = undefined;
    }
  }

  private async directWrite(chunk: Uint8Array, mediaSeconds: number): Promise<void> {
    if (chunk.byteLength === 0) {
      this.stats.mediaSecondsWritten += mediaSeconds;
      return;
    }
    const ok = this.out.write(chunk);
    if (!ok) {
      await this.waitForDrainEvent();
    }
    this.stats.bytesWritten += chunk.byteLength;
    this.stats.mediaSecondsWritten += mediaSeconds;
    this.stats.lastWriteAt = performance.now();
  }

  private waitForDrainEvent(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        this.out.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.out.off('drain', onDrain);
        reject(err);
      };
      this.out.once('drain', onDrain);
      this.out.once('error', onError);
    });
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Flush any queued bytes before closing.
    if (this.drainTask) {
      try {
        await this.drainTask;
      } catch {
        // surfaced via drainErr on next write
      }
    }
    if (this.out === process.stdout || this.out === process.stderr) {
      // Don't end the standard streams — they'll be closed on process exit.
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

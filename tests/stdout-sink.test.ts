/*
 * hls-pipe — StdoutSink (buffered + unbuffered modes)
 *
 * The buffered mode exists to smooth HLS's bursty per-segment writes into a
 * continuous downstream byte stream — without it, ffplay's internal packet
 * queues drain between segments and the user sees periodic stutters. These
 * tests use a slow-draining mock Writable to verify the queue semantics.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Writable } from 'node:stream';
import { StdoutSink } from '../src/output/stdout-sink.js';

/**
 * Mock Writable that defers each `_write` callback until `drainNow()` is
 * called — so the Writable's internal queue grows past highWaterMark and
 * `write()` returns false. Lets tests simulate a slow consumer driving real
 * backpressure (with synchronous cb the buffer would empty immediately and
 * the mock wouldn't actually be slow).
 */
class SlowSink extends Writable {
  public written: Uint8Array[] = [];
  private pendingCbs: ((err?: Error | null) => void)[] = [];
  constructor(highWater = 64) {
    super({ highWaterMark: highWater });
  }
  override _write(
    chunk: Uint8Array,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.written.push(chunk);
    this.pendingCbs.push(cb);
  }
  /** Pretend the consumer drained — call all pending callbacks. */
  drainNow(): void {
    const cbs = this.pendingCbs;
    this.pendingCbs = [];
    for (const cb of cbs) cb();
  }
  totalBytes(): number {
    return this.written.reduce((acc, c) => acc + c.byteLength, 0);
  }
}

describe('StdoutSink (no buffering)', () => {
  it('writes pass through directly when bufferLimitBytes = 0', async () => {
    const out = new SlowSink(1024 * 1024); // generous HWM
    const sink = new StdoutSink(out, { bufferLimitBytes: 0 });
    await sink.write(new Uint8Array([1, 2, 3, 4]), 1);
    assert.equal(sink.getStats().bytesWritten, 4);
    assert.equal(sink.getQueuedBytes(), 0);
  });
});

describe('StdoutSink (buffered)', () => {
  it('returns immediately when there is queue space', async () => {
    const out = new SlowSink(8);
    const sink = new StdoutSink(out, { bufferLimitBytes: 1024 });
    const chunk = new Uint8Array(100);
    const start = performance.now();
    await sink.write(chunk, 1);
    const elapsed = performance.now() - start;
    // Should not block on the slow sink — the queue absorbs it.
    assert.ok(elapsed < 50, `write took ${elapsed}ms but should be sub-50ms`);
    // The chunk is enqueued (and possibly already partway through drain).
    out.drainNow();
  });

  it('blocks new writes once queue exceeds limit, unblocks after drain', async () => {
    const out = new SlowSink(8);
    const sink = new StdoutSink(out, { bufferLimitBytes: 200 });
    // First write fits.
    await sink.write(new Uint8Array(150), 1);
    // Second write would push queue over the limit — should block.
    let resolved = false;
    const p = sink.write(new Uint8Array(100), 1).then(() => {
      resolved = true;
    });
    // Yield to let any synchronous resolution settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false, 'second write should not have resolved yet');
    // Drain the underlying stream — queue empties, blocked writer wakes.
    out.drainNow();
    await p;
    assert.equal(resolved, true);
  });

  it('always admits a single oversized chunk even if it exceeds the limit', async () => {
    const out = new SlowSink(1024 * 1024);
    const sink = new StdoutSink(out, { bufferLimitBytes: 100 });
    // A 500-byte chunk on an empty queue should still be admitted — otherwise
    // we'd deadlock on segments larger than the limit.
    await sink.write(new Uint8Array(500), 1);
    assert.ok(sink.getQueuedBytes() <= 500);
  });

  it('end() flushes the queue before resolving', async () => {
    // For this test we want a fast consumer — we're verifying that end()
    // awaits the drain task, not the backpressure behavior.
    const accepted: number[] = [];
    const out = new Writable({
      write(chunk: Uint8Array, _enc, cb): void {
        accepted.push(chunk.byteLength);
        cb();
      },
    });
    const sink = new StdoutSink(out, { bufferLimitBytes: 1024 });
    await sink.write(new Uint8Array(100), 1);
    await sink.write(new Uint8Array(200), 1);
    await sink.end();
    const total = accepted.reduce((a, b) => a + b, 0);
    assert.equal(total, 300);
  });
});

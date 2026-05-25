/*
 * hls-pipe — file sink
 *
 * Mirrors StdoutSink's interface but writes to a disk file. Used by the
 * audio coordinator to fan out multiple language renditions to per-language
 * files. Honors back-pressure (write() returning false → await drain).
 *
 * Inspired by src/output/stdout-sink.ts; same `write(bytes, mediaSec)`
 * contract so callers can swap StdoutSink ↔ FileSink without changes.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WriteStream } from 'node:fs';

export interface FileSinkStats {
  bytesWritten: number;
  mediaSecondsWritten: number;
  lastWriteAt: number;
}

export class FileSink {
  private readonly out: WriteStream;
  private readonly stats: FileSinkStats = {
    bytesWritten: 0,
    mediaSecondsWritten: 0,
    lastWriteAt: 0,
  };
  private readonly startedAt = performance.now();
  private closed = false;

  /** Returns a sink after ensuring the parent directory exists. */
  static async open(path: string): Promise<FileSink> {
    await mkdir(dirname(path), { recursive: true });
    return new FileSink(createWriteStream(path));
  }

  constructor(out: WriteStream) {
    this.out = out;
  }

  getStats(): Readonly<FileSinkStats> {
    return this.stats;
  }

  /** Same virtual-buffer model as StdoutSink — used for LatencyController consistency. */
  bufferAheadSeconds(): number {
    if (this.stats.bytesWritten === 0) return 0;
    const elapsedSec = (performance.now() - this.startedAt) / 1000;
    return Math.max(0, this.stats.mediaSecondsWritten - elapsedSec);
  }

  async write(chunk: Uint8Array, mediaSeconds: number): Promise<void> {
    if (this.closed) throw new Error('sink is closed');
    if (chunk.byteLength === 0) {
      this.stats.mediaSecondsWritten += mediaSeconds;
      return;
    }
    const ok = this.out.write(chunk);
    if (!ok) await this.drain();
    this.stats.bytesWritten += chunk.byteLength;
    this.stats.mediaSecondsWritten += mediaSeconds;
    this.stats.lastWriteAt = performance.now();
  }

  private drain(): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      this.out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

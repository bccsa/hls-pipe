/*
 * hls-pipe — ABR controller tests
 *
 * Validates the algorithm independently of network I/O. The numeric
 * expectations track hls.js semantics (see comments inline) so future
 * porting drift is detectable.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AbrController,
  DEFAULT_ABR_CONFIG,
  type LevelInfo,
} from '../src/abr/abr-controller.js';

// A representative 5-rung ladder, roughly matching the Mux test stream.
const LADDER: LevelInfo[] = [
  { bitrate: 250_000, avgSegmentDuration: 10 },
  { bitrate: 460_000, avgSegmentDuration: 10 },
  { bitrate: 840_000, avgSegmentDuration: 10 },
  { bitrate: 2_150_000, avgSegmentDuration: 10 },
  { bitrate: 6_220_000, avgSegmentDuration: 10 },
];

describe('AbrController.getNextLevel', () => {
  it('returns lowest level on cold start when default estimate is too low', () => {
    // Default estimate (500 kbps) is below the second rung. No buffer.
    const abr = new AbrController();
    const lvl = abr.getNextLevel(0, LADDER, 0);
    assert.equal(lvl, 0);
  });

  it('climbs to highest level after a fast bandwidth sample', () => {
    const abr = new AbrController();
    // Simulate downloading a 1MB segment in 200ms (≈ 40 Mbps).
    abr.sampleFragmentLoad({ totalMs: 300, ttfbMs: 100, bytes: 1_000_000 });
    const lvl = abr.getNextLevel(0, LADDER, 8);
    assert.equal(lvl, 4);
  });

  it('refuses to up-switch on marginal bandwidth (bwUpFactor=0.7)', () => {
    const abr = new AbrController();
    // 3 Mbps download. Highest variant is 6.22 Mbps × 0.7 (up-factor) = 4.36
    // Mbps required to consider up-switching — so we should NOT pick level 4.
    abr.sampleFragmentLoad({ totalMs: 11_000, ttfbMs: 100, bytes: 4_125_000 });
    const lvl = abr.getNextLevel(0, LADDER, 10);
    assert.ok(lvl < 4, `expected level < 4 but got ${lvl}`);
  });

  it('respects capBitrate', () => {
    const abr = new AbrController({ capBitrate: 1_000_000 });
    abr.sampleFragmentLoad({ totalMs: 300, ttfbMs: 100, bytes: 1_000_000 });
    const lvl = abr.getNextLevel(0, LADDER, 8);
    // capBitrate 1Mbps allows levels 0–2 only (250k, 460k, 840k).
    assert.equal(lvl, 2);
  });

  it('uses fast-EWMA minimum: down-switches quickly on bandwidth drop', () => {
    const abr = new AbrController();
    // Train on fast network.
    for (let i = 0; i < 3; i++) {
      abr.sampleFragmentLoad({ totalMs: 300, ttfbMs: 100, bytes: 1_000_000 });
    }
    const beforeDrop = abr.getEstimate();

    // One bad sample: 200 kbps actual download.
    abr.sampleFragmentLoad({ totalMs: 10_100, ttfbMs: 100, bytes: 250_000 });
    const afterDrop = abr.getEstimate();

    assert.ok(
      afterDrop < beforeDrop / 4,
      `min(fast,slow) should drop sharply: before=${beforeDrop} after=${afterDrop}`,
    );
  });
});

describe('AbrController.shouldAbandon', () => {
  it('returns -1 when currentLevelIdx is 0 (nowhere to drop to)', () => {
    const abr = new AbrController();
    const target = abr.shouldAbandon({
      currentLevelIdx: 0,
      levels: LADDER,
      bufferAheadSec: 1,
      loaded: 500_000,
      expectedBytes: 1_000_000,
      elapsedMs: 5000,
      ttfbMs: 100,
      segmentDuration: 10,
    });
    assert.equal(target, -1);
  });

  it('returns -1 when ttfb not yet observed (no signal)', () => {
    const abr = new AbrController();
    const target = abr.shouldAbandon({
      currentLevelIdx: 4,
      levels: LADDER,
      bufferAheadSec: 1,
      loaded: 0,
      expectedBytes: 8_000_000,
      elapsedMs: 200,
      ttfbMs: undefined,
      segmentDuration: 10,
    });
    assert.equal(target, -1);
  });

  it('returns -1 before half the fragment supposedly arrived', () => {
    const abr = new AbrController();
    const target = abr.shouldAbandon({
      currentLevelIdx: 4,
      levels: LADDER,
      bufferAheadSec: 1,
      loaded: 100_000, // less than half of expected
      expectedBytes: 8_000_000,
      elapsedMs: 1000,
      ttfbMs: 100,
      segmentDuration: 10,
    });
    assert.equal(target, -1);
  });

  it('abandons to a lower level when current download is too slow vs. buffer', () => {
    const abr = new AbrController();
    // Downloading level 4 (7.78 MB segment over 10s). After 8s elapsed we
    // have 4 MB loaded — load rate ~4 Mbps. Remaining 3.78 MB takes ~7.5s
    // more, but buffer is only 2s — must abandon.
    const target = abr.shouldAbandon({
      currentLevelIdx: 4,
      levels: LADDER,
      bufferAheadSec: 2,
      loaded: 4_000_000,
      expectedBytes: 7_780_000,
      elapsedMs: 8000,
      ttfbMs: 100,
      segmentDuration: 10,
    });
    // At ~4 Mbps observed, the highest level whose 10s segment fits in the
    // 2s tolerance is level 1 (460 kbps × 10s ≈ 1.14s download).
    // Algorithm picks the highest safe level — NOT the lowest.
    assert.ok(target >= 0 && target < 4, `expected lower level, got ${target}`);
    assert.equal(target, 1);
  });

  it('abandons to level 0 when bandwidth is catastrophically low', () => {
    const abr = new AbrController();
    // 4 MB loaded over 16s ≈ 2 Mbps. Loaded > half so signal is valid.
    // At 2 Mbps even level 1 (4.6 Mbits ÷ 2 Mbps = 2.3s) exceeds the 2s
    // tolerance. Only level 0 (2.5 Mbits ÷ 2 Mbps = 1.25s) fits.
    const target = abr.shouldAbandon({
      currentLevelIdx: 4,
      levels: LADDER,
      bufferAheadSec: 2,
      loaded: 4_000_000,
      expectedBytes: 7_780_000,
      elapsedMs: 16000,
      ttfbMs: 100,
      segmentDuration: 10,
    });
    assert.equal(target, 0);
  });

  it('does NOT abandon when remaining time fits in buffer', () => {
    const abr = new AbrController();
    // Current download is on track: 4MB loaded of 8MB at 8s of 10s elapsed.
    // ~2s remaining at observed rate. Buffer is 10s — plenty of margin.
    const target = abr.shouldAbandon({
      currentLevelIdx: 4,
      levels: LADDER,
      bufferAheadSec: 10,
      loaded: 4_000_000,
      expectedBytes: 7_780_000,
      elapsedMs: 8000,
      ttfbMs: 100,
      segmentDuration: 10,
    });
    assert.equal(target, -1);
  });

  it('partial-load sample makes estimator pessimistic immediately', () => {
    const abr = new AbrController();
    // Establish a "good" estimate.
    abr.sampleFragmentLoad({ totalMs: 300, ttfbMs: 100, bytes: 1_000_000 });
    const before = abr.getEstimate();

    // Feed a partial: we downloaded 250KB over 5s — 400 kbps. That should
    // pull the fast EWMA down sharply.
    abr.samplePartialLoad(250_000, 5000);
    const after = abr.getEstimate();
    assert.ok(after < before / 4, `estimate should drop: before=${before} after=${after}`);
  });
});

describe('AbrController internals', () => {
  it('defaults match hls.js config.ts (475-486)', () => {
    assert.equal(DEFAULT_ABR_CONFIG.ewmaSlowSec, 9);
    assert.equal(DEFAULT_ABR_CONFIG.ewmaFastSec, 3);
    assert.equal(DEFAULT_ABR_CONFIG.defaultEstimateBps, 500_000);
    assert.equal(DEFAULT_ABR_CONFIG.bwFactor, 0.95);
    assert.equal(DEFAULT_ABR_CONFIG.bwUpFactor, 0.7);
    assert.equal(DEFAULT_ABR_CONFIG.maxStarvationDelaySec, 4);
  });
});

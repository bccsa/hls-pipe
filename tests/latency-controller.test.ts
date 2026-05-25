/*
 * hls-pipe — LatencyController tests
 *
 * Validates the phase-3 buffer-for-ABR model: VOD returns a generous fixed
 * buffer, live returns liveSyncTarget − lag-behind-live. Skip-to-live is
 * exercised against the recommendedSkipTarget() output.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LatencyController } from '../src/stream/latency-controller.js';
import type { MediaPlaylist, Segment } from '../src/types.js';

function vodPlaylist(seqStart: number, count: number, targetDuration = 6): MediaPlaylist {
  const segments: Segment[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    mediaSequence: seqStart + i,
    uri: `https://example.com/seg-${i}.ts`,
    duration: targetDuration,
    discontinuity: false,
  }));
  return {
    uri: 'https://example.com/playlist.m3u8',
    version: 3,
    targetDuration,
    mediaSequence: seqStart,
    discontinuitySequence: 0,
    endList: true,
    segments,
    totalDuration: count * targetDuration,
  };
}

function livePlaylist(seqStart: number, count: number, targetDuration = 6): MediaPlaylist {
  return { ...vodPlaylist(seqStart, count, targetDuration), endList: false };
}

describe('LatencyController VOD behavior', () => {
  it('returns the VOD buffer budget regardless of cursor', () => {
    const ctrl = new LatencyController({ vodBufferBudgetSec: 25 });
    ctrl.onPlaylistUpdate(vodPlaylist(0, 100));
    ctrl.setCursor(50);
    assert.equal(ctrl.bufferForAbrSec(), 25);
    assert.equal(ctrl.lagBehindLiveSec(), 0);
  });

  it('recommendedSkipTarget is always undefined for VOD', () => {
    const ctrl = new LatencyController({ skipOnStall: true, liveMaxLatencySec: 1 });
    ctrl.onPlaylistUpdate(vodPlaylist(0, 100));
    ctrl.setCursor(99);
    assert.equal(ctrl.recommendedSkipTarget(3), undefined);
  });
});

describe('LatencyController live behavior', () => {
  it('lag = 0 when cursor is at live tip', () => {
    const ctrl = new LatencyController();
    // Playlist: seqs 100..109, live tip = 109.
    ctrl.onPlaylistUpdate(livePlaylist(100, 10));
    // Cursor at the tip + 1 (we've consumed every segment).
    ctrl.setCursor(110);
    // lag baseline: (109 - 110 + 1) = 0 segments → 0s baseline (+ tiny
    // wall-clock-since-reload extrapolation, but small for fresh reload).
    assert.ok(ctrl.lagBehindLiveSec() < 1, `expected lag<1s, got ${ctrl.lagBehindLiveSec()}`);
  });

  it('lag grows with cursor distance from live tip', () => {
    const ctrl = new LatencyController();
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6)); // 6s segments, tip=109
    ctrl.setCursor(105);
    // 109 - 105 + 1 = 5 segments behind × 6s = 30s baseline.
    const lag = ctrl.lagBehindLiveSec();
    assert.ok(lag >= 30 && lag < 36, `expected ~30s lag, got ${lag}`);
  });

  it('bufferForAbrSec = liveSyncTarget − lag, clamped >= 0', () => {
    const ctrl = new LatencyController({ liveSyncTargetSec: 18 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6));
    ctrl.setCursor(108); // 109 - 108 + 1 = 2 × 6s = 12s lag
    const buf = ctrl.bufferForAbrSec();
    assert.ok(buf >= 5 && buf <= 6, `expected ~6s buffer, got ${buf}`);
  });

  it('bufferForAbrSec clamps to 0 when lag exceeds sync target', () => {
    const ctrl = new LatencyController({ liveSyncTargetSec: 10 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6));
    ctrl.setCursor(100); // tip=109, lag = 10 segments × 6s = 60s
    assert.equal(ctrl.bufferForAbrSec(), 0);
  });

  it('liveTipSeq is monotonic across playlist reloads', () => {
    const ctrl = new LatencyController({ liveSyncTargetSec: 12 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 5, 6)); // tip=104
    ctrl.onPlaylistUpdate(livePlaylist(102, 5, 6)); // tip=106
    ctrl.setCursor(105);
    // After second reload: tip=106, cursor=105 → 2 segments behind → 12s lag.
    const lag = ctrl.lagBehindLiveSec();
    assert.ok(lag >= 12 && lag < 18, `expected ~12s lag, got ${lag}`);
  });

  it('does not regress liveTipSeq if a stale playlist is fed', () => {
    const ctrl = new LatencyController();
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6)); // tip=109
    ctrl.onPlaylistUpdate(livePlaylist(100, 5, 6)); // smaller, tip=104; must not regress
    ctrl.setCursor(105);
    // tip should still be 109, lag = 109-105+1 = 5 × 6s = 30s
    const lag = ctrl.lagBehindLiveSec();
    assert.ok(lag >= 30 && lag < 36, `expected ~30s lag, got ${lag}`);
  });
});

describe('LatencyController skip-to-live', () => {
  it('returns no skip target when skipOnStall is disabled', () => {
    const ctrl = new LatencyController({ skipOnStall: false, liveMaxLatencySec: 6 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6));
    ctrl.setCursor(100); // lag ~60s, well over max
    assert.equal(ctrl.recommendedSkipTarget(3), undefined);
  });

  it('returns no skip target when lag is below max', () => {
    const ctrl = new LatencyController({ skipOnStall: true, liveMaxLatencySec: 30 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6));
    ctrl.setCursor(108); // lag ~12s, below 30s max
    assert.equal(ctrl.recommendedSkipTarget(3), undefined);
  });

  it('recommends jump to (liveTip − liveStartOffset + 1) when lag exceeds max', () => {
    const ctrl = new LatencyController({ skipOnStall: true, liveMaxLatencySec: 18 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6));
    ctrl.setCursor(100); // lag = 10 × 6s = 60s, well past 18s
    // liveTip = 109, offset = 3 → target = 107
    assert.equal(ctrl.recommendedSkipTarget(3), 107);
  });

  it('never recommends going backwards from the cursor', () => {
    const ctrl = new LatencyController({ skipOnStall: true, liveMaxLatencySec: 18 });
    ctrl.onPlaylistUpdate(livePlaylist(100, 10, 6));
    ctrl.setCursor(108); // cursor already near live; lag = 12s, below max
    assert.equal(ctrl.recommendedSkipTarget(3), undefined);
  });
});

describe('LatencyController autoTuneSyncTarget', () => {
  it('sets liveSyncTarget to 2 × targetDuration by default', () => {
    const ctrl = new LatencyController();
    ctrl.onPlaylistUpdate(livePlaylist(0, 5, 4));
    ctrl.autoTuneSyncTarget();
    assert.equal(ctrl.getConfig().liveSyncTargetSec, 8);
  });

  it('honors custom multiplier', () => {
    const ctrl = new LatencyController();
    ctrl.onPlaylistUpdate(livePlaylist(0, 5, 6));
    ctrl.autoTuneSyncTarget(3); // RFC recommendation
    assert.equal(ctrl.getConfig().liveSyncTargetSec, 18);
  });
});

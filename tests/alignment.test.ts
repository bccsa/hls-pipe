/*
 * hls-pipe — phase 7b.4 alignment tests
 *
 * Validates per-segment `startTimeSec` computation in the parser and the
 * `findSegmentAtTime` cross-variant alignment helper. Real-stream divergence
 * is exercised in the smoke test; these unit tests cover the algorithm.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { findSegmentAtTime, parseMedia } from '../src/parser/m3u8-parser.js';

const PLAYLIST_ALIGNED = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6,
seg0.ts
#EXTINF:6,
seg1.ts
#EXTINF:6,
seg2.ts
#EXTINF:4,
seg3.ts
#EXT-X-ENDLIST
`;

// Mismatched second variant: same total but durations drift in the middle —
// matches the BCC stream-CDN VOD non-alignment pattern.
const PLAYLIST_DRIFT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:7
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6,
seg0.ts
#EXTINF:7,
seg1.ts
#EXTINF:5,
seg2.ts
#EXTINF:4,
seg3.ts
#EXT-X-ENDLIST
`;

describe('parser computes startTimeSec', () => {
  it('cumulates EXTINF durations across segments', () => {
    const p = parseMedia(PLAYLIST_ALIGNED, 'https://x/p.m3u8');
    assert.equal(p.segments.length, 4);
    assert.equal(p.segments[0]!.startTimeSec, 0);
    assert.equal(p.segments[1]!.startTimeSec, 6);
    assert.equal(p.segments[2]!.startTimeSec, 12);
    assert.equal(p.segments[3]!.startTimeSec, 18);
    assert.equal(p.totalDuration, 22);
  });
});

describe('findSegmentAtTime', () => {
  const aligned = parseMedia(PLAYLIST_ALIGNED, 'https://x/p.m3u8');
  const drift = parseMedia(PLAYLIST_DRIFT, 'https://x/p.m3u8');

  it('finds the segment whose [start, start+duration) range contains the query time', () => {
    assert.equal(findSegmentAtTime(aligned, 0)!.mediaSequence, 0);
    assert.equal(findSegmentAtTime(aligned, 5.999)!.mediaSequence, 0);
    assert.equal(findSegmentAtTime(aligned, 6)!.mediaSequence, 1);
    assert.equal(findSegmentAtTime(aligned, 11.5)!.mediaSequence, 1);
    assert.equal(findSegmentAtTime(aligned, 12)!.mediaSequence, 2);
    assert.equal(findSegmentAtTime(aligned, 21.99)!.mediaSequence, 3);
  });

  it('returns undefined past the end of the playlist', () => {
    assert.equal(findSegmentAtTime(aligned, 22), undefined);
    assert.equal(findSegmentAtTime(aligned, 1000), undefined);
  });

  it('returns the first segment for negative time (defensive)', () => {
    assert.equal(findSegmentAtTime(aligned, -1)!.mediaSequence, 0);
  });

  it('detects misalignment: same mediaSequence resolves to different time windows', () => {
    // At playhead=10s in the aligned variant we'd be in segment 1 (covers 6-12).
    // The drift variant's segment 1 covers 6-13, so playhead=10 also maps to
    // segment 1 there — same mediaSequence, OK at this point.
    assert.equal(findSegmentAtTime(aligned, 10)!.mediaSequence, 1);
    assert.equal(findSegmentAtTime(drift, 10)!.mediaSequence, 1);

    // But at playhead=14s the variants diverge: aligned says seg 2 (12-18),
    // drift says seg 2 (13-18). Same mediaSequence but the actual content
    // covers different times — exactly the bug phase-7b.4 fixes.
    // We just verify the helper picks the bracketing segment correctly:
    assert.equal(findSegmentAtTime(aligned, 14)!.mediaSequence, 2);
    assert.equal(findSegmentAtTime(drift, 14)!.mediaSequence, 2);
    assert.equal(findSegmentAtTime(aligned, 18.5)!.mediaSequence, 3);
    assert.equal(findSegmentAtTime(drift, 18.5)!.mediaSequence, 3);
  });

  it('correctly maps a divergent playhead across variants', () => {
    // Construct a divergence: aligned plays segs 0,1 (0..12), drift plays
    // segs 0,1 (0..13). After two segments the aligned-variant playhead=12s,
    // drift-variant playhead=13s. Without time-based re-anchor, switching
    // variants at this point would mis-target.
    //
    // Cumulative alignment: if we played aligned's seg 1 (ended at 12s) and
    // then switch to drift, the next bracketing segment is the one starting
    // at 13 (= seg 2), NOT seg 2 in mediaSequence terms.
    // Verify: at playhead=12, drift's bracketing segment is seg 1 (6-13)
    // because 12 < 13. So we replay 1 second from seg 1 instead of jumping
    // ahead — the "overlap" semantics we documented.
    assert.equal(findSegmentAtTime(drift, 12)!.mediaSequence, 1);
  });

  it('empty playlist returns undefined', () => {
    const empty = parseMedia('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n', 'https://x/p.m3u8');
    assert.equal(findSegmentAtTime(empty, 0), undefined);
  });
});

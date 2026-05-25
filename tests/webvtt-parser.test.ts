/*
 * hls-pipe — WebVTT segment parser tests
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  parseWebVttSegment,
  WebVttParseError,
  WEBVTT_PTS_HZ,
} from '../src/parser/webvtt-parser.js';

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function txt(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

describe('parseWebVttSegment', () => {
  it('parses a single cue with X-TIMESTAMP-MAP', () => {
    const src = [
      'WEBVTT',
      'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
      '',
      '00:00:01.500 --> 00:00:04.000',
      'Hello world',
      '',
    ].join('\n');
    const parsed = parseWebVttSegment(bytes(src));
    assert.equal(parsed.hasTimestampMap, true);
    assert.equal(parsed.mpegtsOffset, 900_000);
    assert.equal(parsed.localOffset, 0);
    assert.equal(parsed.cues.length, 1);
    // PTS = mpegtsOffset + (cueStart - localOffset) = 900000 + 1.5s * 90000 = 1_035_000
    assert.equal(parsed.cues[0]!.pts, 1_035_000);
    // duration = 2.5s * 90000 = 225000
    assert.equal(parsed.cues[0]!.durationTicks, 225_000);
    // payload retains the timing line + cue text + trailing newline
    assert.equal(
      txt(parsed.cues[0]!.payload),
      '00:00:01.500 --> 00:00:04.000\nHello world\n',
    );
  });

  it('parses multi-cue segments with non-zero LOCAL offset', () => {
    const src = [
      'WEBVTT',
      'X-TIMESTAMP-MAP=MPEGTS:1800000,LOCAL:00:00:10.000',
      '',
      '00:00:10.000 --> 00:00:12.000',
      'first',
      '',
      '00:00:13.500 --> 00:00:15.000',
      'second',
      '',
    ].join('\n');
    const parsed = parseWebVttSegment(bytes(src));
    assert.equal(parsed.cues.length, 2);
    // baseTicks = mpegts - local = 1800000 - 900000 = 900000
    // cue1 pts = 900000 + 10s*90000 = 1_800_000
    assert.equal(parsed.cues[0]!.pts, 1_800_000);
    // cue2 pts = 900000 + 13.5s*90000 = 1_215_000 + 900_000 = 2_115_000
    assert.equal(parsed.cues[1]!.pts, 2_115_000);
  });

  it('uses fallbackBaseTicks when X-TIMESTAMP-MAP is absent', () => {
    const src = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'no map',
      '',
    ].join('\n');
    const parsed = parseWebVttSegment(bytes(src), 5_000_000);
    assert.equal(parsed.hasTimestampMap, false);
    assert.equal(parsed.cues.length, 1);
    assert.equal(parsed.cues[0]!.pts, 5_000_000 + 90_000);
  });

  it('skips NOTE / STYLE / REGION blocks', () => {
    const src = [
      'WEBVTT',
      '',
      'NOTE This is a comment',
      'spanning multiple lines',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'REGION',
      'id:r1',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'real cue',
      '',
    ].join('\n');
    const parsed = parseWebVttSegment(bytes(src));
    assert.equal(parsed.cues.length, 1);
    assert.equal(txt(parsed.cues[0]!.payload), '00:00:01.000 --> 00:00:02.000\nreal cue\n');
  });

  it('tolerates CRLF line endings', () => {
    const src = 'WEBVTT\r\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhi\r\n\r\n';
    const parsed = parseWebVttSegment(bytes(src));
    assert.equal(parsed.cues.length, 1);
    assert.equal(parsed.cues[0]!.pts, 90_000);
  });

  it('preserves cue settings after the end timestamp in the payload', () => {
    const src = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:02.000 align:left position:10%',
      'styled',
      '',
    ].join('\n');
    const parsed = parseWebVttSegment(bytes(src));
    assert.equal(parsed.cues.length, 1);
    assert.equal(
      txt(parsed.cues[0]!.payload),
      '00:00:01.000 --> 00:00:02.000 align:left position:10%\nstyled\n',
    );
  });

  it('rejects segments without the WEBVTT magic', () => {
    assert.throws(() => parseWebVttSegment(bytes('not vtt\n')), WebVttParseError);
  });

  it('parses mm:ss.mmm style timestamps (no hours)', () => {
    const src = [
      'WEBVTT',
      '',
      '01:00.000 --> 01:02.500',
      'shorthand',
      '',
    ].join('\n');
    const parsed = parseWebVttSegment(bytes(src));
    assert.equal(parsed.cues.length, 1);
    // 60s -> 60 * 90000 = 5_400_000
    assert.equal(parsed.cues[0]!.pts, 5_400_000);
  });

  it('exports WEBVTT_PTS_HZ = 90000', () => {
    assert.equal(WEBVTT_PTS_HZ, 90_000);
  });
});

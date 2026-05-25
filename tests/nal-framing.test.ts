/*
 * hls-pipe — NAL framing + AVC classification tests
 *
 * Validates the phase-7a.1 Annex-B scanner against synthetic byte sequences
 * AND the real synth-2s.ts fixture's video PES payloads.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseAnnexB } from '../src/demux/video/nal-framing.js';
import { AvcNalType, avcNalType, classify, isKeyframe } from '../src/demux/video/avc.js';
import { Demuxer } from '../src/demux/demuxer.js';

const FIX = new Uint8Array(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'synth-2s.ts')),
);

describe('parseAnnexB', () => {
  it('returns empty when there is no start code', () => {
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x10, 0x20, 0x30]);
    assert.equal(parseAnnexB(buf).length, 0);
  });

  it('splits a single NAL with 3-byte start code', () => {
    // 00 00 01 | nal_header | payload
    const buf = new Uint8Array([0x00, 0x00, 0x01, 0x65, 0xaa, 0xbb]);
    const nals = parseAnnexB(buf);
    assert.equal(nals.length, 1);
    assert.equal(nals[0]!.data[0], 0x65);
    assert.equal(nals[0]!.data.byteLength, 3);
  });

  it('splits a single NAL with 4-byte start code', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00]);
    const nals = parseAnnexB(buf);
    assert.equal(nals.length, 1);
    assert.equal(nals[0]!.data[0], 0x67);
    assert.equal(nals[0]!.data.byteLength, 3);
  });

  it('splits multiple NALs with mixed 3- and 4-byte codes', () => {
    const buf = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0xaa, // SPS-like NAL (4-byte start)
      0x00, 0x00, 0x01, 0x68, 0xbb, 0xcc, // PPS-like NAL (3-byte start)
      0x00, 0x00, 0x00, 0x01, 0x65, 0xdd, 0xee, 0xff, // IDR-like NAL (4-byte start)
    ]);
    const nals = parseAnnexB(buf);
    assert.equal(nals.length, 3);
    assert.equal(nals[0]!.data[0], 0x67);
    assert.equal(nals[1]!.data[0], 0x68);
    assert.equal(nals[2]!.data[0], 0x65);
    assert.equal(nals[2]!.data.byteLength, 4);
  });

  it('tolerates leading garbage before the first start code', () => {
    const buf = new Uint8Array([0xff, 0xff, 0xff, 0x00, 0x00, 0x01, 0x67, 0xaa]);
    const nals = parseAnnexB(buf);
    assert.equal(nals.length, 1);
    assert.equal(nals[0]!.data[0], 0x67);
  });

  it('handles empty NAL units (start code with no payload before next)', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x65, 0xaa]);
    // Empty NAL is skipped, real NAL is found
    const nals = parseAnnexB(buf);
    assert.equal(nals.length, 1);
    assert.equal(nals[0]!.data[0], 0x65);
  });

  it('returns empty for input shorter than minimum start code (3 bytes)', () => {
    assert.equal(parseAnnexB(new Uint8Array([])).length, 0);
    assert.equal(parseAnnexB(new Uint8Array([0x00, 0x00])).length, 0);
  });
});

describe('avcNalType + isKeyframe', () => {
  it('extracts nal_unit_type from the 5 low bits of the header byte', () => {
    // 0x67 = 0110_0111 → nal_unit_type = 7 (SPS), nal_ref_idc = 3
    assert.equal(avcNalType({ data: new Uint8Array([0x67]) }), AvcNalType.SPS);
    // 0x68 = 0110_1000 → type = 8 (PPS)
    assert.equal(avcNalType({ data: new Uint8Array([0x68]) }), AvcNalType.PPS);
    // 0x65 = 0110_0101 → type = 5 (IDR)
    assert.equal(avcNalType({ data: new Uint8Array([0x65]) }), AvcNalType.IDR);
    // 0x41 = 0100_0001 → type = 1 (non-IDR slice)
    assert.equal(avcNalType({ data: new Uint8Array([0x41]) }), AvcNalType.SLICE);
  });

  it('handles empty NAL unit gracefully', () => {
    assert.equal(avcNalType({ data: new Uint8Array(0) }), 0);
  });

  it('identifies keyframes by IDR (type 5) presence', () => {
    const idr = [{ data: new Uint8Array([0x67]) }, { data: new Uint8Array([0x65]) }];
    const nonIdr = [{ data: new Uint8Array([0x41]) }];
    assert.equal(isKeyframe(idr), true);
    assert.equal(isKeyframe(nonIdr), false);
  });

  it('classify tags every unit with its type', () => {
    const units = [
      { data: new Uint8Array([0x67, 0xaa]) },
      { data: new Uint8Array([0x68, 0xbb]) },
      { data: new Uint8Array([0x65, 0xcc]) },
    ];
    const tagged = classify(units);
    assert.deepEqual(
      tagged.map((u) => u.type),
      [AvcNalType.SPS, AvcNalType.PPS, AvcNalType.IDR],
    );
  });
});

describe('End-to-end against real TS fixture', () => {
  it('demuxes synth-2s.ts and extracts NAL units from the first video PES', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(FIX);
    assert.ok(result.video.length > 0, 'fixture should have video PES packets');

    const firstPes = result.video[0]!;
    const nals = parseAnnexB(firstPes.data);
    assert.ok(nals.length > 0, 'first video PES should contain NAL units');

    // ffmpeg's first PES for a freshly-encoded H.264 typically contains
    // AUD (type 9), SPS (type 7), PPS (type 8), and an IDR (type 5).
    const types = nals.map(avcNalType);
    assert.ok(types.includes(AvcNalType.SPS), `expected SPS in ${types}`);
    assert.ok(types.includes(AvcNalType.PPS), `expected PPS in ${types}`);
    assert.ok(isKeyframe(nals), 'first video PES should be a keyframe');
  });

  it('keyframe detection finds an IDR at the start and non-keyframes elsewhere', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(FIX);
    // First PES contains the IDR
    const firstNals = parseAnnexB(result.video[0]!.data);
    assert.equal(isKeyframe(firstNals), true);
    // Find at least one later PES that's NOT an IDR (P/B frame).
    let foundNonKey = false;
    for (let i = 1; i < result.video.length; i++) {
      const nals = parseAnnexB(result.video[i]!.data);
      if (!isKeyframe(nals)) {
        foundNonKey = true;
        break;
      }
    }
    assert.ok(foundNonKey, 'expected at least one non-keyframe PES after the IDR');
  });
});

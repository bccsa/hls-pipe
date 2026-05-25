/*
 * hls-pipe — TS muxer + fMP4 video tests
 *
 * The end-to-end round-trip: feed the fMP4 video fixture through
 * Fmp4VideoExtractor + MpegTsMuxer, then verify the output as MPEG-TS bytes
 * with our own phase-4a Demuxer (which is independently validated against
 * an ffmpeg-generated fixture).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Fmp4VideoExtractor, splitLengthPrefixed, toAnnexB } from '../src/demux/fmp4/video.js';
import { MpegTsMuxer } from '../src/mux/ts/muxer.js';
import { buildPat, buildPmt, crc32Mpeg2, withPointerField } from '../src/mux/ts/pat-pmt.js';
import { buildPes, StreamId } from '../src/mux/ts/pes.js';
import { TsPacketWriter, PACKET_SIZE } from '../src/mux/ts/packet.js';
import { Demuxer } from '../src/demux/demuxer.js';
import { parsePAT, parsePMT } from '../src/demux/pat-pmt.js';
import { parseAvcC, readVideoTracks } from '../src/demux/fmp4/avc-config.js';
import { findChild, findChildren, findPath } from '../src/demux/fmp4/box.js';
import { parseAnnexB } from '../src/demux/video/nal-framing.js';
import { avcNalType, AvcNalType } from '../src/demux/video/avc.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VIDEO_INIT = new Uint8Array(readFileSync(join(FIX, 'video-init.mp4')));
const VIDEO_SEG = new Uint8Array(readFileSync(join(FIX, 'video-seg0.m4s')));

describe('CRC-32/MPEG-2', () => {
  it('matches the canonical "123456789" test vector (0x0376E6E7)', () => {
    // From the Rocksoft CRC catalog: CRC-32/MPEG-2 of "123456789" = 0x0376E6E7.
    const input = new TextEncoder().encode('123456789');
    assert.equal(crc32Mpeg2(input), 0x0376e6e7);
  });

  it('zero-length input yields 0xFFFFFFFF (init state)', () => {
    assert.equal(crc32Mpeg2(new Uint8Array(0)), 0xffffffff);
  });
});

describe('PAT / PMT section builders', () => {
  it('PAT section round-trips through our demuxer parsePAT', () => {
    const section = buildPat(1, 0x1000);
    // parsePAT expects to be called with the PAT section bytes at an offset.
    const pmtPid = parsePAT(section, 0);
    assert.equal(pmtPid, 0x1000);
  });

  it('PAT section has a valid CRC-32/MPEG-2 over the section body', () => {
    // Regression: an earlier revision sized the array at 17 bytes and stored
    // CRC at indices 13..16, leaving a zero byte inside the section_length=13
    // window. Result: invalid CRC; ffmpeg silently rejected the PAT and
    // dropped all downstream PMT-carried metadata (language descriptors).
    const section = buildPat(1, 0x1000);
    assert.equal(section.byteLength, 16, 'PAT section must be exactly 16 bytes');
    // section_length declared = 13 covers bytes 3..15 (13 body bytes including 4 CRC).
    assert.equal(section[2]!, 0x0d, 'section_length low byte');
    // Compute CRC over the first 12 bytes (everything before the CRC field).
    const expected = crc32Mpeg2(section.subarray(0, 12));
    const got =
      (section[12]! << 24) | (section[13]! << 16) | (section[14]! << 8) | section[15]!;
    assert.equal(got >>> 0, expected >>> 0, 'PAT CRC must match');
  });

  it('PMT section round-trips through our demuxer parsePMT', () => {
    const section = buildPmt(1, [{ streamType: 0x1b, pid: 0x100 }]);
    const result = parsePMT(section, 0);
    assert.equal(result.videoPid, 0x100);
    assert.equal(result.videoCodec, 'avc');
    assert.equal(result.audioPid, -1);
  });

  it('PMT with multiple streams', () => {
    const section = buildPmt(1, [
      { streamType: 0x1b, pid: 0x100 },
      { streamType: 0x0f, pid: 0x101 },
    ]);
    const result = parsePMT(section, 0);
    assert.equal(result.videoPid, 0x100);
    assert.equal(result.audioPid, 0x101);
    assert.equal(result.audioCodec, 'aac');
  });

  it('emits ISO 639 language descriptor (tag 0x0a) per stream when language is set', () => {
    // Multi-audio PMT with explicit language codes — we read the raw bytes
    // and locate each descriptor inside its stream's ES_info loop. The
    // demuxer doesn't surface language yet (it just identifies codec), so the
    // round-trip check is byte-level rather than via parsePMT().
    const section = buildPmt(1, [
      { streamType: 0x1b, pid: 0x100 },
      { streamType: 0x0f, pid: 0x101, language: 'nor' },
      { streamType: 0x0f, pid: 0x102, language: 'eng' },
      { streamType: 0x0f, pid: 0x103, language: 'fra' },
    ]);
    // Walk the section: skip 12-byte header, then for each stream skip
    // stream_type(1) + ES_PID(2) + ES_info_length(2) + ES_info bytes.
    // Video stream has 0 ES_info; each audio stream has 6 bytes (one ISO 639
    // descriptor: tag(1) + len(1) + code(3) + audio_type(1)).
    let cursor = 12;
    // Video stream: streamType=0x1b at cursor.
    assert.equal(section[cursor]!, 0x1b);
    cursor += 3; // streamType + ES_PID
    const videoEsLen = ((section[cursor]! & 0x0f) << 8) | section[cursor + 1]!;
    assert.equal(videoEsLen, 0, 'video stream has no descriptors');
    cursor += 2 + videoEsLen;

    const expectedLangs = ['nor', 'eng', 'fra'];
    for (const lang of expectedLangs) {
      // streamType, ES_PID
      cursor += 3;
      const esLen = ((section[cursor]! & 0x0f) << 8) | section[cursor + 1]!;
      cursor += 2;
      assert.equal(esLen, 6, `audio ${lang} ES_info should be exactly the ISO 639 descriptor`);
      assert.equal(section[cursor]!, 0x0a, `descriptor tag should be ISO 639 (0x0a) for ${lang}`);
      assert.equal(section[cursor + 1]!, 4, `descriptor length should be 4 for ${lang}`);
      const decoded = String.fromCharCode(
        section[cursor + 2]!,
        section[cursor + 3]!,
        section[cursor + 4]!,
      );
      assert.equal(decoded, lang, `language code should be ${lang}`);
      assert.equal(section[cursor + 5]!, 0x00, `audio_type should be 0x00 (undefined) for ${lang}`);
      cursor += esLen;
    }
    // What's left is the 4-byte CRC.
    assert.equal(section.byteLength - cursor, 4, 'only CRC should remain');
  });

  it('handles oddly-cased / 2-letter language input via normalization', () => {
    const section = buildPmt(1, [
      { streamType: 0x1b, pid: 0x100 },
      { streamType: 0x0f, pid: 0x101, language: 'EN' }, // 2-char → padded
      { streamType: 0x0f, pid: 0x102, language: 'Norwegian' }, // long → truncated to "nor"
    ]);
    // First audio descriptor language code at section[14+5+0] approx — compute:
    //   header(12) + video(3+2) = 17 → first audio streamType
    //   then 3+2 = 22 → first audio descriptor starts
    let cursor = 12 + 3 + 2 + 0 + 3 + 2; // header + video + first audio header
    assert.equal(section[cursor]!, 0x0a);
    const lang1 = String.fromCharCode(section[cursor + 2]!, section[cursor + 3]!, section[cursor + 4]!);
    assert.equal(lang1, 'en ');
    cursor += 6; // descriptor
    cursor += 3 + 2; // next audio header
    const lang2 = String.fromCharCode(section[cursor + 2]!, section[cursor + 3]!, section[cursor + 4]!);
    assert.equal(lang2, 'nor');
  });
});

describe('PES builder', () => {
  it('produces PTS-only PES (no DTS) when dts == pts', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const pes = buildPes({ streamId: StreamId.VIDEO, payload, pts: 90000 });
    // 9-byte base + 5-byte PTS + 3-byte payload = 17
    assert.equal(pes.byteLength, 9 + 5 + 3);
    assert.equal(pes[7], 0x80); // PTS-only flag
    assert.equal(pes[8], 5);
  });

  it('produces PTS+DTS PES when dts != pts', () => {
    const payload = new Uint8Array([0xaa]);
    const pes = buildPes({
      streamId: StreamId.VIDEO,
      payload,
      pts: 90000,
      dts: 80000,
    });
    assert.equal(pes.byteLength, 9 + 10 + 1);
    assert.equal(pes[7], 0xc0); // PTS+DTS flag
    assert.equal(pes[8], 10);
  });
});

describe('TS packet writer', () => {
  it('emits 188-byte packets with sync byte', () => {
    const writer = new TsPacketWriter();
    const payload = new Uint8Array(400);
    payload.fill(0xab);
    writer.writeChunk(0x100, { bytes: payload, payloadStart: true });
    const out = writer.toBytes();
    // 400 bytes payload + 4-byte header per packet, no AF → 184 payload per packet → 3 packets
    assert.equal(out.byteLength, 3 * PACKET_SIZE);
    assert.equal(out[0], 0x47);
    assert.equal(out[PACKET_SIZE], 0x47);
    assert.equal(out[2 * PACKET_SIZE], 0x47);
  });

  it('writes PUSI on first packet only', () => {
    const writer = new TsPacketWriter();
    const payload = new Uint8Array(400);
    writer.writeChunk(0x100, { bytes: payload, payloadStart: true });
    const out = writer.toBytes();
    // Byte 1: top bit transport_error(0), next PUSI, then PID high 5 bits.
    assert.equal((out[1]! & 0x40) !== 0, true, 'first packet should have PUSI');
    assert.equal((out[PACKET_SIZE + 1]! & 0x40) !== 0, false, 'second packet should NOT have PUSI');
  });

  it('continuity counter increments per packet for a given PID', () => {
    const writer = new TsPacketWriter();
    const payload = new Uint8Array(400);
    writer.writeChunk(0x100, { bytes: payload, payloadStart: true });
    const out = writer.toBytes();
    assert.equal(out[3]! & 0x0f, 0);
    assert.equal(out[PACKET_SIZE + 3]! & 0x0f, 1);
    assert.equal(out[2 * PACKET_SIZE + 3]! & 0x0f, 2);
  });

  it('stuffs adaptation field to fill the last packet of a partial payload', () => {
    const writer = new TsPacketWriter();
    const payload = new Uint8Array(50); // < 184, fits in one packet with stuffing
    payload.fill(0x99);
    writer.writeChunk(0x100, { bytes: payload, payloadStart: true });
    const out = writer.toBytes();
    assert.equal(out.byteLength, PACKET_SIZE);
    assert.equal(out[0], 0x47);
    // adaptation_field_control bits 5-4 of byte 3 should be 0b11 = 3 (AF + payload)
    assert.equal((out[3]! >> 4) & 0x03, 3);
    // Last byte of payload should be the last 0x99.
    assert.equal(out[PACKET_SIZE - 1], 0x99);
  });
});

describe('avcC parser', () => {
  it('extracts SPS + PPS + lengthSize from fixture init', () => {
    const tracks = readVideoTracks(VIDEO_INIT);
    assert.equal(tracks.length, 1);
    const track = tracks[0]!;
    assert.equal(track.codecFourCc, 'avc1');
    assert.equal(track.width, 320);
    assert.equal(track.height, 180);
    assert.ok(track.avc);
    const avc = track.avc!;
    assert.equal(avc.lengthSize, 4);
    assert.ok(avc.spsList.length >= 1, 'should have at least one SPS');
    assert.ok(avc.ppsList.length >= 1, 'should have at least one PPS');
    // First byte of each SPS / PPS is the NAL header — type 7 (SPS) / 8 (PPS).
    assert.equal(avc.spsList[0]![0]! & 0x1f, AvcNalType.SPS);
    assert.equal(avc.ppsList[0]![0]! & 0x1f, AvcNalType.PPS);
  });
});

describe('splitLengthPrefixed + toAnnexB', () => {
  it('splits length-prefixed NALs and re-frames to Annex-B', () => {
    // Two NAL units, 4-byte length prefix
    const lpEncoded = new Uint8Array([
      0, 0, 0, 3, 0x65, 0xaa, 0xbb, // length=3, NAL header=0x65 (IDR), payload 0xaa 0xbb
      0, 0, 0, 2, 0x67, 0xcc, //         length=2, NAL header=0x67 (SPS), payload 0xcc
    ]);
    const nals = splitLengthPrefixed(lpEncoded, 4);
    assert.equal(nals.length, 2);
    assert.equal(nals[0]!.byteLength, 3);
    assert.equal(nals[1]!.byteLength, 2);

    const annexb = toAnnexB(nals);
    // 4-byte start code + 3-byte NAL + 4-byte start code + 2-byte NAL = 13
    assert.equal(annexb.byteLength, 13);
    assert.equal(annexb[0], 0x00);
    assert.equal(annexb[1], 0x00);
    assert.equal(annexb[2], 0x00);
    assert.equal(annexb[3], 0x01);
    assert.equal(annexb[4], 0x65);
  });

  it('toAnnexB prepends SPS+PPS when provided (keyframe path)', () => {
    const sps = new Uint8Array([0x67, 0x42]);
    const pps = new Uint8Array([0x68, 0xce]);
    const idr = new Uint8Array([0x65, 0xaa]);
    const annexb = toAnnexB([idr], [sps], [pps]);
    // SPS + PPS + IDR, each with 4-byte start code
    assert.equal(annexb.byteLength, 4 + 2 + 4 + 2 + 4 + 2);
    assert.equal(annexb[4], 0x67); // first NAL is SPS
    assert.equal(annexb[4 + 2 + 4], 0x68); // second NAL is PPS
  });
});

describe('Fmp4VideoExtractor', () => {
  it('produces 50 video samples from the 2s testsrc2 fixture (25 fps)', () => {
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG);
    // 2s @ 25fps = 50 frames; ffmpeg may emit 49-50 depending on rounding.
    assert.ok(samples.length >= 49 && samples.length <= 51, `expected ~50 samples, got ${samples.length}`);
    // First sample should be a keyframe (segment-start = IDR for HLS).
    assert.equal(samples[0]!.isKeyframe, true);
    // Subsequent samples should not be keyframes (testsrc2 with -g 25).
    assert.equal(samples[10]!.isKeyframe, false);
  });

  it('keyframe samples have SPS+PPS prepended', () => {
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG);
    const first = samples[0]!;
    const nals = parseAnnexB(first.data);
    const types = nals.map((u) => avcNalType(u));
    assert.ok(types.includes(AvcNalType.SPS), `first sample missing SPS: ${types}`);
    assert.ok(types.includes(AvcNalType.PPS), `first sample missing PPS: ${types}`);
    assert.ok(types.includes(AvcNalType.IDR), `first sample missing IDR: ${types}`);
  });

  it('reports zero PTS shift when the source has non-negative composition offsets', () => {
    // The testsrc2 fixture has cts=0 throughout — no B-frame priming — so the
    // negative-CTS fixup should remain dormant.
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG);
    assert.equal(ext.getPtsShift(), 0);
    for (const s of samples) {
      assert.ok(s.pts >= s.dts, `pts ${s.pts} should be ≥ dts ${s.dts}`);
    }
  });
});

describe('End-to-end: fMP4 video → MpegTsMuxer → demuxer round-trip', () => {
  it('produces a valid MPEG-TS bytestream that our demuxer can parse', () => {
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG);
    const ts = new MpegTsMuxer().mux(
      samples.map((s) => ({ data: s.data, pts: s.pts, dts: s.dts, isKeyframe: s.isKeyframe })),
    );

    // First byte is 0x47 sync
    assert.equal(ts[0], 0x47);
    // Output should be a multiple of 188 bytes
    assert.equal(ts.byteLength % 188, 0);

    // Demux the output. PAT + PMT should announce a video stream at PID 0x100.
    const demuxer = new Demuxer();
    const result = demuxer.demux(ts);
    assert.equal(result.streams.videoPid, 0x100);
    assert.equal(result.streams.videoCodec, 'avc');
    assert.ok(result.video.length > 0, 'expected video PES packets from our muxed TS');
  });

  it('every demuxed PES has a PTS that matches a source sample', () => {
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG);
    // Convert source PTS to 90 kHz (track timescale is also 90 kHz for video, so 1:1)
    // — actually let's just verify the first PES's PTS matches the first sample's PTS.
    const ts = new MpegTsMuxer().mux(
      samples.map((s) => ({ data: s.data, pts: s.pts, dts: s.dts, isKeyframe: s.isKeyframe })),
    );
    const demuxer = new Demuxer();
    const result = demuxer.demux(ts);
    const firstPesPts = result.video[0]!.pts;
    const sourcePts = samples[0]!.pts;
    assert.equal(firstPesPts, sourcePts, `PTS round-trip: ${firstPesPts} vs ${sourcePts}`);
  });

  it('signalDiscontinuity() bumps PAT version + sets AF discontinuity_indicator on first video packet', () => {
    // Variant-switch regression: ffmpeg was decoding new-variant bytes with
    // the old SPS, producing CABAC errors on Constrained Baseline content.
    // We signal the boundary two ways — a fresh PSI version (so decoders
    // re-parse the program map) and an AF discontinuity_indicator on the
    // first VIDEO packet (so the video decoder re-inits while audio decoder
    // stays untouched — audio doesn't change across variants and re-init is
    // audible as a soft click).
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG).map((s) => ({
      data: s.data, pts: s.pts, dts: s.dts, isKeyframe: s.isKeyframe,
    }));
    const muxer = new MpegTsMuxer();
    const before = muxer.mux(samples);
    muxer.signalDiscontinuity();
    const after = muxer.mux(samples);

    const firstPacketOf = (bytes: Uint8Array, targetPid: number): number => {
      for (let i = 0; i < bytes.byteLength; i += 188) {
        if (bytes[i] !== 0x47) continue;
        const pid = ((bytes[i + 1]! & 0x1f) << 8) | bytes[i + 2]!;
        if (pid === targetPid) return i;
      }
      throw new Error(`no packet for pid ${targetPid}`);
    };
    const readPatVersion = (bytes: Uint8Array): number => {
      const off = firstPacketOf(bytes, 0);
      // Skip TS header + adaptation field (writer adds one for stuffing on
      // PSI packets to pad to 188 bytes), then pointer_field, to reach the
      // section. version_number is bits 5..1 of section byte 5.
      const afc = (bytes[off + 3]! >> 4) & 0x3;
      let payloadStart = off + 4;
      if (afc === 0x3) {
        const afLen = bytes[off + 4]!;
        payloadStart = off + 4 + 1 + afLen;
      }
      const sectionStart = payloadStart + 1 + bytes[payloadStart]!;
      return (bytes[sectionStart + 5]! >> 1) & 0x1f;
    };
    const hasAfDiscFlag = (bytes: Uint8Array, packetOffset: number): boolean => {
      const afc = (bytes[packetOffset + 3]! >> 4) & 0x3;
      if (afc !== 0x3) return false;
      const afLen = bytes[packetOffset + 4]!;
      if (afLen === 0) return false;
      return (bytes[packetOffset + 5]! & 0x80) !== 0;
    };

    assert.equal(readPatVersion(before), 0);
    assert.equal(readPatVersion(after), 1);
    // PAT is undisturbed — no AF on either run.
    assert.equal(hasAfDiscFlag(before, firstPacketOf(before, 0)), false);
    assert.equal(hasAfDiscFlag(after, firstPacketOf(after, 0)), false);
    // First video packet (PID 0x100): disc-indicator set in the "after" run,
    // absent in the "before" run.
    assert.equal(hasAfDiscFlag(before, firstPacketOf(before, 0x100)), false);
    assert.equal(hasAfDiscFlag(after, firstPacketOf(after, 0x100)), true);
  });

  it('continues continuity counters across mux() calls on the same instance', () => {
    // Regression: prior to phase 7b.5 the extractor instantiated a fresh muxer
    // per HLS segment, restarting CC at 0 each segment. ffmpeg flagged
    // "Packet corrupt" on every segment boundary. With a single muxer instance
    // CC must be monotonic (mod 16) across calls on any given PID.
    const ext = new Fmp4VideoExtractor();
    ext.setInit(VIDEO_INIT);
    const samples = ext.samples(VIDEO_SEG).map((s) => ({
      data: s.data, pts: s.pts, dts: s.dts, isKeyframe: s.isKeyframe,
    }));
    const muxer = new MpegTsMuxer();
    const segA = muxer.mux(samples);
    const segB = muxer.mux(samples);
    // For each output, scan video-PID packets and capture the first CC.
    const firstVideoCc = (bytes: Uint8Array): number => {
      for (let i = 0; i < bytes.byteLength; i += 188) {
        if (bytes[i] !== 0x47) continue;
        const pid = ((bytes[i + 1]! & 0x1f) << 8) | bytes[i + 2]!;
        if (pid === 0x100) return bytes[i + 3]! & 0x0f;
      }
      throw new Error('no video packet found');
    };
    const lastVideoCc = (bytes: Uint8Array): number => {
      let last = -1;
      for (let i = 0; i < bytes.byteLength; i += 188) {
        if (bytes[i] !== 0x47) continue;
        const pid = ((bytes[i + 1]! & 0x1f) << 8) | bytes[i + 2]!;
        if (pid === 0x100) last = bytes[i + 3]! & 0x0f;
      }
      if (last < 0) throw new Error('no video packet found');
      return last;
    };
    const expectedNextCc = (lastVideoCc(segA) + 1) & 0x0f;
    assert.equal(firstVideoCc(segB), expectedNextCc,
      `second-segment first video CC should continue from first segment's last + 1`);
  });
});

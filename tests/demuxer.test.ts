/*
 * hls-pipe — TS demuxer tests
 *
 * Exercises the phase-4a demuxer against a small ffmpeg-generated MPEG-TS
 * fixture. The fixture is built once with `ffmpeg -f lavfi -i testsrc2 ...`
 * and committed to tests/fixtures/synth-2s.ts. It contains H.264 video +
 * AAC audio, ~2 seconds, ~120 KB.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Demuxer } from '../src/demux/demuxer.js';
import { PACKET_LENGTH, parsePacketHeader, syncOffset } from '../src/demux/ts-packet.js';
import { parsePAT, parsePMT } from '../src/demux/pat-pmt.js';
import { parsePes } from '../src/demux/pes.js';

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'synth-2s.ts'),
);
// Wrap to a "fresh" Uint8Array so .subarray semantics are predictable.
const TS = new Uint8Array(FIXTURE.buffer, FIXTURE.byteOffset, FIXTURE.byteLength);

describe('ts-packet helpers', () => {
  it('syncOffset returns 0 for a well-formed TS file', () => {
    assert.equal(syncOffset(TS), 0);
  });

  it('syncOffset finds alignment when there is leading garbage', () => {
    const padded = new Uint8Array(TS.byteLength + 13);
    padded.fill(0xff, 0, 13);
    padded.set(TS, 13);
    assert.equal(syncOffset(padded), 13);
  });

  it('syncOffset returns -1 for non-TS data', () => {
    const garbage = new Uint8Array(2000);
    garbage.fill(0xff);
    assert.equal(syncOffset(garbage), -1);
  });

  it('parsePacketHeader extracts PID + flags', () => {
    // Packet 1 in our fixture is the PAT (PID 0, PUS=true).
    const h = parsePacketHeader(TS, PACKET_LENGTH);
    assert.equal(h.pid, 0);
    assert.equal(h.payloadUnitStart, true);
    assert.equal(h.adaptationFieldControl, 1);
    assert.equal(h.payloadOffset, PACKET_LENGTH + 4);
  });

  it('parsePacketHeader handles adaptation field present', () => {
    // Packet 3 in our fixture has atf=3 (AF + payload).
    const h = parsePacketHeader(TS, 3 * PACKET_LENGTH);
    assert.equal(h.adaptationFieldControl, 3);
    // Payload offset is past the AF — verify it's within the packet.
    assert.ok(h.payloadOffset > 3 * PACKET_LENGTH + 4);
    assert.ok(h.payloadOffset < (3 + 1) * PACKET_LENGTH);
  });
});

describe('parsePAT', () => {
  it('finds the PMT PID from the fixture PAT', () => {
    // Packet 1 is the PAT. Skip TS header (4) + pointer_field (1).
    const offset = PACKET_LENGTH + 4 + 1;
    const pmtPid = parsePAT(TS, offset);
    // ffmpeg defaults: PMT PID = 0x1000 = 4096
    assert.equal(pmtPid, 4096);
  });
});

describe('parsePMT', () => {
  it('discovers H.264 video + AAC audio streams from the fixture PMT', () => {
    // Packet 2 is the PMT. Skip TS header + pointer_field.
    const offset = 2 * PACKET_LENGTH + 4 + 1;
    const pmt = parsePMT(TS, offset);
    assert.equal(pmt.videoPid, 0x100);
    assert.equal(pmt.videoCodec, 'avc');
    assert.equal(pmt.audioPid, 0x101);
    assert.equal(pmt.audioCodec, 'aac');
  });
});

describe('parsePes', () => {
  it('returns undefined on malformed prefix', () => {
    const bogus = new Uint8Array(32);
    assert.equal(parsePes(bogus), undefined);
  });

  it('returns undefined on truncated header', () => {
    const tooSmall = new Uint8Array([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00]);
    assert.equal(parsePes(tooSmall), undefined);
  });

  it('extracts a PTS from a synthesized PES header', () => {
    // Minimal PES with PTS only (PTS_DTS_flags = 0b10 = 0x80)
    // PTS value: arbitrary 333_333_333 (≈ 1h 1m at 90kHz)
    const pts = 333_333_333;
    // 14-byte header (PES base 9 + PTS 5) + 10-byte payload
    const buf = new Uint8Array(14 + 10);
    buf[0] = 0; buf[1] = 0; buf[2] = 1; // prefix
    buf[3] = 0xe0; // stream_id (video)
    buf[4] = 0; buf[5] = 0; // PES_packet_length = 0 (allowed for video)
    buf[6] = 0x80; // flags 1
    buf[7] = 0x80; // PTS only
    buf[8] = 0x05; // PES_header_data_length = 5 (just PTS)
    // PTS layout: 4-bit prefix (0010) + 3 bits PTS[32..30] + marker '1' + 8 bits
    // PTS[29..22] + 7 bits PTS[21..15] + marker '1' + 8 bits PTS[14..7] + 7 bits
    // PTS[6..0] + marker '1'. Bit-extraction uses divides because JS bit ops
    // truncate to 32-bit.
    buf[9]  = 0x20 | ((Math.floor(pts / 1073741824) & 0x07) << 1) | 0x01; // PTS[32..30]
    buf[10] = Math.floor(pts / 4194304) & 0xff;                          // PTS[29..22]
    buf[11] = ((Math.floor(pts / 32768) & 0x7f) << 1) | 0x01;            // PTS[21..15]
    buf[12] = Math.floor(pts / 128) & 0xff;                              // PTS[14..7]
    buf[13] = ((pts & 0x7f) << 1) | 0x01;                                // PTS[6..0]
    // payload: 10 bytes, immediately following the 14-byte header
    for (let i = 0; i < 10; i++) buf[14 + i] = i;
    const pkt = parsePes(buf);
    assert.ok(pkt, 'parsePes returned undefined');
    assert.equal(pkt!.pts, pts);
    assert.equal(pkt!.dts, pts);
    assert.equal(pkt!.data.byteLength, 10);
    assert.equal(pkt!.data[0], 0);
    assert.equal(pkt!.data[9], 9);
  });
});

describe('Demuxer.demux end-to-end on fixture', () => {
  it('discovers the correct streams + emits both video and audio PES packets', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(TS);

    assert.equal(result.streams.videoPid, 0x100, 'video PID mismatch');
    assert.equal(result.streams.videoCodec, 'avc');
    assert.equal(result.streams.audioPid, 0x101, 'audio PID mismatch');
    assert.equal(result.streams.audioCodec, 'aac');
    assert.equal(result.malformedPackets, 0, 'unexpected malformed packets');

    // ~2s of 25fps video → expect ≥25 video PES packets (1 per frame typically).
    // ~1.7s of AAC at 44.1kHz / 1024 samples ≈ 73 ADTS frames; ffmpeg packs
    // multiple ADTS frames into each audio PES, so 4-6 PES is typical here.
    assert.ok(result.video.length >= 25, `expected ≥25 video PES, got ${result.video.length}`);
    assert.ok(result.audio.length >= 4, `expected ≥4 audio PES, got ${result.audio.length}`);
  });

  it('every PES carries a 90 kHz PTS', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(TS);
    for (const pes of result.video) {
      assert.ok(pes.pts !== undefined, 'video PES missing PTS');
      assert.ok(pes.pts >= 0, 'PTS should be non-negative');
    }
    for (const pes of result.audio) {
      assert.ok(pes.pts !== undefined, 'audio PES missing PTS');
    }
  });

  it('PTS values are monotonically non-decreasing for audio', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(TS);
    let prev = -1;
    for (const pes of result.audio) {
      assert.ok(pes.pts! >= prev, `audio PTS went backwards: ${prev} → ${pes.pts}`);
      prev = pes.pts!;
    }
  });

  it('concatenating PES audio payloads reconstructs the AAC ADTS bytestream', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(TS);
    let totalAudio = 0;
    let firstByte = -1;
    for (const pes of result.audio) {
      if (firstByte === -1 && pes.data.byteLength > 0) firstByte = pes.data[0]!;
      totalAudio += pes.data.byteLength;
    }
    assert.ok(totalAudio > 1000, `audio payload too small: ${totalAudio} bytes`);
    // First byte of an ADTS frame is the sync word's high byte (0xFF).
    assert.equal(firstByte, 0xff, 'first audio byte should be ADTS sync 0xFF');
  });

  it('handles empty input gracefully', () => {
    const demuxer = new Demuxer();
    const result = demuxer.demux(new Uint8Array(0));
    assert.equal(result.video.length, 0);
    assert.equal(result.audio.length, 0);
  });

  it('PMT info persists across demux() calls (live-stream pattern)', () => {
    const demuxer = new Demuxer();
    demuxer.demux(TS);
    // Feed the same fixture again — without re-discovering PMT, the cached
    // PIDs should still match.
    const second = demuxer.demux(TS);
    assert.equal(second.streams.videoPid, 0x100);
    assert.equal(second.streams.audioPid, 0x101);
  });

  it('resetContiguity clears PMT state', () => {
    const demuxer = new Demuxer();
    demuxer.demux(TS);
    demuxer.resetContiguity();
    assert.equal(demuxer.getStreams().videoPid, -1);
    assert.equal(demuxer.getStreams().audioPid, -1);
  });
});

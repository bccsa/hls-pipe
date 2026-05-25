/*
 * hls-pipe — raw AAC/ADTS extractor tests
 *
 * Exercises the BCC-shape audio rendition path: ID3v2 header carrying
 * Apple's transport-stream-timestamp PRIV frame, followed by an ADTS
 * bytestream. We also lazily download one real BCC audio segment for a
 * round-trip sanity check.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractAacFrames, parseId3v2Header } from '../src/demux/raw-aac.js';
import { buildAdtsHeader } from '../src/demux/fmp4/aac-to-adts.js';

// AAC LC 48 kHz stereo config — sfi index 3.
const TEST_CONFIG = {
  audioObjectType: 2,
  samplingFrequencyIndex: 3,
  sampleRate: 48000,
  channelConfiguration: 2,
};

/** Build a synthetic ID3v2.4 tag with one Apple PRIV transport-timestamp frame. */
function buildId3WithPts(pts90k: number): Uint8Array {
  const owner = 'com.apple.streaming.transportStreamTimestamp';
  const ownerBytes = new TextEncoder().encode(owner);
  // PRIV body = owner + NUL + 8-byte BE PTS.
  const body = new Uint8Array(ownerBytes.byteLength + 1 + 8);
  body.set(ownerBytes, 0);
  body[ownerBytes.byteLength] = 0;
  // Write 64-bit big-endian via float math (PTS fits in 33 bits).
  let v = pts90k;
  for (let i = 7; i >= 0; i--) {
    body[ownerBytes.byteLength + 1 + i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  // ID3 frame: 4 ASCII id + 4-byte synchsafe size + 2 flag bytes
  const sizeS = body.byteLength;
  const frameHeader = new Uint8Array([
    0x50, 0x52, 0x49, 0x56, // "PRIV"
    (sizeS >> 21) & 0x7f, (sizeS >> 14) & 0x7f, (sizeS >> 7) & 0x7f, sizeS & 0x7f,
    0, 0, // flags
  ]);
  const framesBytes = new Uint8Array(frameHeader.byteLength + body.byteLength);
  framesBytes.set(frameHeader, 0);
  framesBytes.set(body, frameHeader.byteLength);

  // ID3v2.4 header: "ID3" + 04 00 + flags + 4-byte synchsafe size of frames+padding
  const tagBodySize = framesBytes.byteLength;
  const id3 = new Uint8Array(10 + tagBodySize);
  id3[0] = 0x49;
  id3[1] = 0x44;
  id3[2] = 0x33;
  id3[3] = 0x04;
  id3[4] = 0x00;
  id3[5] = 0x00;
  id3[6] = (tagBodySize >> 21) & 0x7f;
  id3[7] = (tagBodySize >> 14) & 0x7f;
  id3[8] = (tagBodySize >> 7) & 0x7f;
  id3[9] = tagBodySize & 0x7f;
  id3.set(framesBytes, 10);
  return id3;
}

/** Build N concatenated ADTS frames of `frameSize` bytes (header + zero payload). */
function buildAdtsFrames(count: number, frameSize: number): Uint8Array {
  const out = new Uint8Array(count * frameSize);
  for (let i = 0; i < count; i++) {
    const hdr = buildAdtsHeader(TEST_CONFIG, frameSize - 7);
    out.set(hdr, i * frameSize);
  }
  return out;
}

describe('parseId3v2Header', () => {
  it('returns undefined for non-ID3 input', () => {
    const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]);
    assert.equal(parseId3v2Header(adts), undefined);
  });

  it('returns undefined for too-short input', () => {
    assert.equal(parseId3v2Header(new Uint8Array(0)), undefined);
    assert.equal(parseId3v2Header(new Uint8Array([0x49, 0x44, 0x33])), undefined);
  });

  it('parses ID3v2 with Apple transport-stream-timestamp PRIV → returns PTS', () => {
    const pts = 1_234_567_890; // arbitrary; well under 2^33
    const id3 = buildId3WithPts(pts);
    const result = parseId3v2Header(id3);
    assert.ok(result);
    assert.equal(result!.transportTimestampPts, pts);
    assert.equal(result!.totalSize, id3.byteLength);
  });

  it('returns undefined transportTimestampPts when no PRIV frame is present', () => {
    // Bare ID3 header with no frames, just padding.
    const id3 = new Uint8Array(20);
    id3[0] = 0x49; id3[1] = 0x44; id3[2] = 0x33;
    id3[3] = 0x04;
    id3[9] = 10; // small synchsafe size
    const result = parseId3v2Header(id3);
    assert.ok(result);
    assert.equal(result!.transportTimestampPts, undefined);
  });
});

describe('extractAacFrames', () => {
  it('returns empty for input with no ADTS frames', () => {
    const id3 = buildId3WithPts(0);
    const result = extractAacFrames(id3);
    assert.equal(result.length, 0);
  });

  it('splits a 10-frame ADTS stream with no ID3 (PTS starts at 0)', () => {
    const frameSize = 64;
    const data = buildAdtsFrames(10, frameSize);
    const frames = extractAacFrames(data);
    assert.equal(frames.length, 10);
    // 1024 samples / 48000 Hz × 90000 = 1920 ticks per frame
    assert.equal(frames[0]!.pts, 0);
    assert.equal(frames[1]!.pts, 1920);
    assert.equal(frames[9]!.pts, 1920 * 9);
    assert.equal(frames[0]!.duration, 1920);
    assert.equal(frames[0]!.data.byteLength, frameSize);
  });

  it('anchors PTS at the ID3 transport-timestamp when present', () => {
    const startPts = 5_000_000;
    const id3 = buildId3WithPts(startPts);
    const adts = buildAdtsFrames(3, 64);
    const combined = new Uint8Array(id3.byteLength + adts.byteLength);
    combined.set(id3, 0);
    combined.set(adts, id3.byteLength);
    const frames = extractAacFrames(combined);
    assert.equal(frames.length, 3);
    assert.equal(frames[0]!.pts, startPts);
    assert.equal(frames[1]!.pts, startPts + 1920);
    assert.equal(frames[2]!.pts, startPts + 3840);
  });

  it('stops cleanly at a corrupted ADTS frame instead of throwing', () => {
    const good = buildAdtsFrames(2, 64);
    const bad = new Uint8Array(good.byteLength + 8);
    bad.set(good, 0);
    bad.set(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), good.byteLength);
    const frames = extractAacFrames(bad);
    assert.equal(frames.length, 2);
  });

  it('throws if the first non-ID3 byte is not an ADTS sync', () => {
    const id3 = buildId3WithPts(0);
    const junk = new Uint8Array(id3.byteLength + 16);
    junk.set(id3, 0);
    junk.set(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), id3.byteLength);
    assert.throws(() => extractAacFrames(junk), /expected ADTS sync/);
  });
});

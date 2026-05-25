/*
 * hls-pipe — audio-format detection tests
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  detectAudioFormat,
  detectByContent,
  detectByUri,
} from '../src/stream/audio-format.js';

describe('detectByUri', () => {
  it('recognizes .aac', () => {
    assert.equal(detectByUri('https://x/audio/seg.aac'), 'aac');
    assert.equal(detectByUri('https://x/audio/seg.aac?token=abc'), 'aac');
    assert.equal(detectByUri('https://x/Path/SEG.AAC'), 'aac');
  });

  it('recognizes .ts and .m2ts', () => {
    assert.equal(detectByUri('https://x/video/s.ts'), 'ts');
    assert.equal(detectByUri('https://x/video/s.m2ts'), 'ts');
    assert.equal(detectByUri('https://x/s.ts?Signature=abc&Key=def'), 'ts');
  });

  it('recognizes fMP4-family extensions', () => {
    assert.equal(detectByUri('https://x/seg.m4s'), 'fmp4');
    assert.equal(detectByUri('https://x/seg.m4a'), 'fmp4');
    assert.equal(detectByUri('https://x/init.mp4'), 'fmp4');
  });

  it('returns unknown for ambiguous suffixes', () => {
    assert.equal(detectByUri('https://x/no-suffix'), 'unknown');
    assert.equal(detectByUri('https://x/seg.bin'), 'unknown');
  });
});

describe('detectByContent', () => {
  it('detects AAC ADTS sync word 0xFFFx', () => {
    const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x00, 0x00]);
    assert.equal(detectByContent(adts), 'aac');
    // Other valid sync nibbles in the high half
    const adts2 = new Uint8Array([0xff, 0xf9, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(detectByContent(adts2), 'aac');
  });

  it('detects MPEG-TS sync byte', () => {
    const ts = new Uint8Array(200);
    ts[0] = 0x47;
    ts[188] = 0x47;
    assert.equal(detectByContent(ts), 'ts');
  });

  it('detects fMP4 ftyp box', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, // box length
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x69, 0x73, 0x6f, 0x6d, // major brand 'isom'
    ]);
    assert.equal(detectByContent(bytes), 'fmp4');
  });

  it('returns unknown for unrecognized payloads', () => {
    const random = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00]);
    assert.equal(detectByContent(random), 'unknown');
  });

  it('returns unknown for too-short buffers (< 4 bytes)', () => {
    assert.equal(detectByContent(new Uint8Array(0)), 'unknown');
    assert.equal(detectByContent(new Uint8Array([0xff, 0xf1])), 'unknown');
    assert.equal(detectByContent(new Uint8Array([0xff, 0xf1, 0x00])), 'unknown');
  });
});

describe('detectAudioFormat (combined)', () => {
  it('prefers URI hint over content sniff', () => {
    // URI says .aac, content would sniff as TS (sync byte) — URI wins.
    const ts = new Uint8Array(200);
    ts[0] = 0x47;
    ts[188] = 0x47;
    assert.equal(detectAudioFormat('https://x/x.aac', ts), 'aac');
  });

  it('falls through to content sniff when URI is ambiguous', () => {
    const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80]);
    assert.equal(detectAudioFormat('https://x/no-suffix', adts), 'aac');
  });

  it('returns unknown when both URI and content are unrecognized', () => {
    assert.equal(detectAudioFormat('https://x/blob', new Uint8Array([0, 0, 0, 0])), 'unknown');
  });
});

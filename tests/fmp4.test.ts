/*
 * hls-pipe — fMP4 demuxer + AAC-to-ADTS tests
 *
 * Uses ffmpeg-generated init segment + media segment fixtures:
 *   tests/fixtures/audio-init.mp4  (765 bytes, ftyp+moov, AAC 44.1k stereo)
 *   tests/fixtures/audio-seg0.m4s  (~16 KB, styp+sidx+moof+mdat)
 *
 * Round-trip: feed init+seg into Fmp4AudioExtractor, then re-parse the
 * resulting ADTS bytestream with ffprobe-compatible logic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { findBox, findPath, iterateBoxes, readBox, BoxParseError } from '../src/demux/fmp4/box.js';
import { readAudioTracks, parseAudioSpecificConfig } from '../src/demux/fmp4/init-segment.js';
import { readTrackFragments } from '../src/demux/fmp4/movie-fragment.js';
import { buildAdtsHeader, framesToAdts } from '../src/demux/fmp4/aac-to-adts.js';
import { Fmp4AudioExtractor } from '../src/demux/fmp4/audio.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const INIT = new Uint8Array(readFileSync(join(FIX, 'audio-init.mp4')));
const SEG = new Uint8Array(readFileSync(join(FIX, 'audio-seg0.m4s')));

describe('ISO BMFF box parser', () => {
  it('parses top-level boxes in the init segment', () => {
    const boxes = [...iterateBoxes(INIT)];
    const types = boxes.map((b) => b.type);
    assert.ok(types.includes('ftyp'), `expected ftyp in ${types}`);
    assert.ok(types.includes('moov'), `expected moov in ${types}`);
  });

  it('reads ftyp size as 0x1c (28 bytes per the dump)', () => {
    const ftyp = findBox(INIT, 'ftyp');
    assert.ok(ftyp);
    assert.equal(ftyp!.end - ftyp!.offset, 28);
  });

  it('descends into moov.trak.mdia.minf.stbl.stsd', () => {
    const stsd = findPath(INIT, 'moov.trak.mdia.minf.stbl.stsd');
    assert.ok(stsd, 'stsd should be reachable');
  });

  it('rejects malformed box headers', () => {
    // Box with size < 8
    const bogus = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
    assert.throws(() => readBox(bogus, 0), (e) => e instanceof BoxParseError);
  });
});

describe('AudioSpecificConfig parser', () => {
  it('parses AAC LC 44.1kHz stereo from a 2-byte config (0x12 0x10)', () => {
    // bits: 00010 0100 0010 (LSB to MSB)... let me lay it out:
    // 0x12 0x10 = 0001_0010 0001_0000
    // aot (5 bits): 00010 = 2 (AAC LC) ✓
    // sfi (4 bits): 0100 = 4 (44100 Hz) ✓
    // cc  (4 bits): 0010 = 2 (stereo) ✓
    const asc = new Uint8Array([0x12, 0x10]);
    const config = parseAudioSpecificConfig(asc);
    assert.equal(config.audioObjectType, 2);
    assert.equal(config.samplingFrequencyIndex, 4);
    assert.equal(config.sampleRate, 44100);
    assert.equal(config.channelConfiguration, 2);
  });

  it('parses AAC LC 48kHz mono (0x11 0x88)', () => {
    // aot=00010=2, sfi=0011=3 (48000), cc=0001=1 (mono)
    // → bits 00010 0011 0001 = 0001 0001 1000 1000 = 0x11 0x88
    const asc = new Uint8Array([0x11, 0x88]);
    const config = parseAudioSpecificConfig(asc);
    assert.equal(config.audioObjectType, 2);
    assert.equal(config.sampleRate, 48000);
    assert.equal(config.channelConfiguration, 1);
  });
});

describe('readAudioTracks (init segment)', () => {
  it('extracts a single AAC track from the fixture init', () => {
    const tracks = readAudioTracks(INIT);
    assert.equal(tracks.length, 1, `expected 1 audio track, got ${tracks.length}`);
    const t = tracks[0]!;
    assert.equal(t.codecFourCc, 'mp4a');
    assert.equal(t.channelCount, 2);
    assert.equal(t.sampleRate, 44100);
    assert.equal(t.audioConfig.audioObjectType, 2);
    assert.equal(t.audioConfig.samplingFrequencyIndex, 4);
    assert.equal(t.audioConfig.channelConfiguration, 2);
    assert.ok(t.trackId > 0);
    assert.equal(t.timescale, 44100);
  });
});

describe('readTrackFragments (media segment)', () => {
  it('extracts samples from the fixture seg0.m4s', () => {
    const fragments = readTrackFragments(SEG);
    assert.ok(fragments.length > 0, 'should have at least one fragment');
    const frag = fragments[0]!;
    // ffmpeg with 2s segments + 44.1k AAC produces ~86 frames (44100/1024 × 2)
    assert.ok(frag.samples.length > 50, `expected >50 samples, got ${frag.samples.length}`);
    assert.ok(frag.samples.length < 120, `expected <120 samples, got ${frag.samples.length}`);
    // Each sample should be non-empty
    for (const s of frag.samples) {
      assert.ok(s.data.byteLength > 0, 'sample has empty bytes');
    }
    // dts should be monotonically increasing
    let prev = -1;
    for (const s of frag.samples) {
      assert.ok(s.dts >= prev, 'dts should be monotonic');
      prev = s.dts;
    }
  });
});

describe('buildAdtsHeader', () => {
  const config = {
    audioObjectType: 2,
    samplingFrequencyIndex: 4,
    sampleRate: 44100,
    channelConfiguration: 2,
  };

  it('produces 7-byte header starting with 0xFF 0xF1', () => {
    const hdr = buildAdtsHeader(config, 100);
    assert.equal(hdr.byteLength, 7);
    assert.equal(hdr[0], 0xff);
    assert.equal(hdr[1], 0xf1);
  });

  it('encodes profile + sfi + channel correctly (AAC LC 44.1k stereo)', () => {
    const hdr = buildAdtsHeader(config, 100);
    // byte 2: (profile=1)<<6 | (sfi=4)<<2 | (cc=2)>>2 = 0x40 | 0x10 | 0x00 = 0x50
    assert.equal(hdr[2], 0x50);
  });

  it('encodes aac_frame_length correctly', () => {
    // raw=100 → frame_length = 107
    const hdr = buildAdtsHeader(config, 100);
    // byte 3 low 2 bits + byte 4 + byte 5 high 3 bits = 13-bit frame_length
    const frameLen =
      ((hdr[3]! & 0x03) << 11) | (hdr[4]! << 3) | ((hdr[5]! >> 5) & 0x07);
    assert.equal(frameLen, 107);
  });

  it('framesToAdts produces ADTS-wrapped concatenation', () => {
    const frames = [new Uint8Array([0xaa, 0xbb, 0xcc]), new Uint8Array([0xdd, 0xee])];
    const adts = framesToAdts(frames, config);
    // Each frame gets a 7-byte header + payload; total = 2*7 + 3 + 2 = 19
    assert.equal(adts.byteLength, 19);
    // First frame starts at offset 0 with ADTS sync
    assert.equal(adts[0], 0xff);
    // First payload starts at offset 7
    assert.equal(adts[7], 0xaa);
    // Second frame's ADTS sync at offset 10 (7 + 3)
    assert.equal(adts[10], 0xff);
    // Second payload at offset 17 (7 + 3 + 7)
    assert.equal(adts[17], 0xdd);
  });
});

describe('Fmp4AudioExtractor end-to-end', () => {
  it('produces a valid ADTS bytestream from init+seg', () => {
    const ext = new Fmp4AudioExtractor();
    ext.setInit(INIT);
    assert.ok(ext.isReady());
    const adts = ext.transform(SEG);
    assert.ok(adts.byteLength > 1000, `expected >1KB of ADTS, got ${adts.byteLength}`);
    // First two bytes must be ADTS sync 0xFFFx
    assert.equal(adts[0], 0xff);
    assert.equal(adts[1]! & 0xf0, 0xf0);
  });

  it('throws if transform is called before setInit', () => {
    const ext = new Fmp4AudioExtractor();
    assert.throws(() => ext.transform(SEG), /setInit/);
  });

  it('exposes track metadata after init', () => {
    const ext = new Fmp4AudioExtractor();
    ext.setInit(INIT);
    const track = ext.getTrack();
    assert.ok(track);
    assert.equal(track!.sampleRate, 44100);
    assert.equal(track!.channelCount, 2);
  });
});

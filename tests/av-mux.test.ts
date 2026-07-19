/*
 * hls-pipe — phase 7b.3.2 AV-mux tests
 *
 * End-to-end round-trip: feed the fMP4 audio + video fixtures through
 * Fmp4VideoExtractor + Fmp4AudioExtractor + MpegTsMuxer.muxAv, then re-parse
 * the resulting TS bytestream with our own phase-4a Demuxer and verify both
 * PIDs are present with the right codecs.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Fmp4AudioExtractor } from '../src/demux/fmp4/audio.js';
import { Fmp4VideoExtractor } from '../src/demux/fmp4/video.js';
import { MpegTsMuxer } from '../src/mux/ts/muxer.js';
import { Demuxer } from '../src/demux/demuxer.js';
import { TsCanonicalMode } from '../src/output/output-mode.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const AUDIO_INIT = new Uint8Array(readFileSync(join(FIX, 'audio-init.mp4')));
const AUDIO_SEG = new Uint8Array(readFileSync(join(FIX, 'audio-seg0.m4s')));
const VIDEO_INIT = new Uint8Array(readFileSync(join(FIX, 'video-init.mp4')));
const VIDEO_SEG = new Uint8Array(readFileSync(join(FIX, 'video-seg0.m4s')));

describe('Fmp4AudioExtractor.frames', () => {
  it('produces per-frame ADTS + PTS in 90 kHz', () => {
    const ext = new Fmp4AudioExtractor();
    ext.setInit(AUDIO_INIT);
    const frames = ext.frames(AUDIO_SEG);
    assert.ok(frames.length > 50, `expected > 50 frames, got ${frames.length}`);
    // Each frame: 7-byte ADTS header + AAC raw_data_block payload.
    for (const f of frames) {
      assert.equal(f.data[0], 0xff, 'frame should start with ADTS sync');
      assert.equal(f.data[1]! & 0xf0, 0xf0);
      assert.ok(f.data.byteLength > 7);
    }
    // PTS must be monotonic.
    let prev = -1;
    for (const f of frames) {
      assert.ok(f.pts >= prev, `pts went backward: ${prev} → ${f.pts}`);
      prev = f.pts;
    }
  });
});

describe('MpegTsMuxer.muxAv', () => {
  it('produces a multi-stream TS with PMT announcing both PIDs', () => {
    const vExt = new Fmp4VideoExtractor();
    vExt.setInit(VIDEO_INIT);
    const aExt = new Fmp4AudioExtractor();
    aExt.setInit(AUDIO_INIT);

    const video = vExt.samples(VIDEO_SEG).map((s) => ({
      data: s.data,
      pts: s.pts,
      dts: s.dts,
      isKeyframe: s.isKeyframe,
    }));
    const audio = aExt.frames(AUDIO_SEG).map((f) => ({ data: f.data, pts: f.pts }));

    const ts = new MpegTsMuxer().muxAv({ video, audio });
    assert.ok(ts.byteLength > 0);
    assert.equal(ts[0], 0x47);
    assert.equal(ts.byteLength % 188, 0);

    // Demux the muxed TS — PMT should announce video PID 0x100 + audio PID 0x101.
    const demuxer = new Demuxer();
    const result = demuxer.demux(ts);
    assert.equal(result.streams.videoPid, 0x100);
    assert.equal(result.streams.videoCodec, 'avc');
    assert.equal(result.streams.audioPid, 0x101);
    assert.equal(result.streams.audioCodec, 'aac');
    assert.ok(result.video.length > 0, 'no video PES');
    assert.ok(result.audio.length > 0, 'no audio PES');
  });

  it('stamps PCR on every video access unit, not only keyframes', () => {
    // ISO 13818-1 wants PCR ≤ 100 ms apart; keyframe-only PCR (one per GOP)
    // left receivers anchoring their timelines up to a GOP apart (measured
    // 1.5 s A/V skew after a downstream re-mux). Every video AU's first TS
    // packet must carry PCR, at the AU's DTS.
    const video = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true },
      { data: new Uint8Array([0, 0, 0, 1, 0x41]), pts: 3600, dts: 3600, isKeyframe: false },
      { data: new Uint8Array([0, 0, 0, 1, 0x41]), pts: 7200, dts: 7200, isKeyframe: false },
    ];
    const ts = new MpegTsMuxer().muxAv({ video, audio: [] });
    const pcrs: number[] = [];
    for (let off = 0; off + 188 <= ts.byteLength; off += 188) {
      const pid = ((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!;
      const afc = (ts[off + 3]! >> 4) & 0x3;
      if (pid !== 0x100 || !(afc & 0x2) || ts[off + 4]! < 7) continue;
      if (!(ts[off + 5]! & 0x10)) continue; // PCR flag
      const base =
        ts[off + 6]! * 0x2000000 +
        ts[off + 7]! * 0x20000 +
        ts[off + 8]! * 0x200 +
        ts[off + 9]! * 2 +
        (ts[off + 10]! >> 7);
      pcrs.push(base);
    }
    assert.deepEqual(pcrs, [0, 3600, 7200], 'expected one PCR per AU at its DTS');
  });

  it('audio PES carries the correct PTS', () => {
    const aExt = new Fmp4AudioExtractor();
    aExt.setInit(AUDIO_INIT);
    const frames = aExt.frames(AUDIO_SEG).slice(0, 5);
    const audio = frames.map((f) => ({ data: f.data, pts: f.pts }));

    const ts = new MpegTsMuxer().muxAv({ video: [], audio });
    const demuxer = new Demuxer();
    const result = demuxer.demux(ts);
    // Five PES packets out, in PTS-ascending order.
    assert.equal(result.audio.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(result.audio[i]!.pts, frames[i]!.pts, `PES ${i} PTS mismatch`);
    }
  });

  it('interleaves video and audio PES by DTS', () => {
    // Two video samples at DTS 0 + 9000; two audio samples at PTS 4500 + 13500.
    // After interleaving, the order should be: v(0), a(4500), v(9000), a(13500).
    const video = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true },
      { data: new Uint8Array([0, 0, 0, 1, 0x41]), pts: 9000, dts: 9000, isKeyframe: false },
    ];
    const audio = [
      { data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 4500 },
      { data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 13500 },
    ];
    const ts = new MpegTsMuxer().muxAv({ video, audio });
    const demuxer = new Demuxer();
    const result = demuxer.demux(ts);
    assert.equal(result.video.length, 2);
    assert.equal(result.audio.length, 2);
    assert.equal(result.video[0]!.pts, 0);
    assert.equal(result.audio[0]!.pts, 4500);
    assert.equal(result.video[1]!.pts, 9000);
    assert.equal(result.audio[1]!.pts, 13500);
  });
});

describe('TsCanonicalMode.resetContiguity', () => {
  // Regression: seek() called resetContiguity which cleared initLoaded, but
  // the extractor only re-fetches EXT-X-MAP when its URI changes. A seek
  // within the same variant left the next segment without an init and threw
  // "extractVideoSamples called before setInit" mid-playback.
  it('keeps the fMP4 init loaded so the next segment still extracts', () => {
    const mode = new TsCanonicalMode();
    mode.setInit(VIDEO_INIT);
    mode.resetContiguity();
    const samples = mode.extractVideoSamples(VIDEO_SEG);
    assert.ok(samples.length > 0, 'expected samples after resetContiguity');
  });

  it('transform() still works on fMP4 bytes after resetContiguity', () => {
    const mode = new TsCanonicalMode();
    mode.setInit(VIDEO_INIT);
    mode.resetContiguity();
    const ts = mode.transform(VIDEO_SEG);
    assert.ok(ts.byteLength > 0);
    assert.equal(ts[0], 0x47);
  });
});

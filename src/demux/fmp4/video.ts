/*
 * hls-pipe — fMP4 video rendition extractor
 *
 * Stateful: feed the init segment once via setInit(), then call samples() on
 * each media segment. Returns per-sample structured info (PTS/DTS + Annex-B
 * NAL bytes with SPS/PPS injected on keyframes).
 *
 * Mirrors the audio façade (`src/demux/fmp4/audio.ts`) but the conversion
 * is fMP4 length-prefixed-NAL → Annex-B (rather than raw AAC → ADTS).
 */

import { readVideoTracks, type VideoTrackInfo } from './avc-config.js';
import { readTrackFragments } from './movie-fragment.js';
import { avcNalType, AvcNalType } from '../video/avc.js';

export interface VideoSample {
  /** Annex-B encoded NAL units for this access unit, including SPS/PPS on keyframes. */
  data: Uint8Array;
  /** Decode time in 90 kHz units (the MPEG-TS / PES timescale). */
  dts: number;
  /** Presentation time in 90 kHz units (= dts + cts). */
  pts: number;
  /** Per-sample duration in 90 kHz units. */
  duration: number;
  /** True if this sample contains an IDR NAL (random access point). */
  isKeyframe: boolean;
}

/** PTS / DTS in MPEG-TS PES are always in 90 kHz units (ISO 13818-1). */
const PTS_TIMESCALE = 90000;

export class Fmp4VideoExtractor {
  private track: VideoTrackInfo | undefined;
  /**
   * Forward PTS shift (90 kHz units) accumulated across fragments. Some CMAF
   * encoders use trun v1 with negative composition_time_offset (typically
   * −1..−3 frames for B-frame priming): valid in ISO BMFF when an edit list
   * compensates, but MPEG-TS PES requires PTS ≥ DTS. We track the running
   * max(−min_cts) across all fragments seen and apply it uniformly so the
   * shift is monotonic — preventing per-fragment hops in the timeline.
   * Cost: audio leads video by this constant (one B-frame ≈ 40-80 ms on
   * 25-50 fps content), which is well within player sync tolerance.
   */
  private ptsShift = 0;

  setInit(initSegment: Uint8Array): void {
    const tracks = readVideoTracks(initSegment);
    if (tracks.length === 0) {
      throw new Error('fMP4 init segment contains no video track');
    }
    const track = tracks[0]!;
    if (!track.avc) {
      throw new Error(`unsupported video codec "${track.codecFourCc}" — phase 7b.3 supports avc1/avc3`);
    }
    this.track = track;
  }

  isReady(): boolean {
    return this.track !== undefined;
  }

  getTrack(): VideoTrackInfo | undefined {
    return this.track;
  }

  /** Current accumulated PTS shift in 90 kHz units. Diagnostic / test hook. */
  getPtsShift(): number {
    return this.ptsShift;
  }

  /** Returns all video samples in `mediaSegment`, ordered by DTS. */
  samples(mediaSegment: Uint8Array): VideoSample[] {
    if (!this.track) throw new Error('Fmp4VideoExtractor.samples called before setInit');
    const avc = this.track.avc!;
    const trackId = this.track.trackId;
    const timescale = this.track.timescale;
    const fragments = readTrackFragments(mediaSegment);
    const out: VideoSample[] = [];

    // Scale track-timescale values to the PES 90 kHz domain. We round to
    // nearest to avoid drift; for typical timescales (90000 or a divisor
    // of 90000 like 12800) this is exact or near-exact.
    const toPts = (v: number): number => Math.round((v * PTS_TIMESCALE) / timescale);

    for (const frag of fragments) {
      if (frag.trackId !== trackId) continue;
      for (const sample of frag.samples) {
        const nalUnits = splitLengthPrefixed(sample.data, avc.lengthSize);
        const keyframe = nalUnits.some((u) => avcNalType({ data: u }) === AvcNalType.IDR);
        const annexB = toAnnexB(nalUnits, keyframe ? avc.spsList : undefined, keyframe ? avc.ppsList : undefined);
        out.push({
          data: annexB,
          dts: toPts(sample.dts),
          pts: toPts(sample.dts + sample.cts),
          duration: toPts(sample.duration),
          isKeyframe: keyframe,
        });
      }
    }

    // Negative-CTS fixup: ensure PTS ≥ DTS for every sample in TS output.
    let needShift = this.ptsShift;
    for (const s of out) {
      const deficit = s.dts - s.pts;
      if (deficit > needShift) needShift = deficit;
    }
    if (needShift > 0) {
      this.ptsShift = needShift;
      for (const s of out) s.pts += needShift;
    }

    return out;
  }
}

/**
 * Split a length-prefixed NAL unit run into individual NAL bytes.
 *
 * Length size is from avcC's `lengthSizeMinusOne + 1` field — almost always 4
 * in practice. The length itself is big-endian.
 */
export function splitLengthPrefixed(data: Uint8Array, lengthSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = 0;
  while (cursor + lengthSize <= data.byteLength) {
    let nalSize = 0;
    if (lengthSize === 4) {
      nalSize = view.getUint32(cursor, false);
    } else if (lengthSize === 2) {
      nalSize = view.getUint16(cursor, false);
    } else if (lengthSize === 1) {
      nalSize = data[cursor]!;
    } else {
      throw new Error(`unsupported NAL lengthSize ${lengthSize}`);
    }
    cursor += lengthSize;
    if (nalSize === 0 || cursor + nalSize > data.byteLength) break;
    out.push(data.subarray(cursor, cursor + nalSize));
    cursor += nalSize;
  }
  return out;
}

/**
 * Convert a list of NAL units to Annex-B encoding. Each NAL gets a 4-byte
 * start code prefix (`00 00 00 01`). When sps/pps are provided (keyframe
 * case), they're prepended in that order, in front of an AUD if present.
 *
 * We don't bother stripping emulation-prevention bytes since the input is
 * already NAL bytes that include any needed escaping.
 */
export function toAnnexB(
  nalUnits: Uint8Array[],
  sps?: Uint8Array[],
  pps?: Uint8Array[],
): Uint8Array {
  const all: Uint8Array[] = [];
  if (sps && sps.length > 0) for (const s of sps) all.push(s);
  if (pps && pps.length > 0) for (const p of pps) all.push(p);
  for (const n of nalUnits) all.push(n);

  // Pre-compute size: 4-byte start code + nal length, per NAL.
  let total = 0;
  for (const n of all) total += 4 + n.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const n of all) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 1;
    offset += 4;
    out.set(n, offset);
    offset += n.byteLength;
  }
  return out;
}

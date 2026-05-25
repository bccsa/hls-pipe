/*
 * hls-pipe — fMP4 movie-fragment / sample iteration
 *
 * Fresh module. A CMAF media segment contains styp (optional) + moof + mdat:
 *
 *   moof
 *     mfhd (sequence_number)
 *     traf (one per track in the fragment)
 *       tfhd (track fragment header — default duration/size/flags, base_data_offset)
 *       tfdt (track fragment decode time — PTS anchor in track timescale)
 *       trun (track run — per-sample sizes/durations/flags/cts_offset)
 *   mdat (raw sample bytes — one tightly-packed concatenation)
 *
 * trun gives us the array of samples; mdat is the byte pool we slice into.
 * The data_offset on trun, if present, points into the segment (relative
 * to moof's start) where the first sample byte lives.
 *
 * Phase 7b.1: extract each sample as a `{data, dts}` pair. We ignore CTS
 * offsets for audio (PTS == DTS for AAC). Video remux (phase 7b.3) will
 * separate them.
 */

import { findChild, findChildren, type Box } from './box.js';

export interface FragmentSample {
  data: Uint8Array;
  /** Per-sample duration in track timescale units. */
  duration: number;
  /** Decode time in track timescale units (track-level monotonic). */
  dts: number;
  /**
   * Composition time offset in track timescale units. For audio + baseline
   * video this is always 0 (PTS = DTS); for B-frame video PTS = DTS + cts.
   * Encoded as a signed 32-bit value in trun (since ISO 14496-12 v2014).
   */
  cts: number;
}

export interface TrackFragment {
  trackId: number;
  baseDecodeTime: number;
  samples: FragmentSample[];
}

export interface FragmentParseOptions {
  /** Per-track defaults from the init segment's `trex` boxes. */
  defaults?: Map<number, TrackDefaults>;
}

export interface TrackDefaults {
  defaultSampleDuration?: number;
  defaultSampleSize?: number;
  defaultSampleFlags?: number;
}

/**
 * Parse all moof + mdat pairs in `segment` and return per-track sample lists.
 * Most CMAF segments contain a single moof+mdat pair, but the spec allows
 * multiple — we handle either.
 */
export function readTrackFragments(
  segment: Uint8Array,
  options: FragmentParseOptions = {},
): TrackFragment[] {
  const out: TrackFragment[] = [];
  let cursor = 0;
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);

  while (cursor + 8 <= segment.byteLength) {
    const size = view.getUint32(cursor, false);
    const type = readType4(segment, cursor);
    const boxEnd = size === 0 ? segment.byteLength : cursor + size;

    if (type === 'moof') {
      const moof: Box = {
        type,
        offset: cursor,
        end: boxEnd,
        payloadOffset: cursor + 8,
        data: segment,
      };
      // Locate the immediately-following mdat (advance cursor to scan).
      let mdatCursor = boxEnd;
      let mdat: Box | undefined;
      while (mdatCursor + 8 <= segment.byteLength) {
        const sz = view.getUint32(mdatCursor, false);
        const t = readType4(segment, mdatCursor);
        const end = sz === 0 ? segment.byteLength : mdatCursor + sz;
        if (t === 'mdat') {
          mdat = { type: t, offset: mdatCursor, end, payloadOffset: mdatCursor + 8, data: segment };
          break;
        }
        mdatCursor = end;
        if (sz === 0) break;
      }
      if (!mdat) throw new MovieFragmentError(`moof at offset ${cursor} has no following mdat`);

      for (const traf of findChildren(moof, 'traf')) {
        out.push(readTrackFragment(moof, traf, mdat, options.defaults));
      }
    }
    if (size === 0) break;
    cursor = boxEnd;
  }
  return out;
}

function readTrackFragment(
  moof: Box,
  traf: Box,
  mdat: Box,
  defaults?: Map<number, TrackDefaults>,
): TrackFragment {
  const tfhd = findChild(traf, 'tfhd');
  if (!tfhd) throw new MovieFragmentError('traf missing tfhd');
  const tfhdInfo = readTfhd(tfhd);
  const trackDefaults = defaults?.get(tfhdInfo.trackId) ?? {};

  const tfdt = findChild(traf, 'tfdt');
  const baseDecodeTime = tfdt ? readTfdt(tfdt) : 0;

  // A traf may contain multiple trun boxes (rare); concatenate their samples.
  const truns = findChildren(traf, 'trun');
  if (truns.length === 0) throw new MovieFragmentError('traf has no trun');

  // Per spec: data_offset in trun is relative to the start of the moof,
  // unless tfhd has the base_data_offset_present flag (rare in CMAF).
  let baseDataOffset = moof.offset;
  if (tfhdInfo.baseDataOffset !== undefined) {
    // base_data_offset is relative to the start of the file; segment is the
    // file from our perspective, so use the offset directly.
    baseDataOffset = tfhdInfo.baseDataOffset;
  }

  const samples: FragmentSample[] = [];
  let runDts = baseDecodeTime;
  let cumulativeDataOffset = baseDataOffset;

  for (const trun of truns) {
    const runSamples = readTrun(trun, tfhdInfo, trackDefaults);
    let sampleByteOffset = cumulativeDataOffset + runSamples.dataOffset;
    for (const s of runSamples.samples) {
      if (sampleByteOffset < mdat.payloadOffset || sampleByteOffset + s.size > mdat.end) {
        throw new MovieFragmentError(
          `sample bytes (${sampleByteOffset}..${sampleByteOffset + s.size}) escape mdat (${mdat.payloadOffset}..${mdat.end})`,
        );
      }
      samples.push({
        data: moof.data.subarray(sampleByteOffset, sampleByteOffset + s.size),
        duration: s.duration,
        dts: runDts,
        cts: s.cts,
      });
      sampleByteOffset += s.size;
      runDts += s.duration;
    }
    cumulativeDataOffset = sampleByteOffset;
  }

  return { trackId: tfhdInfo.trackId, baseDecodeTime, samples };
}

interface TfhdInfo {
  trackId: number;
  baseDataOffset?: number;
  defaultSampleDuration?: number;
  defaultSampleSize?: number;
  defaultSampleFlags?: number;
}

function readTfhd(tfhd: Box): TfhdInfo {
  const view = new DataView(tfhd.data.buffer, tfhd.data.byteOffset, tfhd.data.byteLength);
  let cursor = tfhd.payloadOffset;
  const versionFlags = view.getUint32(cursor, false);
  const flags = versionFlags & 0xffffff;
  cursor += 4;
  const trackId = view.getUint32(cursor, false);
  cursor += 4;
  const info: TfhdInfo = { trackId };
  if (flags & 0x000001) {
    // base_data_offset_present — 64-bit
    const hi = view.getUint32(cursor, false);
    const lo = view.getUint32(cursor + 4, false);
    info.baseDataOffset = hi * 0x100000000 + lo;
    cursor += 8;
  }
  if (flags & 0x000002) cursor += 4; // sample_description_index_present (we ignore the value)
  if (flags & 0x000008) {
    info.defaultSampleDuration = view.getUint32(cursor, false);
    cursor += 4;
  }
  if (flags & 0x000010) {
    info.defaultSampleSize = view.getUint32(cursor, false);
    cursor += 4;
  }
  if (flags & 0x000020) {
    info.defaultSampleFlags = view.getUint32(cursor, false);
    cursor += 4;
  }
  return info;
}

function readTfdt(tfdt: Box): number {
  const view = new DataView(tfdt.data.buffer, tfdt.data.byteOffset, tfdt.data.byteLength);
  const versionFlags = view.getUint32(tfdt.payloadOffset, false);
  const version = (versionFlags >>> 24) & 0xff;
  if (version === 0) {
    return view.getUint32(tfdt.payloadOffset + 4, false);
  } else {
    const hi = view.getUint32(tfdt.payloadOffset + 4, false);
    const lo = view.getUint32(tfdt.payloadOffset + 8, false);
    return hi * 0x100000000 + lo;
  }
}

interface TrunSampleSpec {
  duration: number;
  size: number;
  cts: number;
}

interface TrunData {
  /** Byte offset of first sample's bytes, relative to baseDataOffset. */
  dataOffset: number;
  samples: TrunSampleSpec[];
}

function readTrun(trun: Box, tfhd: TfhdInfo, defaults: TrackDefaults): TrunData {
  const view = new DataView(trun.data.buffer, trun.data.byteOffset, trun.data.byteLength);
  let cursor = trun.payloadOffset;
  const versionFlags = view.getUint32(cursor, false);
  const flags = versionFlags & 0xffffff;
  cursor += 4;
  const sampleCount = view.getUint32(cursor, false);
  cursor += 4;
  let dataOffset = 0;
  if (flags & 0x000001) {
    dataOffset = view.getInt32(cursor, false);
    cursor += 4;
  }
  if (flags & 0x000004) cursor += 4; // first_sample_flags (we ignore)

  const hasSampleDuration = (flags & 0x000100) !== 0;
  const hasSampleSize = (flags & 0x000200) !== 0;
  const hasSampleFlags = (flags & 0x000400) !== 0;
  const hasSampleCtsOffset = (flags & 0x000800) !== 0;

  const defaultDuration =
    tfhd.defaultSampleDuration ?? defaults.defaultSampleDuration ?? 0;
  const defaultSize = tfhd.defaultSampleSize ?? defaults.defaultSampleSize ?? 0;

  const samples: TrunSampleSpec[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const duration = hasSampleDuration ? (cursor += 4, view.getUint32(cursor - 4, false)) : defaultDuration;
    const size = hasSampleSize ? (cursor += 4, view.getUint32(cursor - 4, false)) : defaultSize;
    if (hasSampleFlags) cursor += 4;
    let cts = 0;
    if (hasSampleCtsOffset) {
      // v0 is unsigned, v1+ is signed (B-frame CTS may be negative). We treat
      // both as signed — the inverse for v0 is fine because trun(v0) CTS
      // values are always in the high half (positive when interpreted signed).
      cts = view.getInt32(cursor, false);
      cursor += 4;
    }
    samples.push({ duration, size, cts });
  }
  return { dataOffset, samples };
}

function readType4(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset + 4]!,
    data[offset + 5]!,
    data[offset + 6]!,
    data[offset + 7]!,
  );
}

export class MovieFragmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovieFragmentError';
  }
}

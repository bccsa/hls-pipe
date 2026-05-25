/*
 * hls-pipe — AVCDecoderConfigurationRecord (`avcC`) parser
 *
 * Fresh module. The avcC box (ISO/IEC 14496-15 §5.2.4.1.1) sits inside an
 * `avc1` / `avc3` video sample entry and carries:
 *
 *   - the SPS + PPS NAL units we need to inject before each keyframe when
 *     converting length-prefixed fMP4 video samples to Annex-B MPEG-TS;
 *   - the length size (1 / 2 / 4 bytes) used to frame NAL units inside
 *     each fMP4 sample's mdat slice.
 *
 * Layout (configurationVersion = 1):
 *
 *   uint8     configurationVersion (= 1)
 *   uint8     AVCProfileIndication
 *   uint8     profile_compatibility
 *   uint8     AVCLevelIndication
 *   bit(6)    reserved (all 1s)
 *   bit(2)    lengthSizeMinusOne
 *   bit(3)    reserved (all 1s)
 *   bit(5)    numOfSequenceParameterSets
 *   N × {
 *     uint16  spsLength
 *     spsLength bytes  SPS NAL unit (including header byte)
 *   }
 *   uint8     numOfPictureParameterSets
 *   M × {
 *     uint16  ppsLength
 *     ppsLength bytes  PPS NAL unit
 *   }
 *   (more fields for high profiles — chroma_format etc. — skipped here)
 */

import { findChild, findChildren, findPath, type Box } from './box.js';

export interface AvcConfig {
  /** AVC profile (e.g., 0x42 = Baseline, 0x4d = Main, 0x64 = High). */
  profileIndication: number;
  /** Profile-compatibility byte. */
  profileCompatibility: number;
  /** AVC level (e.g., 0x1f = 3.1). */
  levelIndication: number;
  /** NAL unit length size in bytes: 1, 2, or 4 (usually 4). */
  lengthSize: number;
  /** Sequence Parameter Sets (raw NAL bytes, including header byte). */
  spsList: Uint8Array[];
  /** Picture Parameter Sets (raw NAL bytes). */
  ppsList: Uint8Array[];
}

export interface VideoTrackInfo {
  trackId: number;
  timescale: number;
  codecFourCc: 'avc1' | 'avc3' | 'hvc1' | 'hev1';
  width: number;
  height: number;
  /** Present when codecFourCc starts with "avc". */
  avc: AvcConfig | undefined;
}

/**
 * Parse the init segment's moov and return one descriptor per video track.
 * Returns an empty list if no video track is found.
 */
export function readVideoTracks(initSegment: Uint8Array): VideoTrackInfo[] {
  const moov = findPath(initSegment, 'moov');
  if (!moov) throw new VideoInitError('missing moov box');
  const out: VideoTrackInfo[] = [];
  for (const trak of findChildren(moov, 'trak')) {
    const info = readVideoTrack(trak);
    if (info) out.push(info);
  }
  return out;
}

function readVideoTrack(trak: Box): VideoTrackInfo | undefined {
  const tkhd = findChild(trak, 'tkhd');
  if (!tkhd) return undefined;
  const trackId = readTrackId(tkhd);

  const mdia = findChild(trak, 'mdia');
  if (!mdia) return undefined;
  const hdlr = findChild(mdia, 'hdlr');
  if (!hdlr) return undefined;
  if (readHandlerType(hdlr) !== 'vide') return undefined;

  const mdhd = findChild(mdia, 'mdhd');
  if (!mdhd) return undefined;
  const timescale = readMdhdTimescale(mdhd);

  const minf = findChild(mdia, 'minf');
  if (!minf) return undefined;
  const stbl = findChild(minf, 'stbl');
  if (!stbl) return undefined;
  const stsd = findChild(stbl, 'stsd');
  if (!stsd) return undefined;

  const sampleEntry = readFirstSampleEntry(stsd);
  if (!sampleEntry) return undefined;

  if (
    sampleEntry.type !== 'avc1' &&
    sampleEntry.type !== 'avc3' &&
    sampleEntry.type !== 'hvc1' &&
    sampleEntry.type !== 'hev1'
  ) {
    throw new VideoInitError(`unsupported video sample entry "${sampleEntry.type}"`);
  }

  // VisualSampleEntry layout: 78 bytes fixed before children (see ISO 14496-12).
  // We only pull width/height here; pixel ratio + frame-rate are out of scope.
  const view = new DataView(
    sampleEntry.data.buffer,
    sampleEntry.data.byteOffset,
    sampleEntry.data.byteLength,
  );
  const p = sampleEntry.payloadOffset;
  // Skip 6 reserved + 2 data_reference_index + 16 pre-defined+reserved = +24
  // Then width (2), height (2) at +24 and +26.
  const width = view.getUint16(p + 24, false);
  const height = view.getUint16(p + 26, false);

  // Children start at p + 78. Look for avcC (or hvcC for HEVC — out of scope).
  const childBoxes = readChildrenFrom(sampleEntry, p + 78);
  let avcConfig: AvcConfig | undefined;
  if (sampleEntry.type === 'avc1' || sampleEntry.type === 'avc3') {
    const avcC = childBoxes.find((b) => b.type === 'avcC');
    if (!avcC) throw new VideoInitError('avc1/avc3 sample entry missing avcC');
    avcConfig = parseAvcC(avcC);
  }

  return {
    trackId,
    timescale,
    codecFourCc: sampleEntry.type as VideoTrackInfo['codecFourCc'],
    width,
    height,
    avc: avcConfig,
  };
}

/**
 * Parse an avcC box's payload into the SPS/PPS bytes + length-size we need.
 */
export function parseAvcC(avcC: Box): AvcConfig {
  const d = avcC.data;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let cursor = avcC.payloadOffset;
  // First 4 bytes are NOT a full-box version+flags — avcC is a plain Box.
  const configurationVersion = d[cursor]!;
  if (configurationVersion !== 1) {
    throw new VideoInitError(`unsupported AVCDecoderConfigurationRecord version ${configurationVersion}`);
  }
  const profileIndication = d[cursor + 1]!;
  const profileCompatibility = d[cursor + 2]!;
  const levelIndication = d[cursor + 3]!;
  const lengthSize = (d[cursor + 4]! & 0x03) + 1;
  if (lengthSize !== 1 && lengthSize !== 2 && lengthSize !== 4) {
    throw new VideoInitError(`unsupported NAL lengthSize ${lengthSize}`);
  }
  const numSps = d[cursor + 5]! & 0x1f;
  cursor += 6;

  const spsList: Uint8Array[] = [];
  for (let i = 0; i < numSps; i++) {
    const spsLength = view.getUint16(cursor, false);
    cursor += 2;
    spsList.push(d.subarray(cursor, cursor + spsLength));
    cursor += spsLength;
  }

  const numPps = d[cursor]!;
  cursor += 1;
  const ppsList: Uint8Array[] = [];
  for (let i = 0; i < numPps; i++) {
    const ppsLength = view.getUint16(cursor, false);
    cursor += 2;
    ppsList.push(d.subarray(cursor, cursor + ppsLength));
    cursor += ppsLength;
  }

  return {
    profileIndication,
    profileCompatibility,
    levelIndication,
    lengthSize,
    spsList,
    ppsList,
  };
}

// -- helpers shared with init-segment.ts ----------------------------------
//   We deliberately don't import from init-segment.ts to avoid the audio
//   path depending on video types or vice versa. Two small re-implementations
//   is cheaper than the coupling.

function readFirstSampleEntry(stsd: Box): Box | undefined {
  const view = new DataView(stsd.data.buffer, stsd.data.byteOffset, stsd.data.byteLength);
  const entryCount = view.getUint32(stsd.payloadOffset + 4, false);
  if (entryCount === 0) return undefined;
  const entryOffset = stsd.payloadOffset + 8;
  const entrySize = view.getUint32(entryOffset, false);
  const entryType = String.fromCharCode(
    stsd.data[entryOffset + 4]!,
    stsd.data[entryOffset + 5]!,
    stsd.data[entryOffset + 6]!,
    stsd.data[entryOffset + 7]!,
  );
  return {
    type: entryType,
    offset: entryOffset,
    end: entryOffset + entrySize,
    payloadOffset: entryOffset + 8,
    data: stsd.data,
  };
}

function readChildrenFrom(parent: Box, fromOffset: number): Box[] {
  const out: Box[] = [];
  const view = new DataView(parent.data.buffer, parent.data.byteOffset, parent.data.byteLength);
  let cursor = fromOffset;
  while (cursor + 8 <= parent.end) {
    const size = view.getUint32(cursor, false);
    if (size === 0 || size > parent.end - cursor) break;
    const type = String.fromCharCode(
      parent.data[cursor + 4]!,
      parent.data[cursor + 5]!,
      parent.data[cursor + 6]!,
      parent.data[cursor + 7]!,
    );
    out.push({
      type,
      offset: cursor,
      end: cursor + size,
      payloadOffset: cursor + 8,
      data: parent.data,
    });
    cursor += size;
  }
  return out;
}

function readTrackId(tkhd: Box): number {
  const view = new DataView(tkhd.data.buffer, tkhd.data.byteOffset, tkhd.data.byteLength);
  const versionFlags = view.getUint32(tkhd.payloadOffset, false);
  const version = (versionFlags >>> 24) & 0xff;
  const trackIdOffset = version === 0 ? tkhd.payloadOffset + 12 : tkhd.payloadOffset + 20;
  return view.getUint32(trackIdOffset, false);
}

function readHandlerType(hdlr: Box): string {
  const o = hdlr.payloadOffset + 8;
  return String.fromCharCode(hdlr.data[o]!, hdlr.data[o + 1]!, hdlr.data[o + 2]!, hdlr.data[o + 3]!);
}

function readMdhdTimescale(mdhd: Box): number {
  const view = new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength);
  const versionFlags = view.getUint32(mdhd.payloadOffset, false);
  const version = (versionFlags >>> 24) & 0xff;
  if (version === 0) return view.getUint32(mdhd.payloadOffset + 12, false);
  return view.getUint32(mdhd.payloadOffset + 20, false);
}

export class VideoInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoInitError';
  }
}

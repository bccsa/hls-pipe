/*
 * hls-pipe — fMP4 init-segment interpretation
 *
 * Fresh module. An HLS fMP4 init segment is `ftyp + moov`. The moov box
 * carries the per-track metadata we need:
 *
 *   moov → trak → mdia → mdhd      .timescale (90000 typical for video, 44100/48000 for audio)
 *                       → hdlr     .handlerType ("vide" / "soun" / "subt")
 *                       → minf → stbl → stsd → <SampleEntry>
 *                                                  for audio: "mp4a" containing "esds"
 *                                                             which carries AudioSpecificConfig
 *                                                  for video: "avc1" / "hvc1" containing "avcC" / "hvcC"
 *   moov → mvex → trex             .defaultSampleDuration/Size/Flags (fragment defaults)
 *
 * Phase 7b.1 surfaces only audio. Video sample-entry parsing (avcC) lands
 * with phase 7b.3 (TS muxer).
 */

import { boxPayload, findChild, findPath, findChildren, type Box } from './box.js';

export interface AudioTrackInfo {
  trackId: number;
  timescale: number;
  /** Codec four-CC from sample entry, e.g., 'mp4a'. */
  codecFourCc: string;
  /** Number of channels from the audio sample entry (1-7). */
  channelCount: number;
  /** Sample rate from the audio sample entry (Hz). */
  sampleRate: number;
  /** AudioSpecificConfig as 5-byte AAC LC config: objectType, sfi, channel. */
  audioConfig: AudioSpecificConfig;
}

export interface AudioSpecificConfig {
  /** AAC object type. 2 = AAC LC (most common), 5 = HE-AAC SBR. */
  audioObjectType: number;
  /** Sampling frequency index (0-12 maps to standard rates; 13-14 reserved; 15 = explicit). */
  samplingFrequencyIndex: number;
  /** Sampling rate in Hz (resolved from the index, or explicit if sfi=15). */
  sampleRate: number;
  /** ADTS channel configuration (0-7). 1 = mono, 2 = stereo, 6 = 5.1, 7 = 7.1. */
  channelConfiguration: number;
}

/**
 * Sample-rate table from ISO 14496-3 Table 1.18 ("Sampling Frequency Index").
 * Index 15 means explicit rate (read from following 24 bits).
 */
const SAMPLE_RATE_TABLE = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  0, 0, 0,
] as const;

/**
 * Parse the moov box from an init segment and return one descriptor per audio
 * track. For HLS audio-rendition init segments there's typically exactly one.
 */
export function readAudioTracks(initSegment: Uint8Array): AudioTrackInfo[] {
  const moov = findPath(initSegment, 'moov');
  if (!moov) throw new InitSegmentError('missing moov box');
  const out: AudioTrackInfo[] = [];
  for (const trak of findChildren(moov, 'trak')) {
    const info = readAudioTrack(trak);
    if (info) out.push(info);
  }
  return out;
}

function readAudioTrack(trak: Box): AudioTrackInfo | undefined {
  // tkhd contains the track id (full-box version-aware layout).
  const tkhd = findChild(trak, 'tkhd');
  if (!tkhd) return undefined;
  const trackId = readTrackId(tkhd);

  const mdia = findChild(trak, 'mdia');
  if (!mdia) return undefined;
  const hdlr = findChild(mdia, 'hdlr');
  if (!hdlr) return undefined;
  if (readHandlerType(hdlr) !== 'soun') return undefined;

  const mdhd = findChild(mdia, 'mdhd');
  if (!mdhd) return undefined;
  const timescale = readMdhdTimescale(mdhd);

  // mdia → minf → stbl → stsd → <SampleEntry>
  const minf = findChild(mdia, 'minf');
  if (!minf) return undefined;
  const stbl = findChild(minf, 'stbl');
  if (!stbl) return undefined;
  const stsd = findChild(stbl, 'stsd');
  if (!stsd) return undefined;

  const sampleEntry = readFirstSampleEntry(stsd);
  if (!sampleEntry) return undefined;
  if (sampleEntry.type !== 'mp4a' && sampleEntry.type !== 'enca') {
    throw new InitSegmentError(
      `unsupported audio sample entry "${sampleEntry.type}" — phase 7b.1 supports mp4a (AAC)`,
    );
  }

  // mp4a layout per ISO 14496-12 §12.2 AudioSampleEntry:
  //   6 reserved bytes
  //   2 bytes data_reference_index
  //   8 reserved bytes
  //   2 bytes channel_count
  //   2 bytes sample_size
  //   2 bytes pre_defined (=0)
  //   2 bytes reserved
  //   4 bytes sample_rate as 16.16 fixed point (we read the high 16 = integer Hz)
  //   then child boxes (esds is what we want)
  const p = sampleEntry.payloadOffset;
  const view = new DataView(sampleEntry.data.buffer, sampleEntry.data.byteOffset, sampleEntry.data.byteLength);
  const channelCount = view.getUint16(p + 16, false);
  const sampleRateFixed = view.getUint32(p + 24, false);
  const sampleRate = sampleRateFixed >>> 16; // high 16 bits of 16.16 fixed point

  // Find esds inside the mp4a box (children start at p + 28).
  const esds = findChildInRange(sampleEntry, p + 28);
  if (!esds || esds.type !== 'esds') {
    throw new InitSegmentError('mp4a sample entry missing esds');
  }
  const audioConfig = readAudioSpecificConfigFromEsds(esds);

  return {
    trackId,
    timescale,
    codecFourCc: sampleEntry.type,
    channelCount,
    sampleRate,
    audioConfig,
  };
}

/** stsd is a full box: 4 bytes version+flags, 4 bytes entry_count, then entries. */
function readFirstSampleEntry(stsd: Box): Box | undefined {
  const view = new DataView(stsd.data.buffer, stsd.data.byteOffset, stsd.data.byteLength);
  const entryCount = view.getUint32(stsd.payloadOffset + 4, false);
  if (entryCount === 0) return undefined;
  // First entry starts at payloadOffset + 8.
  // We synthesize a Box by treating the entry's first 4 bytes as size and next 4 as type.
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

/** Search children of `parent` starting from a specific offset within parent.data. */
function findChildInRange(parent: Box, fromOffset: number): Box | undefined {
  // mp4a has fixed-layout header then children — iterate manually from fromOffset.
  let cursor = fromOffset;
  const view = new DataView(parent.data.buffer, parent.data.byteOffset, parent.data.byteLength);
  while (cursor + 8 <= parent.end) {
    const size = view.getUint32(cursor, false);
    if (size === 0 || size > parent.end - cursor) return undefined;
    const type = String.fromCharCode(
      parent.data[cursor + 4]!,
      parent.data[cursor + 5]!,
      parent.data[cursor + 6]!,
      parent.data[cursor + 7]!,
    );
    // Return the first child we find — for our use case the esds is typically first.
    return {
      type,
      offset: cursor,
      end: cursor + size,
      payloadOffset: cursor + 8,
      data: parent.data,
    };
  }
  return undefined;
}

function readTrackId(tkhd: Box): number {
  // Full-box: 1 byte version, 3 bytes flags, then version-dependent fields.
  // For v0 layout: 4 bytes creation_time, 4 bytes modification_time, 4 bytes track_ID.
  // For v1 layout: 8 bytes each + 4 bytes track_ID at offset 16.
  const view = new DataView(tkhd.data.buffer, tkhd.data.byteOffset, tkhd.data.byteLength);
  const versionFlags = view.getUint32(tkhd.payloadOffset, false);
  const version = (versionFlags >>> 24) & 0xff;
  const trackIdOffset = version === 0 ? tkhd.payloadOffset + 4 + 8 : tkhd.payloadOffset + 4 + 16;
  return view.getUint32(trackIdOffset, false);
}

function readHandlerType(hdlr: Box): string {
  // Full-box: 4 bytes version+flags, 4 bytes pre_defined, 4 bytes handler_type.
  const o = hdlr.payloadOffset + 4 + 4;
  return String.fromCharCode(
    hdlr.data[o]!,
    hdlr.data[o + 1]!,
    hdlr.data[o + 2]!,
    hdlr.data[o + 3]!,
  );
}

function readMdhdTimescale(mdhd: Box): number {
  const view = new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength);
  const versionFlags = view.getUint32(mdhd.payloadOffset, false);
  const version = (versionFlags >>> 24) & 0xff;
  // v0: 4 + 4 + 4 (timescale) + 4 (duration)
  // v1: 4 + 8 + 8 (timescale) + 8 (duration) -- but timescale is still 4 bytes
  if (version === 0) {
    return view.getUint32(mdhd.payloadOffset + 4 + 4 + 4, false);
  } else {
    return view.getUint32(mdhd.payloadOffset + 4 + 8 + 8, false);
  }
}

/**
 * Parse the esds box (ES_Descriptor + DecoderConfigDescriptor +
 * DecoderSpecificInfo) and return the AudioSpecificConfig fields.
 *
 * MPEG-4 descriptor encoding (ISO 14496-1 §8.3.3): each descriptor starts
 * with a 1-byte tag, then a 1-4 byte size where bit 7 of each byte indicates
 * continuation.
 */
function readAudioSpecificConfigFromEsds(esds: Box): AudioSpecificConfig {
  const data = boxPayload(esds);
  // First 4 bytes are version+flags. Then ES_Descriptor begins.
  let cursor = 4;
  const TAG_ES = 0x03;
  const TAG_DECODER_CONFIG = 0x04;
  const TAG_DECODER_SPECIFIC = 0x05;

  function readDescrSize(): number {
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const byte = data[cursor++]!;
      size = (size << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return size;
  }

  // Skip ES_Descriptor header
  if (data[cursor] !== TAG_ES) throw new InitSegmentError('esds: expected ES_Descriptor tag');
  cursor++;
  readDescrSize();
  // ES_ID (2) + flags (1) — and if any of streamDependenceFlag/URL_Flag/OCRflag, more bytes.
  const esId = (data[cursor]! << 8) | data[cursor + 1]!;
  void esId; // unused but consumed
  cursor += 2;
  const esFlags = data[cursor++]!;
  if (esFlags & 0x80) cursor += 2; // dependsOn_ES_ID
  if (esFlags & 0x40) {
    const urlLen = data[cursor++]!;
    cursor += urlLen;
  }
  if (esFlags & 0x20) cursor += 2; // OCR_ES_ID

  // DecoderConfigDescriptor
  if (data[cursor] !== TAG_DECODER_CONFIG) {
    throw new InitSegmentError('esds: expected DecoderConfigDescriptor tag');
  }
  cursor++;
  readDescrSize();
  const objectTypeIndication = data[cursor++]!;
  if (objectTypeIndication !== 0x40 /* MPEG-4 AAC */ && objectTypeIndication !== 0x67) {
    throw new InitSegmentError(
      `unsupported objectTypeIndication 0x${objectTypeIndication.toString(16)} (only AAC supported)`,
    );
  }
  // streamType(6) + upStream(1) + reserved(1) = 1 byte; bufferSizeDB = 3 bytes; maxBitrate = 4; avgBitrate = 4
  cursor += 1 + 3 + 4 + 4;

  // DecoderSpecificInfo
  if (data[cursor] !== TAG_DECODER_SPECIFIC) {
    throw new InitSegmentError('esds: expected DecoderSpecificInfo tag');
  }
  cursor++;
  const ascSize = readDescrSize();
  const asc = data.subarray(cursor, cursor + ascSize);
  return parseAudioSpecificConfig(asc);
}

/**
 * Parse AudioSpecificConfig per ISO 14496-3 §1.6.2.1.
 *   bits 0-4: AudioObjectType (5 bits)
 *     If = 31: bits 5-10 = AudioObjectType - 32 (extended)
 *   bits next 4: samplingFrequencyIndex
 *     If = 15: next 24 bits = explicit sample rate
 *   bits next 4: channelConfiguration
 *
 * Bit-stream read: we use a tiny stateful reader.
 */
export function parseAudioSpecificConfig(asc: Uint8Array): AudioSpecificConfig {
  if (asc.byteLength < 2) {
    throw new InitSegmentError(`AudioSpecificConfig too short: ${asc.byteLength}`);
  }
  let bitOffset = 0;
  const read = (numBits: number): number => {
    let value = 0;
    for (let i = 0; i < numBits; i++) {
      const byteIdx = (bitOffset + i) >> 3;
      const bitIdx = 7 - ((bitOffset + i) & 7);
      const bit = (asc[byteIdx]! >> bitIdx) & 1;
      value = (value << 1) | bit;
    }
    bitOffset += numBits;
    return value;
  };

  let aot = read(5);
  if (aot === 31) aot = 32 + read(6);
  let sfi = read(4);
  let sampleRate: number;
  if (sfi === 15) {
    sampleRate = read(24);
  } else {
    sampleRate = SAMPLE_RATE_TABLE[sfi] ?? 0;
  }
  const channelConfiguration = read(4);
  return {
    audioObjectType: aot,
    samplingFrequencyIndex: sfi,
    sampleRate,
    channelConfiguration,
  };
}

export class InitSegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitSegmentError';
  }
}

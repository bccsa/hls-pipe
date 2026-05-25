/*
 * hls-pipe — raw AAC/ADTS audio rendition extractor
 *
 * Inspired by hls.js src/demux/audio/aacdemuxer.ts + src/demux/id3.ts.
 * Parses HLS audio renditions delivered as raw ADTS files (one per segment),
 * typically prefixed with an ID3v2 header carrying Apple's transport-stream-
 * timestamp PRIV frame for PTS anchoring.
 *
 * Two pieces:
 *   1. ID3v2 header parse → segment-start PTS (90 kHz) from the
 *      `com.apple.streaming.transportStreamTimestamp` PRIV frame
 *   2. ADTS frame split → per-frame slices with computed PTS derived from
 *      sample-rate and AAC's fixed 1024 samples per frame
 *
 * Output shape matches `Fmp4AudioFrame` (from src/demux/fmp4/audio.ts), so
 * the inline-mux path can swap between fMP4 and raw-ADTS audio sources
 * without further branching downstream.
 *
 * References:
 *   - Apple HLS Metadata spec:
 *     https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/HTTP_Live_Streaming_Metadata_Spec/
 *   - ISO/IEC 13818-7 §6.2 (ADTS) — same as src/demux/fmp4/aac-to-adts.ts
 *   - ID3v2.4 informal standard (id3.org)
 */

const PTS_TIMESCALE = 90000;
const SAMPLES_PER_AAC_FRAME = 1024;

const SAMPLE_RATE_TABLE = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  0, 0, 0,
] as const;

const ID3_OWNER_TS_TIMESTAMP = 'com.apple.streaming.transportStreamTimestamp';

/** One ADTS frame from a raw audio rendition, with PTS in 90 kHz. */
export interface RawAacFrame {
  /** Complete ADTS frame bytes (7-byte header + raw_data_block). */
  data: Uint8Array;
  /** Presentation timestamp in 90 kHz units. */
  pts: number;
  /** Per-frame duration in 90 kHz units (1024 samples × 90000 / sampleRate). */
  duration: number;
}

export class RawAacExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawAacExtractError';
  }
}

/**
 * Parse one raw-AAC segment's bytes into individual ADTS frames with PTS.
 * The segment may or may not start with an ID3v2 tag — if present, the
 * tag's Apple PRIV transport-timestamp frame anchors the segment's start
 * PTS; otherwise PTS starts at 0.
 */
export function extractAacFrames(segment: Uint8Array): RawAacFrame[] {
  let offset = 0;
  let startPts = 0;

  const id3 = parseId3v2Header(segment);
  if (id3) {
    offset = id3.totalSize;
    if (id3.transportTimestampPts !== undefined) {
      startPts = id3.transportTimestampPts;
    }
  }

  return framesFromAdts(segment.subarray(offset), startPts);
}

/**
 * Split a buffer of concatenated ADTS frames (no leading ID3, no container
 * framing) into individual frames with per-frame PTS. Used by:
 *   - `extractAacFrames` after stripping any ID3v2 prefix
 *   - the MPEG-TS audio rendition path, which calls this on each audio PES
 *     payload with `startPts` taken from the PES header
 *
 * Assumes a constant sample rate across the buffer (true for HLS audio
 * renditions in practice — the rate comes from the rendition's CODECS attr).
 */
export function framesFromAdts(audioBytes: Uint8Array, startPts: number): RawAacFrame[] {
  if (audioBytes.byteLength < 7) return [];

  if (audioBytes[0] !== 0xff || (audioBytes[1]! & 0xf0) !== 0xf0) {
    throw new RawAacExtractError(
      `expected ADTS sync 0xFFFx; got 0x${audioBytes[0]?.toString(16) ?? '??'} 0x${audioBytes[1]?.toString(16) ?? '??'}`,
    );
  }
  const firstSfi = (audioBytes[2]! >> 2) & 0x0f;
  const sampleRate = SAMPLE_RATE_TABLE[firstSfi] ?? 0;
  if (sampleRate === 0) {
    throw new RawAacExtractError(`unsupported ADTS sampling_frequency_index ${firstSfi}`);
  }
  const ticksPerFrame = Math.round((SAMPLES_PER_AAC_FRAME * PTS_TIMESCALE) / sampleRate);

  const frames: RawAacFrame[] = [];
  let cursor = 0;
  let frameIndex = 0;
  while (cursor + 7 <= audioBytes.byteLength) {
    if (audioBytes[cursor] !== 0xff || (audioBytes[cursor + 1]! & 0xf0) !== 0xf0) {
      // End of ADTS data or corruption — stop quietly (callers can tolerate
      // truncated tails since per-segment integrity is independent).
      break;
    }
    // aac_frame_length is 13 bits at byte 3 low 2 + byte 4 all 8 + byte 5 high 3.
    const frameLength =
      ((audioBytes[cursor + 3]! & 0x03) << 11) |
      (audioBytes[cursor + 4]! << 3) |
      ((audioBytes[cursor + 5]! >> 5) & 0x07);
    if (frameLength < 7 || cursor + frameLength > audioBytes.byteLength) break;
    frames.push({
      data: audioBytes.subarray(cursor, cursor + frameLength),
      pts: startPts + frameIndex * ticksPerFrame,
      duration: ticksPerFrame,
    });
    cursor += frameLength;
    frameIndex++;
  }
  return frames;
}

/**
 * ID3v2 header at the very start of a buffer. Returns:
 *   - `totalSize`: number of bytes to skip (10-byte header + payload)
 *   - `transportTimestampPts`: 90 kHz PTS from the Apple PRIV frame, or undefined
 *
 * Returns undefined if no ID3v2 tag is present.
 *
 * ID3v2.4 layout (id3.org informal standard):
 *   bytes 0-2   "ID3" (0x49 0x44 0x33)
 *   bytes 3-4   version (major, revision)
 *   byte 5      flags
 *   bytes 6-9   synchsafe size of frames+padding (28 bits across 4 bytes, top
 *               bit of each byte is 0)
 */
export function parseId3v2Header(
  bytes: Uint8Array,
): { totalSize: number; transportTimestampPts: number | undefined } | undefined {
  if (bytes.byteLength < 10) return undefined;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return undefined;
  const synchsafeSize =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const totalSize = 10 + synchsafeSize;
  if (totalSize > bytes.byteLength) {
    // Truncated tag; treat as no ID3 (defensive).
    return undefined;
  }

  // Scan frames for PRIV with the Apple timestamp owner.
  const transportTimestampPts = findApplePrivTimestamp(bytes, 10, totalSize);
  return transportTimestampPts !== undefined
    ? { totalSize, transportTimestampPts }
    : { totalSize, transportTimestampPts: undefined };
}

function findApplePrivTimestamp(
  bytes: Uint8Array,
  startOffset: number,
  endOffset: number,
): number | undefined {
  let cursor = startOffset;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (cursor + 10 <= endOffset) {
    // Frame ID = 4 ASCII chars, size = 4 bytes (synchsafe in v2.4 only; v2.3 is plain)
    // We treat both: ID3v2.4 uses synchsafe; v2.3 doesn't. We probe both.
    const id =
      String.fromCharCode(bytes[cursor]!, bytes[cursor + 1]!, bytes[cursor + 2]!, bytes[cursor + 3]!);
    if (id === '\0\0\0\0' || id === '    ') break; // padding starts
    const sizeSynchsafe =
      ((bytes[cursor + 4]! & 0x7f) << 21) |
      ((bytes[cursor + 5]! & 0x7f) << 14) |
      ((bytes[cursor + 6]! & 0x7f) << 7) |
      (bytes[cursor + 7]! & 0x7f);
    const sizePlain = view.getUint32(cursor + 4, false);
    // Heuristic: if synchsafe and plain agree, either is fine. Otherwise prefer
    // synchsafe (id3 v2.4 / Apple convention).
    const frameSize = sizeSynchsafe;
    cursor += 10; // 4 id + 4 size + 2 flags

    if (id === 'PRIV' && frameSize > 0) {
      const frameEnd = cursor + frameSize;
      // Body starts with NUL-terminated owner identifier.
      let ownerEnd = cursor;
      while (ownerEnd < frameEnd && bytes[ownerEnd] !== 0) ownerEnd++;
      const owner = new TextDecoder('latin1').decode(bytes.subarray(cursor, ownerEnd));
      if (owner === ID3_OWNER_TS_TIMESTAMP) {
        const dataStart = ownerEnd + 1;
        if (dataStart + 8 <= frameEnd) {
          // 64-bit big-endian PTS in 90 kHz (top 31 bits should be 0; we use
          // float arithmetic to avoid JS 32-bit bitwise truncation).
          let pts = 0;
          for (let i = 0; i < 8; i++) pts = pts * 256 + bytes[dataStart + i]!;
          return pts;
        }
      }
    }
    // Defensive: if plain-size points further, use it instead. Some streams
    // use ID3v2.3 with plain (non-synchsafe) sizes.
    if (cursor + Math.max(0, sizePlain) <= endOffset && cursor + sizePlain !== cursor + frameSize) {
      // Try plain size as fallback only if synchsafe yielded an invalid offset.
      if (cursor + frameSize > endOffset) {
        cursor += sizePlain;
        continue;
      }
    }
    cursor += frameSize;
  }
  return undefined;
}

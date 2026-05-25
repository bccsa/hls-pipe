/*
 * hls-pipe — PAT / PMT parsers
 *
 * Direct port of `parsePAT` and `parsePMT` from hls.js
 *   src/demux/tsdemuxer.ts (lines ~919-1106 in v1.6.x)
 *
 * Modifications from upstream:
 *   - extracted to a standalone module
 *   - replaced event-bus error emission with a thrown PmtParseError
 *   - removed Hls-specific config knobs (handleMpegTsVideoIntegrityErrors,
 *     enableEmsgKLVMetadata) — phase 4a does not need them
 *   - removed the `typeSupported` codec capability gate — we always parse
 *     every stream type, because in Node we're not limited to what the
 *     browser MSE supports. Downstream choice of which streams to emit is
 *     a separate concern.
 *
 * Algorithm is byte-for-byte equivalent to upstream for the supported
 * stream-type IDs.
 *
 * ---------------------------------------------------------------------------
 * Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * ---------------------------------------------------------------------------
 */

/** ISO/IEC 13818-1 Table 2-29 — stream_type values we recognize. */
export const StreamType = {
  MPEG1_VIDEO: 0x01,
  MPEG2_VIDEO: 0x02,
  MPEG1_AUDIO: 0x03,
  MPEG2_AUDIO: 0x04,
  PRIVATE_SECTIONS: 0x05,
  PES_PRIVATE: 0x06, // commonly AC-3 via DVB descriptor
  AAC_ADTS: 0x0f, // ISO/IEC 13818-7 (MPEG-2 AAC)
  H264: 0x1b,
  HEVC: 0x24,
  METADATA: 0x15,
  AC3: 0x81, // ATSC A/52
  EC3: 0x87, // E-AC-3 / Enhanced AC-3
  SAMPLE_AES_AAC: 0xcf,
  SAMPLE_AES_AC3: 0xc1,
  SAMPLE_AES_EC3: 0xc2,
  SAMPLE_AES_H264: 0xdb,
} as const;

/** Codec families we surface upward. */
export type VideoCodec = 'avc' | 'hevc';
export type AudioCodec = 'aac' | 'mp3' | 'ac3';

export interface PmtStreams {
  /** PID of the primary video stream, or -1 if none. */
  videoPid: number;
  videoCodec: VideoCodec | undefined;
  /** PID of the primary audio stream, or -1 if none. */
  audioPid: number;
  audioCodec: AudioCodec | undefined;
  /** PID of the ID3 / metadata stream, or -1 if none. */
  id3Pid: number;
}

export class PmtParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmtParseError';
  }
}

/**
 * Parse a PAT (Program Association Table) starting at `offset` and return
 * the PMT PID of the first program in the table.
 *
 * Layout (after the 1-byte pointer_field the caller skipped):
 *   table_id (8)
 *   section_syntax_indicator(1) + 0(1) + reserved(2) + section_length(12)
 *   transport_stream_id (16)
 *   reserved(2) + version_number(5) + current_next(1)
 *   section_number (8)
 *   last_section_number (8)
 *   then N × { program_number(16), reserved(3), program_map_PID(13) }
 *
 * We hop straight to the first program_map_PID at byte +10/+11. (Matches
 * hls.js — they assume one program per TS, like ~all HLS streams in the wild.)
 */
export function parsePAT(data: Uint8Array, offset: number): number {
  return ((data[offset + 10]! & 0x1f) << 8) | data[offset + 11]!;
}

/**
 * Parse a PMT (Program Map Table) starting at `offset`. The caller must
 * have skipped the 1-byte pointer_field if the TS packet was payload_unit_start.
 */
export function parsePMT(data: Uint8Array, offset: number): PmtStreams {
  const result: PmtStreams = {
    videoPid: -1,
    videoCodec: undefined,
    audioPid: -1,
    audioCodec: undefined,
    id3Pid: -1,
  };

  // section_length is 12 bits across data[offset+1] low-nibble + data[offset+2]
  const sectionLength = ((data[offset + 1]! & 0x0f) << 8) | data[offset + 2]!;
  // 3-byte header + section_length - 4 CRC bytes = end of stream descriptor list
  const tableEnd = offset + 3 + sectionLength - 4;
  // program_info_length at data[offset+10] low-nibble + data[offset+11]
  const programInfoLength = ((data[offset + 10]! & 0x0f) << 8) | data[offset + 11]!;
  // Advance past PMT header + program-info descriptors to first ES entry.
  let cursor = offset + 12 + programInfoLength;

  while (cursor < tableEnd) {
    const streamType = data[cursor]!;
    const pid = ((data[cursor + 1]! & 0x1f) << 8) + data[cursor + 2]!;
    const esInfoLength = ((data[cursor + 3]! & 0x0f) << 8) | data[cursor + 4]!;

    switch (streamType) {
      case StreamType.AAC_ADTS:
      case StreamType.SAMPLE_AES_AAC:
        if (result.audioPid === -1) {
          result.audioPid = pid;
          result.audioCodec = 'aac';
        }
        break;

      case StreamType.METADATA:
        if (result.id3Pid === -1) result.id3Pid = pid;
        break;

      case StreamType.H264:
      case StreamType.SAMPLE_AES_H264:
        if (result.videoPid === -1) {
          result.videoPid = pid;
          result.videoCodec = 'avc';
        }
        break;

      case StreamType.HEVC:
        if (result.videoPid === -1) {
          result.videoPid = pid;
          result.videoCodec = 'hevc';
        }
        break;

      case StreamType.MPEG1_AUDIO:
      case StreamType.MPEG2_AUDIO:
        if (result.audioPid === -1) {
          result.audioPid = pid;
          result.audioCodec = 'mp3';
        }
        break;

      case StreamType.AC3:
      case StreamType.SAMPLE_AES_AC3:
        if (result.audioPid === -1) {
          result.audioPid = pid;
          result.audioCodec = 'ac3';
        }
        break;

      case StreamType.PES_PRIVATE:
        // stream_type 0x06 = PES with private data. May carry AC-3 announced
        // via DVB descriptor 0x6a. Scan ES descriptors for that case.
        if (esInfoLength > 0) {
          let parsePos = cursor + 5;
          let remaining = esInfoLength;
          while (remaining > 2) {
            const descriptorId = data[parsePos]!;
            if (descriptorId === 0x6a && result.audioPid === -1) {
              result.audioPid = pid;
              result.audioCodec = 'ac3';
            }
            const descriptorLen = data[parsePos + 1]! + 2;
            parsePos += descriptorLen;
            remaining -= descriptorLen;
          }
        }
        break;

      case StreamType.EC3:
      case StreamType.SAMPLE_AES_EC3:
        throw new PmtParseError(`unsupported EC-3 stream_type 0x${streamType.toString(16)}`);

      default:
        // Unknown stream type — skip; caller can introspect later phases.
        break;
    }

    // Advance to next ES entry: 5-byte ES header + descriptors.
    cursor += esInfoLength + 5;
  }

  return result;
}

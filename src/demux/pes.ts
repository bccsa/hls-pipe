/*
 * hls-pipe — PES packet depacketization
 *
 * Direct port of `parsePES` and the per-PID accumulation buffer from hls.js
 *   src/demux/tsdemuxer.ts (the `ElementaryStreamData` accumulator in the
 *   main demux loop + the standalone `parsePES` helper at ~line 1135).
 *
 * Modifications from upstream:
 *   - extracted into a dedicated module
 *   - replaced the upstream's "logger.warn on PTS-DTS skew > 60s" with a
 *     boolean flag in the result; callers decide whether to log
 *   - `PesAccumulator` is a small class that mirrors the inline
 *     ElementaryStreamData object literal pattern from upstream
 *
 * Algorithm is byte-for-byte equivalent to upstream for the PES header layout
 * and PTS/DTS extraction (with the 33-bit value reconstructed using floating
 * point math because JS bitwise ops truncate to 32 bits).
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

/** One reassembled PES packet payload + timing. */
export interface PesPacket {
  /** Reassembled payload bytes (PES header stripped). */
  data: Uint8Array;
  /** Presentation Time Stamp in 90 kHz units, or undefined if PTS_DTS_flags = 0b00. */
  pts: number | undefined;
  /** Decode Time Stamp in 90 kHz units. Falls back to PTS if only PTS was signaled. */
  dts: number | undefined;
  /**
   * `PES_packet_length` field from the PES header minus header overhead, or
   * 0 when the source declared length 0 (allowed for video PES in TS).
   */
  declaredPayloadLength: number;
  /**
   * True when the PES header signaled a PTS-DTS skew > 60s, which is almost
   * always an encoding bug. We collapse DTS to PTS in this case (matching
   * hls.js behavior) and let the caller log if it wants.
   */
  ptsDtsSkewClamped: boolean;
}

/**
 * Accumulator for one stream's PES-payload fragments. As TS packets arrive
 * for a PID, append their payload here. When the next packet with
 * payload_unit_start_indicator arrives, call `finish()` to assemble a
 * PesPacket and reset the accumulator.
 */
export class PesAccumulator {
  /** Fragments accumulated since the last finish(). */
  private fragments: Uint8Array[] = [];
  private totalSize = 0;

  push(fragment: Uint8Array): void {
    if (fragment.byteLength === 0) return;
    this.fragments.push(fragment);
    this.totalSize += fragment.byteLength;
  }

  isEmpty(): boolean {
    return this.totalSize === 0;
  }

  /**
   * Finalize the buffered PES, return a parsed packet, and reset internal
   * state. Returns undefined if buffer is empty or the PES header is malformed
   * / truncated (matches hls.js: it logs and drops in that case).
   */
  finish(): PesPacket | undefined {
    if (this.totalSize === 0) return undefined;
    const merged = mergeFragments(this.fragments, this.totalSize);
    this.fragments = [];
    this.totalSize = 0;
    return parsePes(merged);
  }
}

/**
 * Parse a fully-reassembled PES byte stream (header + payload) into a
 * PesPacket. Returns undefined on a malformed prefix or truncated header.
 *
 * Header layout (ISO/IEC 13818-1 §2.4.3.6):
 *   bytes 0..2  packet_start_code_prefix (0x00 0x00 0x01)
 *   byte  3     stream_id
 *   bytes 4..5  PES_packet_length (0 allowed for video PES in TS)
 *   byte  6     flags: '10' marker + scrambling/priority/alignment/copyright/copy
 *   byte  7     flags: PTS_DTS_flags(2) ESCR(1) ES_rate(1) DSM(1) addCopy(1) CRC(1) ext(1)
 *   byte  8     PES_header_data_length
 *   bytes 9..14 PTS (if signaled), 5 bytes with marker bits
 *   bytes 14..18 DTS (if signaled), 5 bytes with marker bits
 */
export function parsePes(buffer: Uint8Array): PesPacket | undefined {
  if (buffer.byteLength < 19) return undefined;
  // Verify start code prefix
  if (buffer[0] !== 0x00 || buffer[1] !== 0x00 || buffer[2] !== 0x01) return undefined;

  const pesLen = (buffer[4]! << 8) | buffer[5]!;
  const pesFlags = buffer[7]!;
  const pesHdrLen = buffer[8]!;
  const payloadStart = 9 + pesHdrLen;
  if (buffer.byteLength <= payloadStart) return undefined;

  let pts: number | undefined;
  let dts: number | undefined;
  let ptsDtsSkewClamped = false;

  if (pesFlags & 0xc0) {
    // PTS is 33 bits split across 5 bytes with marker bits at positions 0, 12, 28.
    // JS bitwise ops truncate to 32 bits, so we multiply for the high bits.
    pts =
      (buffer[9]! & 0x0e) * 536870912 + // bits 32..30 → ×2^29
      (buffer[10]! & 0xff) * 4194304 + //  bits 29..22 → ×2^22
      (buffer[11]! & 0xfe) * 16384 + //   bits 21..15 → ×2^14
      (buffer[12]! & 0xff) * 128 + //     bits 14..7  → ×2^7
      (buffer[13]! & 0xfe) / 2; //        bits 6..0   → /2

    if (pesFlags & 0x40) {
      dts =
        (buffer[14]! & 0x0e) * 536870912 +
        (buffer[15]! & 0xff) * 4194304 +
        (buffer[16]! & 0xfe) * 16384 +
        (buffer[17]! & 0xff) * 128 +
        (buffer[18]! & 0xfe) / 2;
      // Encoder bug guard — hls.js does the same: if skew > 60s, force DTS = PTS.
      if (pts - dts > 60 * 90000) {
        ptsDtsSkewClamped = true;
        pts = dts;
      }
    } else {
      // Only PTS signaled; DTS is implied equal.
      dts = pts;
    }
  }

  const payload = buffer.subarray(payloadStart);
  const declaredPayloadLength = pesLen ? Math.max(0, pesLen - pesHdrLen - 3) : 0;

  return { data: payload, pts, dts, declaredPayloadLength, ptsDtsSkewClamped };
}

function mergeFragments(fragments: Uint8Array[], totalSize: number): Uint8Array {
  if (fragments.length === 1) return fragments[0]!;
  const merged = new Uint8Array(totalSize);
  let offset = 0;
  for (const f of fragments) {
    merged.set(f, offset);
    offset += f.byteLength;
  }
  return merged;
}

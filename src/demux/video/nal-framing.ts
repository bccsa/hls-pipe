/*
 * hls-pipe — H.264/HEVC Annex-B NAL unit framing
 *
 * Inspired by hls.js src/demux/video/base-video-parser.ts (the `parseNALu`
 * FSM in `BaseVideoParser`). The upstream implementation is stateful across
 * PES packet boundaries because it processes streaming data; our demuxer
 * operates segment-at-a-time so each PES payload is a complete byte buffer.
 * This lets us use a simpler stateless scanner.
 *
 * Annex-B framing (ITU-T H.264 §B.1):
 *   - NAL unit start code is one of:
 *       0x00 0x00 0x01           (3-byte)
 *       0x00 0x00 0x00 0x01      (4-byte)
 *   - The byte immediately after the start code is the NAL header.
 *   - NAL units are separated by start codes; the bytes between two
 *     consecutive start codes (excluding the trailing emulation-prevention
 *     run if any) constitute one NAL unit's RBSP.
 *
 * Phase-7a.1 scope: extract NAL unit ranges + header bytes. We do NOT strip
 * emulation-prevention bytes (0x03 after 0x00 0x00) — that lands with the
 * SPS/PPS parser in 7a.2, where it actually matters. Keyframe detection only
 * needs the header byte, which never contains emulation prevention.
 */

/** Codec-family-agnostic NAL unit shape. NAL header byte layouts differ for AVC vs HEVC; */
/** callers (e.g., src/demux/video/avc.ts) interpret the header. */
export interface NalUnit {
  /**
   * Raw NAL bytes including the 1-byte header (AVC) or 2-byte header (HEVC),
   * excluding the Annex-B start code. Emulation-prevention bytes are NOT
   * stripped — that's a phase-7a.2 concern once SPS/PPS parsing arrives.
   */
  data: Uint8Array;
}

/**
 * Split an Annex-B encoded H.264 / HEVC byte stream into NAL units.
 *
 * Handles both 3-byte and 4-byte start codes. Tolerates leading garbage
 * before the first start code (returns nothing for that prefix). Tolerates
 * trailing bytes after the last start code by treating them as the final
 * NAL unit (typical when an MPEG-TS PES payload ends mid-frame).
 *
 * Returns an empty array if no start code is found.
 */
export function parseAnnexB(bytes: Uint8Array): NalUnit[] {
  const out: NalUnit[] = [];
  const starts = findStartCodes(bytes);
  if (starts.length === 0) return out;
  for (let i = 0; i < starts.length; i++) {
    const here = starts[i]!;
    const next = i + 1 < starts.length ? starts[i + 1]!.offset : bytes.byteLength;
    const payloadStart = here.offset + here.codeLength;
    if (payloadStart >= next) continue; // empty NAL unit (rare but possible)
    out.push({ data: bytes.subarray(payloadStart, next) });
  }
  return out;
}

interface StartCode {
  /** Byte offset of the first 0x00 in the start code. */
  offset: number;
  /** 3 or 4 — number of bytes the start code occupies (00 00 01 vs 00 00 00 01). */
  codeLength: number;
}

/**
 * Find every Annex-B start code in `bytes`. We scan once linearly looking for
 * 0x00 0x00 0x01 — the 3-byte prefix — and detect the 4-byte variant by
 * checking whether the byte immediately before the 0x01 (i.e., at offset-1
 * from the second zero) is also zero.
 *
 * Time complexity: O(n) with no backtracking.
 */
function findStartCodes(bytes: Uint8Array): StartCode[] {
  const out: StartCode[] = [];
  const n = bytes.byteLength;
  if (n < 3) return out;
  let i = 0;
  while (i < n - 2) {
    // Match "00 00 01" at i, i+1, i+2.
    if (bytes[i] !== 0) {
      i++;
      continue;
    }
    if (bytes[i + 1] !== 0) {
      i += 2;
      continue;
    }
    // bytes[i] == 0, bytes[i+1] == 0. Check bytes[i+2].
    if (bytes[i + 2] === 0x01) {
      // 3-byte start code. Check for 4-byte variant by peeking one byte back.
      if (i > 0 && bytes[i - 1] === 0) {
        out.push({ offset: i - 1, codeLength: 4 });
      } else {
        out.push({ offset: i, codeLength: 3 });
      }
      i += 3;
    } else if (bytes[i + 2] === 0) {
      // "00 00 00" — could be 4-byte start code if bytes[i+3] == 0x01.
      // Don't advance past i+1 because the next pair may also match.
      i++;
    } else {
      // "00 00 XX" where XX != 0 and != 1 — not a start code.
      i += 3;
    }
  }
  return out;
}

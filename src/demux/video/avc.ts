/*
 * hls-pipe — H.264 (AVC) NAL header classification + keyframe detection
 *
 * Inspired by hls.js src/demux/video/avc-video-parser.ts (the NAL-type
 * dispatch in `parsePES`). We only port what phase-7a.1 needs: NAL type
 * extraction and keyframe identification. SPS/PPS parsing (which needs
 * an ExpGolomb bitstream reader) is deferred to phase 7a.2.
 *
 * AVC NAL header layout (ITU-T H.264 §7.3.1):
 *   bit 0      forbidden_zero_bit (always 0)
 *   bits 1-2   nal_ref_idc
 *   bits 3-7   nal_unit_type  (the part we care about)
 *
 *   nal_unit_type values we recognize:
 *     1   non-IDR slice (predicted frame)
 *     5   IDR slice (random-access point — what we call a keyframe)
 *     6   SEI
 *     7   SPS (Sequence Parameter Set)
 *     8   PPS (Picture Parameter Set)
 *     9   AUD (Access Unit Delimiter)
 *     10  end of sequence
 *     11  end of stream
 *     12  filler data
 */

import type { NalUnit } from './nal-framing.js';

export const AvcNalType = {
  SLICE: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
  END_OF_SEQUENCE: 10,
  END_OF_STREAM: 11,
  FILLER: 12,
} as const;

/** Extract the 5-bit AVC nal_unit_type from a NAL unit's header byte. */
export function avcNalType(unit: NalUnit): number {
  if (unit.data.byteLength === 0) return 0;
  return unit.data[0]! & 0x1f;
}

/**
 * True if any NAL unit in the array is an IDR slice (type 5). An access unit
 * containing an IDR is a random-access point — a keyframe in player terms.
 */
export function isKeyframe(units: NalUnit[]): boolean {
  for (const u of units) {
    if (avcNalType(u) === AvcNalType.IDR) return true;
  }
  return false;
}

/** Tag each NAL unit with its parsed type. Useful for downstream code that wants both. */
export interface AvcNalUnit extends NalUnit {
  type: number;
}

export function classify(units: NalUnit[]): AvcNalUnit[] {
  return units.map((u) => ({ ...u, type: avcNalType(u) }));
}

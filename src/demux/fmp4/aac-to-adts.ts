/*
 * hls-pipe — AAC raw-frame → ADTS bytestream conversion
 *
 * fMP4 stores AAC samples as "raw" frames — no ADTS header, codec config
 * lives in the init segment's esds box. To produce a stream that
 * `ffmpeg -f aac -i pipe:0` and friends can read, we synthesize a 7-byte
 * ADTS header for every sample.
 *
 * Inspired by hls.js src/remux/mp4-remuxer.ts (the inverse direction —
 * upstream removes ADTS and packs into MP4; we add ADTS to MP4 samples).
 * The header bit layout is straight ISO/IEC 13818-7 §6.2.
 *
 * ADTS fixed header (7 bytes when no CRC):
 *   syncword (12) = 0xFFF
 *   ID (1)        = 0 (MPEG-4) or 1 (MPEG-2)
 *   layer (2)     = 0
 *   protection_absent (1) = 1 (no CRC)
 *   profile (2)   = AudioObjectType - 1   (AAC LC AOT=2 → profile=1)
 *   sampling_frequency_index (4)
 *   private_bit (1) = 0
 *   channel_configuration (3)
 *   original_copy (1) = 0
 *   home (1)      = 0
 *   copyright_id_bit (1) = 0
 *   copyright_id_start (1) = 0
 *   aac_frame_length (13) = 7 + raw_data_block.length
 *   adts_buffer_fullness (11) = 0x7FF (variable bitrate / unknown)
 *   number_of_raw_data_blocks (2) = 0 (one block per ADTS frame)
 */

import type { AudioSpecificConfig } from './init-segment.js';

/**
 * Build a 7-byte ADTS header for the given codec config + raw AAC frame length.
 *
 * `aacRawLength` is the length of the raw_data_block bytes WITHOUT the
 * header — we add the 7-byte header to that to get aac_frame_length.
 *
 * Notes:
 *   - We always emit MPEG-4 ID (ID bit = 0).
 *   - We always omit CRC (protection_absent = 1).
 *   - Channel configurations > 7 are clamped to 7 (ADTS only has 3 bits).
 */
export function buildAdtsHeader(config: AudioSpecificConfig, aacRawLength: number): Uint8Array {
  const profile = Math.max(0, config.audioObjectType - 1) & 0x03;
  const sfi = config.samplingFrequencyIndex & 0x0f;
  const channelConfig = Math.min(7, config.channelConfiguration) & 0x07;
  const frameLength = aacRawLength + 7;
  if (frameLength > 0x1fff) {
    throw new Error(`ADTS aac_frame_length ${frameLength} exceeds 13-bit max`);
  }

  const hdr = new Uint8Array(7);
  hdr[0] = 0xff;
  // 0xF0 = sync low + ID=0 + layer=00, then protection_absent=1
  hdr[1] = 0xf1;
  hdr[2] = (profile << 6) | (sfi << 2) | (channelConfig >> 2);
  hdr[3] = ((channelConfig & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  hdr[4] = (frameLength >> 3) & 0xff;
  hdr[5] = ((frameLength & 0x07) << 5) | 0x1f; // top 5 bits of buffer_fullness all 1
  hdr[6] = 0xfc; // remaining 6 bits of buffer_fullness = 1, number_of_raw_data_blocks = 0
  return hdr;
}

/**
 * Wrap a list of raw AAC frames as a contiguous ADTS bytestream.
 * Single allocation, single memcpy per frame.
 */
export function framesToAdts(frames: Uint8Array[], config: AudioSpecificConfig): Uint8Array {
  // Pre-compute total size
  let total = 0;
  for (const f of frames) total += 7 + f.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    const hdr = buildAdtsHeader(config, f.byteLength);
    out.set(hdr, offset);
    offset += 7;
    out.set(f, offset);
    offset += f.byteLength;
  }
  return out;
}

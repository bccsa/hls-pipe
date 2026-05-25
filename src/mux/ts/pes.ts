/*
 * hls-pipe — PES packet writer (inverse of src/demux/pes.ts)
 *
 * Wraps elementary-stream bytes in a PES packet, encoding PTS/DTS in the
 * 33-bit / 5-byte-each format the demuxer reads back at src/demux/pes.ts.
 *
 * Layout (ISO 13818-1 §2.4.3.6):
 *   bytes 0-2  packet_start_code_prefix = 0x000001
 *   byte  3    stream_id (0xE0..0xEF video, 0xC0..0xDF audio)
 *   bytes 4-5  PES_packet_length (we use 0 for video; explicit for audio)
 *   byte  6    '10' marker + scrambling/priority/alignment_indicator etc.
 *   byte  7    PTS_DTS_flags(2) ESCR(1) ES_rate(1) DSM(1) addCopy(1) CRC(1) ext(1)
 *   byte  8    PES_header_data_length
 *   bytes 9..  PTS (5 bytes), then DTS (5 bytes) when PTS_DTS_flags = 0b11
 *   then       payload (ES bytes)
 */

/** Stream-ID ranges per ISO 13818-1 §2.4.3.7. */
export const StreamId = {
  /** First video stream. Use 0xE0..0xEF for multiple. */
  VIDEO: 0xe0,
  /** First audio stream. Use 0xC0..0xDF for multiple. */
  AUDIO: 0xc0,
} as const;

export interface BuildPesOptions {
  streamId: number;
  payload: Uint8Array;
  /** Presentation timestamp in 90 kHz units. */
  pts: number;
  /** Decode timestamp in 90 kHz units. If equal to pts, only PTS is written (saves 5 bytes). */
  dts?: number;
  /**
   * Whether `data_alignment_indicator` should be set. For H.264 PES, each PES
   * typically contains one complete access unit, which means alignment.
   */
  alignment?: boolean;
}

/**
 * Build a complete PES packet (header + payload) as one byte array. For video
 * PES we set PES_packet_length = 0 ("unbounded"), as is standard practice
 * because video PES can span many TS packets.
 */
export function buildPes(opts: BuildPesOptions): Uint8Array {
  const dts = opts.dts ?? opts.pts;
  const usePtsDts = dts !== opts.pts;
  const ptsLen = usePtsDts ? 10 : 5;
  // Length-zero on video PES means "unbounded"; for audio we set the actual length.
  const isVideo = opts.streamId >= 0xe0 && opts.streamId <= 0xef;
  const declaredLen = isVideo ? 0 : 3 + ptsLen + opts.payload.byteLength;

  const headerSize = 9 + ptsLen;
  const out = new Uint8Array(headerSize + opts.payload.byteLength);
  out[0] = 0x00;
  out[1] = 0x00;
  out[2] = 0x01;
  out[3] = opts.streamId;
  out[4] = (declaredLen >> 8) & 0xff;
  out[5] = declaredLen & 0xff;
  // marker '10' + scrambling 0 + priority 0 + alignment + copyright 0 + original 0
  out[6] = 0x80 | (opts.alignment ? 0x04 : 0);
  out[7] = usePtsDts ? 0xc0 : 0x80;
  out[8] = ptsLen;
  writePts(out, 9, opts.pts, usePtsDts ? 0x30 : 0x20);
  if (usePtsDts) writePts(out, 14, dts, 0x10);
  out.set(opts.payload, headerSize);
  return out;
}

/**
 * Encode a 33-bit timestamp into 5 bytes per ISO 13818-1 §2.4.3.6.
 *   byte 0: prefixNibble (4 bits) + bits[32..30] (3 bits) + marker '1' (1 bit)
 *   byte 1: bits[29..22]
 *   byte 2: bits[21..15] (7 bits) + marker '1'
 *   byte 3: bits[14..7]
 *   byte 4: bits[6..0] (7 bits) + marker '1'
 *
 * prefixNibble is 0x20 for PTS-only, 0x30 for PTS-with-DTS, 0x10 for DTS.
 */
function writePts(out: Uint8Array, offset: number, ts: number, prefixNibble: number): void {
  // Use floating-point math for the high bits since the value can be > 2^32.
  const hi3 = Math.floor(ts / 1073741824) & 0x07; // bits [32..30] (3 bits)
  const mid8 = Math.floor(ts / 4194304) & 0xff; //   bits [29..22] (8 bits)
  const next7 = Math.floor(ts / 32768) & 0x7f; //    bits [21..15] (7 bits)
  const low8 = Math.floor(ts / 128) & 0xff; //       bits [14..7]  (8 bits)
  const last7 = ts & 0x7f; //                        bits [6..0]   (7 bits)
  out[offset] = prefixNibble | (hi3 << 1) | 0x01;
  out[offset + 1] = mid8;
  out[offset + 2] = (next7 << 1) | 0x01;
  out[offset + 3] = low8;
  out[offset + 4] = (last7 << 1) | 0x01;
}

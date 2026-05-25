/*
 * hls-pipe — MPEG-TS packet writer
 *
 * Fresh module. Emits 188-byte TS packets (ISO/IEC 13818-1) with proper
 * continuity counter tracking per PID and optional adaptation fields for
 * PCR + payload padding.
 *
 * The writer accumulates into an internal Uint8Array buffer and exposes the
 * result via `toBytes()` after one segment's worth of packets have been
 * written. We allocate generously up front and slice the used range at the
 * end — simpler than tracking exact size in advance.
 *
 * Packet layout (188 bytes per ISO 13818-1 §2.4.3.2):
 *
 *   byte 0     sync (0x47)
 *   byte 1     1 bit transport_error_indicator (=0)
 *              1 bit payload_unit_start_indicator (PUSI)
 *              1 bit transport_priority (=0)
 *              5 bits PID high
 *   byte 2     8 bits PID low
 *   byte 3     2 bits transport_scrambling_control (=0)
 *              2 bits adaptation_field_control (1=payload only, 3=AF+payload)
 *              4 bits continuity_counter
 *   then either:
 *     - 184 bytes payload (atf=1), or
 *     - AF length byte + AF + payload (atf=3)
 */

export const PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;

export interface PacketChunk {
  /** Bytes to packetize. */
  bytes: Uint8Array;
  /** Set PUSI on the first packet of this chunk. */
  payloadStart: boolean;
  /** Optional 27 MHz PCR value; written in adaptation field of first packet only. */
  pcrBase?: number;
  /** Random-access-indicator flag in AF — set on the first packet of a keyframe. */
  randomAccess?: boolean;
  /**
   * Discontinuity-indicator flag in AF — set on the first packet of a chunk
   * to signal a CC discontinuity, PCR discontinuity, or stream-config change.
   * Decoders use this to re-initialize state (e.g., re-parse SPS/PPS after an
   * ABR variant switch).
   */
  discontinuity?: boolean;
}

export class TsPacketWriter {
  private readonly cc = new Map<number, number>(); // per-PID continuity counter
  private buffer: Uint8Array;
  private used = 0;

  constructor(initialCapacity = 64 * 1024) {
    this.buffer = new Uint8Array(initialCapacity);
  }

  /** Emit `chunk.bytes` as one or more TS packets for the given PID. */
  writeChunk(pid: number, chunk: PacketChunk): void {
    let payloadCursor = 0;
    let first = true;
    const total = chunk.bytes.byteLength;

    while (payloadCursor < total || (first && total === 0)) {
      this.ensureCapacity(this.used + PACKET_SIZE);
      const packet = this.buffer.subarray(this.used, this.used + PACKET_SIZE);
      const pusi = first && chunk.payloadStart;
      const includeAF =
        first &&
        (chunk.pcrBase !== undefined ||
          chunk.randomAccess === true ||
          chunk.discontinuity === true);

      // Header bytes
      packet[0] = SYNC_BYTE;
      packet[1] = ((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f)) & 0xff;
      packet[2] = pid & 0xff;
      const cc = this.nextCc(pid);
      // adaptation_field_control: we'll patch in lower nibble below; placeholder atf=1
      packet[3] = (0 << 6) | (1 << 4) | (cc & 0x0f);

      let payloadOffset = 4;

      // Optional adaptation field on first packet
      if (includeAF) {
        const afStart = payloadOffset; // = 4
        let af = 1; // af_length byte itself counts after; we'll set af_length last
        // AF flags byte
        let flags = 0;
        if (chunk.discontinuity) flags |= 0x80;
        if (chunk.randomAccess) flags |= 0x40;
        if (chunk.pcrBase !== undefined) flags |= 0x10;
        packet[afStart + 1] = flags;
        let afCursor = afStart + 2;
        if (chunk.pcrBase !== undefined) {
          writePcr(packet, afCursor, chunk.pcrBase);
          afCursor += 6;
        }
        af = afCursor - afStart - 1; // bytes after the af_length byte
        packet[afStart] = af;
        payloadOffset = afCursor;
        packet[3] = (0 << 6) | (3 << 4) | (cc & 0x0f);
      }

      // Compute how many bytes of payload fit in this packet.
      let payloadBytes = PACKET_SIZE - payloadOffset;
      const remaining = total - payloadCursor;
      if (remaining < payloadBytes) {
        // Need stuffing — pad the adaptation field to fill the packet.
        const need = payloadBytes - remaining;
        if (includeAF) {
          // Extend the existing AF with `need` stuffing bytes.
          const afStart = 4;
          const oldAf = packet[afStart]!;
          const newAf = oldAf + need;
          if (newAf > 183) throw new Error('TS packet stuffing overflow');
          packet[afStart] = newAf;
          // Shift payload right by `need` and fill the gap with 0xFF.
          // Simpler: payload starts later now; we'll just write to the shifted
          // location. The bytes at [payloadOffset, payloadOffset+need) get
          // filled with 0xFF.
          for (let i = 0; i < need; i++) packet[payloadOffset + i] = 0xff;
          payloadOffset += need;
          payloadBytes = remaining;
        } else {
          // Add a fresh AF for stuffing only.
          const afStart = 4;
          // 1 byte af_length + (need - 2) stuffing bytes if need >= 2
          // Special case need===1: af_length=0, no flags byte (per spec)
          if (need === 1) {
            packet[afStart] = 0;
            payloadOffset = afStart + 1;
          } else {
            packet[afStart] = need - 1;
            packet[afStart + 1] = 0; // flags (no PCR, no RA)
            for (let i = afStart + 2; i < afStart + need; i++) packet[i] = 0xff;
            payloadOffset = afStart + need;
          }
          packet[3] = (0 << 6) | (3 << 4) | (cc & 0x0f);
          payloadBytes = remaining;
        }
      }

      // Copy payload
      if (payloadBytes > 0) {
        packet.set(chunk.bytes.subarray(payloadCursor, payloadCursor + payloadBytes), payloadOffset);
      }
      payloadCursor += payloadBytes;
      this.used += PACKET_SIZE;
      first = false;

      if (total === 0) break; // empty-payload edge case
    }
  }

  /** Return all written bytes as a single Uint8Array (zero-copy slice). */
  toBytes(): Uint8Array {
    return this.buffer.subarray(0, this.used);
  }

  /**
   * Return all bytes written since the last `flush()` as a fresh owned copy,
   * then rewind the internal buffer. Continuity counters per PID are PRESERVED
   * across flushes — call `reset()` to also clear them (e.g., at an
   * EXT-X-DISCONTINUITY boundary).
   */
  flush(): Uint8Array {
    const out = new Uint8Array(this.used);
    out.set(this.buffer.subarray(0, this.used));
    this.used = 0;
    return out;
  }

  reset(): void {
    this.used = 0;
    this.cc.clear();
  }

  private nextCc(pid: number): number {
    const v = ((this.cc.get(pid) ?? -1) + 1) & 0x0f;
    this.cc.set(pid, v);
    return v;
  }

  private ensureCapacity(min: number): void {
    if (min <= this.buffer.byteLength) return;
    let cap = this.buffer.byteLength;
    while (cap < min) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.buffer.subarray(0, this.used));
    this.buffer = grown;
  }
}

/**
 * Write a PCR (Program Clock Reference) into the adaptation field at offset.
 *
 * PCR encoding (ISO 13818-1 §2.4.3.4):
 *   33 bits program_clock_reference_base (at 90 kHz)
 *   6 bits reserved (all 1s)
 *   9 bits program_clock_reference_extension (at 27 MHz / 90 kHz = 300 ticks)
 *
 * For our use case we set extension = 0 (the PTS-derived PCR has 90 kHz
 * granularity already).
 */
function writePcr(packet: Uint8Array, offset: number, pcrBase: number): void {
  // 33-bit base across 5 bytes + 1 byte: top 32 bits into bytes 0-3,
  // bit 32 into byte 4 high bit; reserved bits 5-1 of byte 4 = 0x7E;
  // extension high bit into byte 4 low bit; extension low 8 bits into byte 5.
  const hi = Math.floor(pcrBase / 0x100000000); // upper bit (bit 32)
  const lo = pcrBase >>> 0; // low 32 bits (>>>0 forces unsigned)
  packet[offset] = (lo >>> 25) & 0xff; // base bits 32..25... wait we have a 33-bit value
  // Actually let me redo: 33-bit pcrBase value. Bits [32..0].
  // packed as: byte 0 = bits [32..25], byte 1 = bits [24..17], byte 2 = bits [16..9],
  //            byte 3 = bits [8..1], byte 4 bit 7 = bit 0, byte 4 bits 6-1 = reserved (1),
  //            byte 4 bit 0 = ext bit 8, byte 5 = ext bits [7..0].
  packet[offset] = ((hi << 7) | (lo >>> 25)) & 0xff;
  packet[offset + 1] = (lo >>> 17) & 0xff;
  packet[offset + 2] = (lo >>> 9) & 0xff;
  packet[offset + 3] = (lo >>> 1) & 0xff;
  packet[offset + 4] = (((lo & 0x01) << 7) | 0x7e) & 0xff; // bit 0 + reserved 11111100... wait
  // Re-check: per spec, byte 4 = (base_bit0 << 7) | (reserved 6 bits, all 1) | (ext bit 8 << 0)
  // reserved is bits 6..1 = 0b111111 = 0x7E. ext bit 8 goes into bit 0.
  // We set ext = 0, so bit 0 = 0. So byte 4 = (base_bit0 << 7) | 0x7E.
  packet[offset + 5] = 0; // ext bits 7..0 = 0
}

/*
 * hls-pipe — PSI section writers: PAT + PMT
 *
 * Fresh module. Builds the inner *section* bytes for the Program Association
 * Table (PAT) and Program Map Table (PMT). The TS packet writer
 * (src/mux/ts/packet.ts) wraps these in the standard PSI envelope:
 *   - pointer_field byte (= 0)
 *   - the section bytes built here
 *   - stuffing bytes (0xFF) to pad to 183 bytes payload
 *
 * Section CRC is CRC-32/MPEG-2 (polynomial 0x04C11DB7, init 0xFFFFFFFF,
 * no reflection, no XOR-out).
 */

/** Build a PAT section announcing a single program. */
export function buildPat(programNumber: number, pmtPid: number, versionNumber = 0): Uint8Array {
  // PAT section layout (section_length = 13 covers everything after the 2-byte
  // length field, so total bytes = 3 header + 13 body = 16):
  //   table_id(8)
  //   section_syntax_indicator(1)+0(1)+reserved(2)+section_length(12)
  //   transport_stream_id(16) reserved(2) version(5) current_next(1)
  //   section_number(8) last_section_number(8)
  //   per-program: program_number(16) reserved(3) PMT_PID(13)
  //   crc32(32)
  //
  // The CRC covers everything before the CRC field itself (bytes 0..11);
  // the CRC bytes themselves go at indices 12..15. Earlier revisions of this
  // function sized the array at 17 with the CRC at 13..16, leaving byte 12
  // as a zero "junk" byte INSIDE the section_length window — that produced
  // an invalid PAT (CRC included a spurious byte AND the stored CRC was
  // mis-aligned), which ffmpeg silently rejects, falling back to PES-only
  // stream probing. Symptom: PMT descriptors (e.g. ISO 639 language tags)
  // never made it to AVFormatContext metadata.
  const out = new Uint8Array(16);
  out[0] = 0x00; // table_id = PAT
  out[1] = 0xb0; // section_syntax=1, '0', reserved=11, length_high 4 bits = 0
  out[2] = 0x0d; // section_length low 8 bits = 13
  out[3] = 0x00; // transport_stream_id high
  out[4] = 0x01; // transport_stream_id low = 1
  out[5] = 0xc0 | ((versionNumber & 0x1f) << 1) | 0x01; // reserved + version + current_next=1
  out[6] = 0x00; // section_number
  out[7] = 0x00; // last_section_number
  // Program entry
  out[8] = (programNumber >> 8) & 0xff;
  out[9] = programNumber & 0xff;
  out[10] = 0xe0 | ((pmtPid >> 8) & 0x1f); // reserved + PMT_PID high
  out[11] = pmtPid & 0xff;
  // CRC32/MPEG-2 over bytes 0..11 (everything before the 4-byte CRC).
  const crc = crc32Mpeg2(out.subarray(0, 12));
  out[12] = (crc >>> 24) & 0xff;
  out[13] = (crc >>> 16) & 0xff;
  out[14] = (crc >>> 8) & 0xff;
  out[15] = crc & 0xff;
  return out;
}

export interface PmtStreamSpec {
  streamType: number;
  pid: number;
  /**
   * Optional ISO 639-2 language code (alpha-3) to emit as an ISO 639 language
   * descriptor (tag 0x0a) in the stream's ES_info. Non-3-char strings are
   * accepted but trimmed/padded — for the typical alpha-3 case it's lossless.
   * Players that read language metadata (mpv with --alang, VLC's audio
   * preference, web browsers) will use this to pick the user's preferred
   * audio track. ffmpeg/ffplay surfaces it as `TAG:language` on the stream.
   */
  language?: string;
}

/**
 * Build a PMT section announcing one or more elementary streams under
 * `programNumber`. PCR PID is set to the first stream's PID (typical for
 * video-only or video-driven programs).
 *
 * When a stream provides `language`, an ISO 639 language descriptor is
 * inserted into its ES_info loop:
 *   descriptor_tag(8)=0x0a, descriptor_length(8)=4,
 *   ISO_639_language_code(24), audio_type(8)=0x00 (undefined).
 * This descriptor adds 6 bytes per language-tagged stream to the section.
 */
export function buildPmt(
  programNumber: number,
  streams: PmtStreamSpec[],
  versionNumber = 0,
): Uint8Array {
  if (streams.length === 0) throw new Error('PMT requires at least one stream');
  const pcrPid = streams[0]!.pid;
  // Precompute ES_info bytes per stream (variable length; 0 when no descriptors).
  const esInfos = streams.map((s) => (s.language ? buildIso639LanguageDescriptor(s.language) : new Uint8Array(0)));
  const esInfoTotal = esInfos.reduce((acc, b) => acc + b.byteLength, 0);
  // Section body bytes (everything except table_id + first 2 length bytes):
  //   table_id(8) + section_syntax_indicator+0+reserved+section_length(16) +
  //   program_number(16) + reserved+version+current_next(8) + section_number(8) + last_section_number(8) +
  //   reserved+PCR_PID(16) + reserved+program_info_length(16) +
  //   per stream: stream_type(8) + reserved+ES_PID(16) + reserved+ES_info_length(16) + ES_info bytes
  //   crc32(32)
  // We use program_info_length = 0 (no program-level descriptors).
  const sectionBodyLen = 9 + streams.length * 5 + esInfoTotal + 4; // after the first 3 bytes; includes CRC
  const out = new Uint8Array(3 + sectionBodyLen);
  out[0] = 0x02; // table_id = PMT
  out[1] = 0xb0 | ((sectionBodyLen >> 8) & 0x0f);
  out[2] = sectionBodyLen & 0xff;
  out[3] = (programNumber >> 8) & 0xff;
  out[4] = programNumber & 0xff;
  out[5] = 0xc0 | ((versionNumber & 0x1f) << 1) | 0x01;
  out[6] = 0x00; // section_number
  out[7] = 0x00; // last_section_number
  out[8] = 0xe0 | ((pcrPid >> 8) & 0x1f);
  out[9] = pcrPid & 0xff;
  out[10] = 0xf0; // reserved (4 bits) + program_info_length high 4
  out[11] = 0x00; // program_info_length low 8 = 0

  let cursor = 12;
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i]!;
    const esInfo = esInfos[i]!;
    out[cursor++] = s.streamType;
    out[cursor++] = 0xe0 | ((s.pid >> 8) & 0x1f);
    out[cursor++] = s.pid & 0xff;
    out[cursor++] = 0xf0 | ((esInfo.byteLength >> 8) & 0x0f); // reserved + ES_info_length high 4
    out[cursor++] = esInfo.byteLength & 0xff; // ES_info_length low 8
    if (esInfo.byteLength > 0) {
      out.set(esInfo, cursor);
      cursor += esInfo.byteLength;
    }
  }
  const crc = crc32Mpeg2(out.subarray(0, cursor));
  out[cursor++] = (crc >>> 24) & 0xff;
  out[cursor++] = (crc >>> 16) & 0xff;
  out[cursor++] = (crc >>> 8) & 0xff;
  out[cursor++] = crc & 0xff;
  return out;
}

/**
 * Build a single ISO 639 language descriptor (tag 0x0a) carrying one
 * language code. Per ISO/IEC 13818-1: descriptor_tag(8) + length(8) +
 * { ISO_639_language_code(24) + audio_type(8) }. Audio_type 0x00 = undefined
 * (not hearing/visual impaired, not clean effects). Language is normalized to
 * exactly 3 ASCII bytes — shorter strings pad with 0x20, longer truncate.
 */
function buildIso639LanguageDescriptor(language: string): Uint8Array {
  const code = normalizeLanguageCode(language);
  const out = new Uint8Array(6);
  out[0] = 0x0a; // descriptor_tag
  out[1] = 0x04; // descriptor_length
  out[2] = code.charCodeAt(0);
  out[3] = code.charCodeAt(1);
  out[4] = code.charCodeAt(2);
  out[5] = 0x00; // audio_type = undefined
  return out;
}

function normalizeLanguageCode(language: string): string {
  // ISO 639 language codes are ASCII lowercase. Strip non-ASCII, pad/truncate
  // to exactly 3 chars so the descriptor stays well-formed even on odd input.
  const cleaned = language.toLowerCase().replace(/[^a-z]/g, '');
  if (cleaned.length === 0) return 'und';
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  return cleaned.padEnd(3, ' ');
}

/**
 * Wrap a section in the PSI envelope expected by a TS packet: prepend
 * pointer_field(0). The packet writer will handle stuffing the remainder.
 */
export function withPointerField(section: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + section.byteLength);
  out[0] = 0x00; // pointer_field = 0 (section starts immediately)
  out.set(section, 1);
  return out;
}

// -- CRC-32/MPEG-2 ---------------------------------------------------------

let crcTable: Uint32Array | undefined;

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  const poly = 0x04c11db7;
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) {
      c = ((c & 0x80000000) !== 0) ? ((c << 1) ^ poly) >>> 0 : (c << 1) >>> 0;
    }
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32Mpeg2(bytes: Uint8Array): number {
  if (!crcTable) crcTable = buildCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    const tableIdx = ((crc >>> 24) ^ bytes[i]!) & 0xff;
    crc = ((crc << 8) ^ crcTable[tableIdx]!) >>> 0;
  }
  return crc >>> 0;
}

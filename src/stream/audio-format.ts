/*
 * hls-pipe — audio rendition format detection
 *
 * Fresh module. Alternate audio renditions in the wild come in three shapes:
 *
 *   1. Raw AAC ADTS files (`.aac`). The bytes ARE the elementary stream.
 *      Pass through unchanged. Example: BCC Africa's `audio_ch1_hq/*.aac`.
 *
 *   2. MPEG-TS wrapping a single audio stream (`.ts`). PAT/PMT announces
 *      one audio PID; the PES payload is on-wire codec bytes. Demux with
 *      the phase-4a Demuxer and concatenate the audio PES payloads.
 *      Example: Mux test stream variants (audio muxed with video, but the
 *      same shape applies to audio-only TS renditions).
 *
 *   3. fMP4 / CMAF (`.m4s`, `.mp4`) with separate `EXT-X-MAP` init segment.
 *      Phase-5 does not handle this — phase 7b's fMP4 demuxer does. We
 *      detect and throw early with a clear message.
 *
 * Detection strategy:
 *   - First try by URI suffix (cheap, works for all three test streams
 *     we've validated against).
 *   - Then sniff content if URI is ambiguous: 0xFF Fx → AAC ADTS,
 *     0x47 sync byte pattern → MPEG-TS, "ftyp" near start → fMP4.
 */

export type AudioFormat = 'aac' | 'ts' | 'fmp4' | 'unknown';

/** URI-based detection. Returns 'unknown' when no recognized suffix is found. */
export function detectByUri(uri: string): AudioFormat {
  // Strip query string + fragment before suffix check.
  const path = uri.split('?')[0]!.split('#')[0]!;
  const lower = path.toLowerCase();
  if (lower.endsWith('.aac')) return 'aac';
  if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return 'ts';
  if (lower.endsWith('.m4s') || lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'fmp4';
  return 'unknown';
}

/**
 * Content-based detection. Sniffs the first ~24 bytes.
 *   - 0xFF 0xFx     → AAC ADTS (sync word, 12 bits)
 *   - "ftyp" at 4-8 → fMP4 (ISO BMFF box at start)
 *   - 0x47 at 0 and 188 → MPEG-TS (two sync bytes one packet apart)
 */
export function detectByContent(bytes: Uint8Array): AudioFormat {
  if (bytes.byteLength < 4) return 'unknown';
  // ADTS sync = 0xFFF (12 bits) → first byte 0xFF, second byte top nibble F
  if (bytes[0] === 0xff && (bytes[1]! & 0xf0) === 0xf0) return 'aac';
  // fMP4 — `ftyp` box at byte 4..7 (the standard layout)
  if (
    bytes.byteLength >= 8 &&
    bytes[4] === 0x66 && // 'f'
    bytes[5] === 0x74 && // 't'
    bytes[6] === 0x79 && // 'y'
    bytes[7] === 0x70 //   'p'
  ) {
    return 'fmp4';
  }
  // MPEG-TS — sync byte at 0 AND at 188 (one full packet apart)
  if (bytes[0] === 0x47 && (bytes.byteLength < 189 || bytes[188] === 0x47)) {
    return 'ts';
  }
  return 'unknown';
}

/** URI → fall through to content sniff → unknown. */
export function detectAudioFormat(uri: string, sampleBytes?: Uint8Array): AudioFormat {
  const uriHint = detectByUri(uri);
  if (uriHint !== 'unknown') return uriHint;
  if (sampleBytes) return detectByContent(sampleBytes);
  return 'unknown';
}

export class UnsupportedAudioFormatError extends Error {
  constructor(public readonly format: AudioFormat, uri: string) {
    super(
      format === 'fmp4'
        ? `fMP4 audio rendition (${uri}) not yet supported — see phase 7b`
        : `unrecognized audio rendition format at ${uri}`,
    );
    this.name = 'UnsupportedAudioFormatError';
  }
}

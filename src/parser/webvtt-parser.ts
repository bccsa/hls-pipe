/*
 * hls-pipe — WebVTT segment parser for HLS subtitle renditions.
 *
 * HLS subtitle media playlists deliver short WebVTT segments (typically aligned
 * with the audio/video segment cadence). Each segment is a UTF-8 text file with:
 *
 *   WEBVTT[ optional header text]
 *   X-TIMESTAMP-MAP=MPEGTS:<ticks>,LOCAL:hh:mm:ss.mmm   (optional but typical)
 *
 *   00:00:01.500 --> 00:00:04.000[ cue settings]
 *   ...text lines...
 *
 *   ...next cue...
 *
 * The X-TIMESTAMP-MAP line lets us map WebVTT-local time to absolute MPEG-2
 * presentation time (90 kHz), so a cue at local 00:00:01.500 with
 * MPEGTS:900000, LOCAL:00:00:00.000 lands at PTS 1.0s after the first PTS in
 * the stream.
 *
 * We deliberately keep the original cue block bytes verbatim in
 * `WebVttCue.payload` — that's what the muxer puts inside a PES packet so
 * downstream burn nodes reassemble a normal WebVTT stream (timing line + text)
 * by concatenating PES payloads. We DO NOT rewrite cue timestamps — the PES
 * PTS carries absolute timing; the embedded timing line lets the consumer
 * see start/end + cue settings.
 */

const PTS_HZ = 90000;
const PTS_TICKS_PER_MS = 90;

export interface WebVttCue {
  /** Absolute PTS of cue start, 90 kHz units. */
  pts: number;
  /** Cue duration in 90 kHz ticks. Derived from "start --> end". */
  durationTicks: number;
  /** Original cue block bytes — '00:00:01.500 --> 00:00:04.000\n...text...\n'. UTF-8. */
  payload: Uint8Array;
}

export interface ParsedWebVttSegment {
  /** PTS offset from X-TIMESTAMP-MAP MPEGTS field (90 kHz), or 0 if absent. */
  mpegtsOffset: number;
  /** LOCAL offset from X-TIMESTAMP-MAP LOCAL field (90 kHz), or 0 if absent. */
  localOffset: number;
  /** True iff the segment carried an X-TIMESTAMP-MAP header line. */
  hasTimestampMap: boolean;
  cues: WebVttCue[];
}

export class WebVttParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebVttParseError';
  }
}

/**
 * Parse one WebVTT segment.
 *
 * When `X-TIMESTAMP-MAP` is present, each cue's `pts` is
 *   mpegtsOffset + (cueStartTicks - localOffset)
 * (the MPEGTS rollover at 2^33 ticks is left to the caller — segments stay
 * well under that for any reasonable session length.)
 *
 * When `X-TIMESTAMP-MAP` is absent and `fallbackBaseTicks` is supplied, cues
 * are placed at `fallbackBaseTicks + cueStartTicks` (cueStartTicks treated as
 * a within-segment offset). When neither is available, cues land at their
 * raw cueStartTicks — almost certainly wrong for muxing, but parsing still
 * succeeds so the caller can log + skip.
 */
export function parseWebVttSegment(bytes: Uint8Array, fallbackBaseTicks?: number): ParsedWebVttSegment {
  const text = decodeUtf8(bytes);
  // Normalise CRLF / lone CR to LF so block-splitting works uniformly.
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');

  if (lines.length === 0 || !lines[0]!.startsWith('WEBVTT')) {
    throw new WebVttParseError('missing WEBVTT magic on first line');
  }

  let mpegtsOffset = 0;
  let localOffset = 0;
  let hasTimestampMap = false;
  const cues: WebVttCue[] = [];

  // Walk the file in "blocks" separated by blank lines. The first block is the
  // header (WEBVTT line + optional header lines including X-TIMESTAMP-MAP).
  // Subsequent blocks are cues, NOTEs, STYLEs, or REGIONs.
  let i = 0;
  let firstBlock = true;
  while (i < lines.length) {
    // Skip leading blank lines.
    while (i < lines.length && lines[i] === '') i++;
    if (i >= lines.length) break;

    const blockStart = i;
    while (i < lines.length && lines[i] !== '') i++;
    const blockEnd = i;
    const blockLines = lines.slice(blockStart, blockEnd);

    if (firstBlock) {
      firstBlock = false;
      // Header block — look for X-TIMESTAMP-MAP on any line.
      for (const headerLine of blockLines) {
        const match = headerLine.match(/^X-TIMESTAMP-MAP\s*[:=]\s*(.+)$/i);
        if (match) {
          const map = parseTimestampMap(match[1]!);
          mpegtsOffset = map.mpegts;
          localOffset = map.local;
          hasTimestampMap = true;
        }
      }
      continue;
    }

    const firstLine = blockLines[0]!;
    if (firstLine === 'NOTE' || firstLine.startsWith('NOTE ') || firstLine.startsWith('NOTE\t')) continue;
    if (firstLine === 'STYLE') continue;
    if (firstLine === 'REGION') continue;

    // A cue block: optional ID line, then a timing line, then payload lines.
    // The timing line is the first line that contains "-->".
    let timingIdx = -1;
    for (let k = 0; k < blockLines.length; k++) {
      if (blockLines[k]!.includes('-->')) {
        timingIdx = k;
        break;
      }
    }
    if (timingIdx === -1) continue; // malformed — skip silently

    const timing = parseTimingLine(blockLines[timingIdx]!);
    if (!timing) continue;

    const baseTicks = hasTimestampMap
      ? mpegtsOffset - localOffset
      : fallbackBaseTicks ?? 0;
    const cuePts = baseTicks + timing.startTicks;
    const durationTicks = Math.max(0, timing.endTicks - timing.startTicks);

    // Preserve the cue payload bytes: timing line + cue settings (verbatim
    // from the source) + text lines + trailing newline. We drop any leading
    // ID line — the wire payload is the timing + body, which is the WebVTT
    // form most renderers expect when stitched back into a continuous file.
    const cueBody = blockLines.slice(timingIdx).join('\n') + '\n';
    const payload = encodeUtf8(cueBody);

    cues.push({ pts: cuePts, durationTicks, payload });
  }

  return { mpegtsOffset, localOffset, hasTimestampMap, cues };
}

function parseTimestampMap(value: string): { mpegts: number; local: number } {
  // Comma-separated key:value pairs, e.g. "MPEGTS:900000,LOCAL:00:00:00.000".
  // Either order is valid per the spec.
  let mpegts = 0;
  let local = 0;
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim().toUpperCase();
    const val = trimmed.slice(colonIdx + 1).trim();
    if (key === 'MPEGTS') {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) mpegts = n;
    } else if (key === 'LOCAL') {
      local = parseClockTimeToTicks(val);
    }
  }
  return { mpegts, local };
}

function parseTimingLine(line: string): { startTicks: number; endTicks: number } | undefined {
  // "00:00:01.500 --> 00:00:04.000 [optional cue settings...]"
  // hours-component is optional per the spec (mm:ss.mmm is also valid).
  const arrowIdx = line.indexOf('-->');
  if (arrowIdx === -1) return undefined;
  const left = line.slice(0, arrowIdx).trim();
  const rightFull = line.slice(arrowIdx + 3).trim();
  // The right side may have cue settings after the end timestamp, separated
  // by whitespace. Take everything up to the first whitespace as the end
  // timestamp; the rest (cue settings) is preserved in the payload via the
  // verbatim block slice in the caller — we just need the numeric end here.
  const wsIdx = rightFull.search(/\s/);
  const right = wsIdx === -1 ? rightFull : rightFull.slice(0, wsIdx);
  const startTicks = parseClockTimeToTicks(left);
  const endTicks = parseClockTimeToTicks(right);
  if (startTicks < 0 || endTicks < 0) return undefined;
  return { startTicks, endTicks };
}

function parseClockTimeToTicks(s: string): number {
  // Accepts "hh:mm:ss.mmm", "mm:ss.mmm", or "ss.mmm".
  const m = s.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/);
  if (!m) return -1;
  const a = m[1] !== undefined ? parseInt(m[1], 10) : undefined;
  const b = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
  const c = parseInt(m[3]!, 10);
  const ms = m[4] !== undefined ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (a !== undefined && b !== undefined) {
    hours = a;
    minutes = b;
    seconds = c;
  } else if (a !== undefined) {
    minutes = a;
    seconds = c;
  } else {
    seconds = c;
  }
  const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
  return totalMs * PTS_TICKS_PER_MS;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

function encodeUtf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

// Re-export the 90 kHz tick constant for callers that need it (e.g. tests).
export const WEBVTT_PTS_HZ = PTS_HZ;

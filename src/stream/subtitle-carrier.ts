/*
 * hls-pipe — subtitle carrier seam + cue-to-wire timing
 *
 * The inline-subtitle path turns parsed WebVTT cues into private PES packets
 * on their own PID. WHAT goes inside each PES (and how the PMT announces the
 * PID) is the carrier's business — `SubtitleCarrier`, injectable through
 * `ExtractorOptions.subtitleCarrier`, default `VTT_PRIVATE_CARRIER`. WHEN
 * each PES is written is decided here (`drainCues`) so every carrier gets
 * the same timing contract:
 *
 *   - a cue PES is written at the cue's START position in the output
 *     stream, interleaved with the video of that moment, never ahead of it.
 *     The subtitle playlist is fetched independently of video, so cues can
 *     be known long before their start; many consumers (any MPEG-TS
 *     re-stamper, the media-router splitter and muxer among them) rewrite a
 *     private-only PES's PTS to its arrival time and keep only the latest
 *     cue, so a cue sent early would show early or be overwritten before it
 *     ever showed;
 *   - a cue whose start has already passed when its segment is muxed (the
 *     subtitle playlist can also lag the video) is written at once, at the
 *     current position, with its remaining span;
 *   - a cue that has already ended is dropped (counted for the log);
 *   - while a cue is live the carrier may ask for it to be RE-SENT every
 *     `resendTicks` with the remaining span, so a consumer that joins
 *     mid-cue still shows it. A newer cue ends the previous cue's re-sends.
 *
 * `drainCues` is pure (buffer in, samples out) and tested without any
 * network or muxer.
 */

import type { WebVttCue } from '../parser/webvtt-parser.js';
import type { SubtitleSampleIn } from '../mux/ts/muxer.js';
import { DEFAULT_SUBTITLE_PID_BASE, StreamType, SUBTITLE_FORMAT_ID_WEBVTT } from '../mux/ts/muxer.js';
import { buildRegistrationDescriptor } from '../mux/ts/pat-pmt.js';

/** One cue as handed to a carrier's `encode`. */
export interface SubtitleCueOut {
  /** Absolute cue start on the output timeline, 90 kHz. */
  startTicks: number;
  /** Absolute cue end on the output timeline, 90 kHz (> startTicks). */
  endTicks: number;
  /** Cue text: markup tags stripped, entities decoded, lines `\n`-joined. */
  text: string;
  /** The source WebVTT cue block verbatim (timing line + settings + text). */
  payload: Uint8Array;
}

/** How the PMT announces a subtitle PID — the part the muxer needs. */
export interface SubtitlePmtSpec {
  /** PMT stream_type of every subtitle PID. */
  streamType: number;
  /**
   * ES descriptors (raw bytes, tag + length + payload) attached to every
   * subtitle PID. The ISO 639 language descriptor is added by the muxer
   * when the source declared a language; do not include one here.
   */
  descriptors: Uint8Array[];
}

export interface SubtitleCarrier extends SubtitlePmtSpec {
  /** First subtitle PID; languages take pidBase, pidBase + 1, … in list order. */
  pidBase: number;
  /**
   * Re-send a live cue this often (90 kHz ticks), each time encoded against
   * the re-send's own PES PTS. 0 = every cue is written exactly once.
   */
  resendTicks: number;
  /**
   * PES payload for `cue` written at `pesPts` (90 kHz). `pesPts` is at or
   * after the cue start and before its end: the first write is at the cue
   * start (or the current position when the start has passed), re-sends
   * later in the span.
   */
  encode(cue: SubtitleCueOut, pesPts: number): Uint8Array;
}

/**
 * hls-pipe's original carrier: the WebVTT cue block verbatim in a
 * private_stream_1 PES, PMT registration_descriptor "VTT ". Visible to
 * consumers that know this convention; GStreamer's tsdemux does not create
 * a pad for it.
 */
export const VTT_PRIVATE_CARRIER: SubtitleCarrier = {
  streamType: StreamType.PES_PRIVATE,
  descriptors: [buildRegistrationDescriptor(SUBTITLE_FORMAT_ID_WEBVTT)],
  pidBase: DEFAULT_SUBTITLE_PID_BASE,
  resendTicks: 0,
  encode: (cue) => cue.payload,
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

/**
 * Plain text of a WebVTT cue block: the lines after the timing line, with
 * cue-text tags (`<i>`, `<c.cls>`, `<v Name>`, `<00:00:01.000>` …) removed
 * and the WebVTT character references decoded. Trailing blank lines dropped.
 */
export function cueText(payload: Uint8Array): string {
  const block = new TextDecoder('utf-8').decode(payload).replace(/\r\n?/g, '\n');
  const lines = block.split('\n');
  const timingIdx = lines.findIndex((l) => l.includes('-->'));
  // Tags off, trailing whitespace off, THEN entities — an explicit `&nbsp;`
  // at the end of a line is content, not padding.
  const body = lines.slice(timingIdx + 1).map((l) =>
    l
      .replace(/<[^>]*>/g, '')
      .trimEnd()
      .replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g, (_, name: string) => ENTITIES[name] ?? ''),
  );
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

/** The cue currently live on the wire, carried across segments for re-sends. */
export interface ActiveCue extends SubtitleCueOut {
  /** Output-timeline position (90 kHz) of the next re-send. */
  nextResend: number;
}

/** The stretch of output timeline one mux batch covers, `[startTicks, endTicks)`. */
export interface MuxWindow {
  startTicks: number;
  endTicks: number;
}

export interface DrainResult {
  samples: SubtitleSampleIn[];
  active: ActiveCue | undefined;
  /** Cues that had already ended before they could be written. */
  dropped: number;
}

/**
 * Write every cue that is due within `window` (see the module comment for
 * the timing contract). `pending` holds source-domain cues (`ptsShift` maps
 * them to the output timeline) in any order; the ones written are removed,
 * the rest stay for a later batch. Samples come back PTS-ascending.
 */
export function drainCues(
  pending: WebVttCue[],
  active: ActiveCue | undefined,
  window: MuxWindow,
  ptsShift: number,
  carrier: SubtitleCarrier,
): DrainResult {
  const samples: SubtitleSampleIn[] = [];
  let dropped = 0;

  const resendUpTo = (limit: number): void => {
    if (!active || carrier.resendTicks <= 0) return;
    while (active.nextResend < limit && active.nextResend < active.endTicks) {
      const pts = Math.max(active.nextResend, window.startTicks);
      samples.push({ pts, data: carrier.encode(active, pts) });
      active.nextResend = pts + carrier.resendTicks;
    }
  };

  // Pull the due cues out of the buffer; the rest wait for a later window.
  const due: Array<{ start: number; end: number; cue: WebVttCue }> = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    const cue = pending[i]!;
    const start = cue.pts + ptsShift;
    if (start >= window.endTicks) continue;
    pending.splice(i, 1);
    due.push({ start, end: start + cue.durationTicks, cue });
  }
  due.sort((a, b) => a.start - b.start);

  for (const { start, end, cue } of due) {
    const pesPts = Math.max(start, window.startTicks);
    if (end <= pesPts) {
      dropped++;
      continue;
    }
    resendUpTo(pesPts);
    const out: SubtitleCueOut = {
      startTicks: start,
      endTicks: end,
      text: cueText(cue.payload),
      payload: cue.payload,
    };
    samples.push({ pts: pesPts, data: carrier.encode(out, pesPts) });
    active = { ...out, nextResend: pesPts + carrier.resendTicks };
  }
  resendUpTo(window.endTicks);
  if (active && active.endTicks <= window.endTicks) active = undefined;

  return { samples, active, dropped };
}

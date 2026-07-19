/*
 * hls-pipe — top-level MPEG-TS muxer
 *
 * Combines the PSI / PES / packet writers into a `MpegTsMuxer` class that
 * accepts elementary-stream samples (with PTS/DTS in 90 kHz) and emits a
 * conforming MPEG-TS byte stream.
 *
 * Phase 7b.3 scope: single video stream (H.264). Audio multiplexed into the
 * same TS lands as 7b.3.2 — it requires additional PID allocation + PTS
 * coordination between streams. Multi-language audio continues to be written
 * to per-language `.aac` files via the phase-5/7b.2 audio coordinator.
 */

import { buildPat, buildPmt, buildRegistrationDescriptor, withPointerField } from './pat-pmt.js';
import { buildPes, StreamId } from './pes.js';
import { TsPacketWriter } from './packet.js';

/** Stream-type values per ISO/IEC 13818-1 Table 2-29. */
export const StreamType = {
  /** ITU-T Rec. H.264. */
  AVC: 0x1b,
  /** ITU-T Rec. H.265 / ISO/IEC 23008-2. */
  HEVC: 0x24,
  /** ISO/IEC 13818-7 ADTS AAC. */
  AAC_ADTS: 0x0f,
  /**
   * PES carrying private data. Used here for WebVTT subtitles — paired with a
   * registration_descriptor in the PMT carrying the 4CC "VTT " so downstream
   * demuxers can distinguish it from other private-data uses (DVB AC-3, etc.).
   */
  PES_PRIVATE: 0x06,
} as const;

export const DEFAULT_PMT_PID = 0x1000;
export const DEFAULT_VIDEO_PID = 0x100;
export const DEFAULT_AUDIO_PID = 0x101;
/**
 * Base PID for inline-muxed subtitle streams. Assigned sequentially in
 * user-specified language order: first language at 0x110, second at 0x111, …
 * Sits above the typical audio range (0x101..0x10F) so audio PID assignment
 * and subtitle PID assignment never collide.
 */
export const DEFAULT_SUBTITLE_PID_BASE = 0x110;
/** 4CC carried in the registration_descriptor for WebVTT subtitle PIDs. */
export const SUBTITLE_FORMAT_ID_WEBVTT = 'VTT ';
const PAT_PID = 0x0000;

export interface VideoSampleIn {
  /** Annex-B encoded NAL bytes. */
  data: Uint8Array;
  /** Presentation timestamp in 90 kHz units. */
  pts: number;
  /** Decode timestamp in 90 kHz units. */
  dts: number;
  /** True if this access unit contains a random-access keyframe (IDR for H.264). */
  isKeyframe: boolean;
}

export interface AudioSampleIn {
  /** Already-framed audio bytes (ADTS for AAC, raw frame for MP3/AC-3). */
  data: Uint8Array;
  /** Presentation timestamp in 90 kHz units (DTS = PTS for audio). */
  pts: number;
}

export interface SubtitleSampleIn {
  /**
   * WebVTT cue block bytes (UTF-8). Includes the timing line, optional cue
   * settings, and text lines, with a trailing newline. One cue per sample.
   */
  data: Uint8Array;
  /**
   * Absolute presentation timestamp in 90 kHz units (DTS = PTS for subtitles).
   * Should already be shifted into the same domain as video/audio PTS by the
   * caller (e.g. by the same `ptsShift` the inline-AV muxer applies).
   */
  pts: number;
}

export interface SubtitleStreamIn {
  pid: number;
  /** ISO 639 language code (e.g. "eng"). Emitted as a language descriptor. */
  language?: string;
  samples: SubtitleSampleIn[];
}

export interface MpegTsMuxerOptions {
  videoPid?: number;
  audioPid?: number;
  pmtPid?: number;
  programNumber?: number;
  /** Stream type (default StreamType.AVC). Use StreamType.HEVC for H.265. */
  videoStreamType?: number;
  /** Stream type for the audio stream (default StreamType.AAC_ADTS). */
  audioStreamType?: number;
}

/**
 * Emit MPEG-TS bytes. A single muxer instance is designed to live for the
 * entire output stream (live or VOD): `mux()` / `muxMulti()` may be called
 * repeatedly, once per HLS segment, and continuity counters are preserved
 * across calls so ffmpeg / ffplay don't flag CC discontinuities at segment
 * boundaries. Each call emits a fresh PAT + PMT + sample run and returns the
 * bytes for that call only. Call `reset()` to clear CC state at an
 * EXT-X-DISCONTINUITY boundary.
 *
 *   - `mux()` accepts video-only samples
 *   - `muxAv()` / `muxMulti()` accept video + N audio streams interleaved
 *     by DTS, with a multi-stream PMT
 */
/**
 * True media span (seconds) of a mux batch, from its video samples' DTS
 * ladder: (last − first) plus one average frame duration. Segment EXTINF is
 * only an approximation of this (rounded, GOP-quantized cuts) — pacing a
 * sink by EXTINF makes wire delivery wander ±hundreds of ms around real
 * time over consecutive segments (measured ±550–760 ms / ±0.7 % rate wobble
 * on 6 s segments declared as flat 6.0), which downstream real-time
 * consumers cannot smooth. Undefined for fewer than two samples — caller
 * falls back to the declared duration.
 */
export function videoSpanSeconds(samples: ReadonlyArray<{ dts: number }>): number | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0]!.dts;
  const last = samples[samples.length - 1]!.dts;
  if (last <= first) return undefined;
  const frameDur = (last - first) / (samples.length - 1);
  return (last - first + frameDur) / 90000;
}

export class MpegTsMuxer {
  private readonly videoPid: number;
  private readonly audioPid: number;
  private readonly pmtPid: number;
  private readonly programNumber: number;
  private readonly videoStreamType: number;
  private readonly audioStreamType: number;
  private readonly writer = new TsPacketWriter();
  /**
   * Bumped on each `signalDiscontinuity()` call so the next PAT/PMT carries a
   * fresh `version_number` — that's what decoders watch to know they should
   * re-parse stream configuration (e.g., new SPS/PPS after an ABR switch).
   */
  private psiVersion = 0;
  /**
   * Set by `signalDiscontinuity()`, consumed on the next `mux()`/`muxMulti()`
   * call — applies the AF `discontinuity_indicator` to the first emitted
   * packet so downstream decoders re-init their state.
   */
  private pendingDiscontinuity = false;

  constructor(opts: MpegTsMuxerOptions = {}) {
    this.videoPid = opts.videoPid ?? DEFAULT_VIDEO_PID;
    this.audioPid = opts.audioPid ?? DEFAULT_AUDIO_PID;
    this.pmtPid = opts.pmtPid ?? DEFAULT_PMT_PID;
    this.programNumber = opts.programNumber ?? 1;
    this.videoStreamType = opts.videoStreamType ?? StreamType.AVC;
    this.audioStreamType = opts.audioStreamType ?? StreamType.AAC_ADTS;
  }

  /**
   * Mux a list of video samples into a TS bytestream. PAT + PMT are written
   * at the start; one PES per video sample follows. PCR is written in the
   * adaptation field of the first packet of each keyframe (which is the
   * minimum cadence required by the spec for a conformant stream).
   */
  mux(samples: VideoSampleIn[]): Uint8Array {
    if (samples.length === 0) return new Uint8Array(0);

    this.writeTables([{ streamType: this.videoStreamType, pid: this.videoPid }]);

    let firstVideo = true;
    for (const sample of samples) {
      const pes = buildPes({
        streamId: StreamId.VIDEO,
        payload: sample.data,
        pts: sample.pts,
        dts: sample.dts,
        alignment: true,
      });
      const chunk: { bytes: Uint8Array; payloadStart: boolean; pcrBase?: number; randomAccess?: boolean; discontinuity?: boolean } = {
        bytes: pes,
        payloadStart: true,
      };
      if (sample.isKeyframe) {
        chunk.pcrBase = sample.dts;
        chunk.randomAccess = true;
      }
      if (firstVideo && this.pendingDiscontinuity) {
        chunk.discontinuity = true;
        this.pendingDiscontinuity = false;
      }
      firstVideo = false;
      this.writer.writeChunk(this.videoPid, chunk);
    }

    return this.writer.flush();
  }

  /**
   * Single-audio-stream convenience: equivalent to muxAv() with one audio
   * track at audioPid. Kept for backwards compat with the phase 7b.3.2 API.
   */
  muxAv(samples: { video: VideoSampleIn[]; audio: AudioSampleIn[] }): Uint8Array {
    if (samples.video.length === 0 && samples.audio.length === 0) return new Uint8Array(0);
    return this.muxMulti({
      video: samples.video,
      audios: [{ pid: this.audioPid, streamType: this.audioStreamType, samples: samples.audio }],
    });
  }

  /**
   * Mux video + N audio streams (one PID each) into a single TS bytestream
   * with a multi-stream PMT. Each audio language gets its own PID per ISO
   * 13818-1 / HLS multi-audio convention. PIDs are caller-assigned (defaults
   * 0x101, 0x102, ...).
   *
   * All samples (video + every audio stream) are interleaved across PIDs in
   * DTS-ascending order. Video keyframes carry PCR + random-access flag in
   * their first TS packet's adaptation field; audio packets do not.
   */
  muxMulti(samples: {
    video: VideoSampleIn[];
    audios: { pid: number; streamType: number; samples: AudioSampleIn[]; language?: string }[];
    subtitles?: SubtitleStreamIn[];
  }): Uint8Array {
    const subtitleStreams = samples.subtitles ?? [];
    if (
      samples.video.length === 0 &&
      samples.audios.every((a) => a.samples.length === 0) &&
      subtitleStreams.every((s) => s.samples.length === 0)
    ) {
      return new Uint8Array(0);
    }
    // Stream-id allocation: first audio gets 0xC0, second 0xC1, etc.
    const audioStreamIds = samples.audios.map((_, i) => 0xc0 + i);
    // Subtitle streams all share stream_id 0xBD (private_stream_1) — the PID
    // is what distinguishes them in the TS, and decoders demux private streams
    // by PID, not by stream_id.
    const streams = [
      { streamType: this.videoStreamType, pid: this.videoPid },
      ...samples.audios.map((a) => ({
        streamType: a.streamType,
        pid: a.pid,
        ...(a.language ? { language: a.language } : {}),
      })),
      ...subtitleStreams.map((s) => ({
        streamType: StreamType.PES_PRIVATE,
        pid: s.pid,
        ...(s.language ? { language: s.language } : {}),
        descriptors: [buildRegistrationDescriptor(SUBTITLE_FORMAT_ID_WEBVTT)],
      })),
    ];
    this.writeTables(streams);

    type Task =
      | { kind: 'v'; sample: VideoSampleIn; dts: number }
      | { kind: 'a'; pid: number; streamId: number; sample: AudioSampleIn; dts: number }
      | { kind: 's'; pid: number; sample: SubtitleSampleIn; dts: number };
    const tasks: Task[] = [
      ...samples.video.map((s) => ({ kind: 'v' as const, sample: s, dts: s.dts })),
      ...samples.audios.flatMap((audio, idx) =>
        audio.samples.map((s) => ({
          kind: 'a' as const,
          pid: audio.pid,
          streamId: audioStreamIds[idx]!,
          sample: s,
          dts: s.pts,
        })),
      ),
      ...subtitleStreams.flatMap((sub) =>
        sub.samples.map((s) => ({
          kind: 's' as const,
          pid: sub.pid,
          sample: s,
          dts: s.pts,
        })),
      ),
    ];
    tasks.sort((a, b) => a.dts - b.dts);

    let firstVideo = true;
    for (const task of tasks) {
      if (task.kind === 'v') {
        const v = task.sample;
        const pes = buildPes({
          streamId: StreamId.VIDEO,
          payload: v.data,
          pts: v.pts,
          dts: v.dts,
          alignment: true,
        });
        const chunk: { bytes: Uint8Array; payloadStart: boolean; pcrBase?: number; randomAccess?: boolean; discontinuity?: boolean } = {
          bytes: pes,
          payloadStart: true,
        };
        // PCR on EVERY video access unit, not only keyframes. ISO 13818-1
        // wants PCR at most 100 ms apart; keyframe-only PCR (one per GOP —
        // 2 s on typical ladders) leaves receivers improvising a timeline
        // for up to a GOP after joining mid-stream. Measured downstream in
        // media-router: two gst tsdemux instances fed from this stream
        // anchored their timelines 1.5 s apart, surfacing as constant A/V
        // lipsync skew after a re-mux. Cost: 8 adaptation-field bytes on one
        // packet per AU (20 ms cadence at 50 fps ⇒ ~3 kbps).
        chunk.pcrBase = v.dts;
        if (v.isKeyframe) {
          chunk.randomAccess = true;
        }
        if (firstVideo && this.pendingDiscontinuity) {
          chunk.discontinuity = true;
          this.pendingDiscontinuity = false;
        }
        firstVideo = false;
        this.writer.writeChunk(this.videoPid, chunk);
      } else if (task.kind === 'a') {
        const a = task.sample;
        const pes = buildPes({
          streamId: task.streamId,
          payload: a.data,
          pts: a.pts,
          alignment: true,
        });
        this.writer.writeChunk(task.pid, { bytes: pes, payloadStart: true });
      } else {
        // Subtitle: private_stream_1 PES, PTS only (no DTS), no alignment flag.
        const s = task.sample;
        const pes = buildPes({
          streamId: StreamId.PRIVATE_STREAM_1,
          payload: s.data,
          pts: s.pts,
        });
        this.writer.writeChunk(task.pid, { bytes: pes, payloadStart: true });
      }
    }

    return this.writer.flush();
  }

  /** Clear continuity-counter state. Use at EXT-X-DISCONTINUITY boundaries. */
  reset(): void {
    this.writer.reset();
  }

  /**
   * Signal that the next emitted segment crosses a stream-config boundary
   * (e.g., ABR variant switch with different SPS/PPS or profile). On the
   * next `mux()`/`muxMulti()` call this:
   *   1. Bumps the PAT/PMT `version_number`, which tells decoders to
   *      re-parse the program map and re-initialize video-codec state.
   *   2. Sets the AF `discontinuity_indicator` on the first VIDEO packet
   *      (not the PAT) so the video decoder tolerates the boundary while
   *      the audio decoder is left undisturbed — across variants the audio
   *      rendition's codec/sample-rate doesn't change, and re-initing the
   *      audio decoder is audible as a soft click.
   *
   * Continuity counters are NOT cleared — they remain monotonic across the
   * boundary so a casual demuxer sees no CC error.
   */
  signalDiscontinuity(): void {
    this.psiVersion = (this.psiVersion + 1) & 0x1f;
    this.pendingDiscontinuity = true;
  }

  private writeTables(
    streams: { streamType: number; pid: number; language?: string; descriptors?: Uint8Array[] }[],
  ): void {
    const patSection = withPointerField(buildPat(this.programNumber, this.pmtPid, this.psiVersion));
    this.writer.writeChunk(PAT_PID, { bytes: patSection, payloadStart: true });
    const pmtSection = withPointerField(buildPmt(this.programNumber, streams, this.psiVersion));
    this.writer.writeChunk(this.pmtPid, { bytes: pmtSection, payloadStart: true });
  }
}

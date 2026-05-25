/*
 * hls-pipe — output mode dispatch
 *
 * Fresh module. Wraps the per-segment "bytes → bytes" transform that the
 * extractor applies before writing to the sink:
 *
 *   - "ts"           passthrough (phase-1 behavior; forwards whatever's in the segment)
 *   - "es-audio"     demux MPEG-TS, emit AAC/MP3/AC-3 elementary stream
 *   - "es-video"     demux MPEG-TS, emit H.264/HEVC Annex-B elementary stream
 *   - "ts-canonical" emit a canonical MPEG-TS regardless of source container
 *                    (fMP4 → demux + TS re-mux; MPEG-TS → passthrough)
 */

import { Demuxer } from '../demux/demuxer.js';
import { Fmp4VideoExtractor } from '../demux/fmp4/video.js';
import { MpegTsMuxer } from '../mux/ts/muxer.js';
import { parseAnnexB } from '../demux/video/nal-framing.js';
import { isKeyframe as nalUnitsContainKeyframe } from '../demux/video/avc.js';

export type OutputModeId = 'ts' | 'es-audio' | 'es-video' | 'ts-canonical';

export interface OutputMode {
  readonly id: OutputModeId;
  /** Transform a complete segment's bytes. Returns the bytes to write to the sink. */
  transform(bytes: Uint8Array): Uint8Array;
  /**
   * Should an EXT-X-MAP init section be forwarded to the sink for this mode?
   * Init data is meaningful for downstream consumers expecting fMP4 byte
   * streams (implicitly true for `ts` mode when source is fMP4). Modes that
   * consume the init internally via `setInit()` typically return false here.
   */
  readonly forwardInitSection: boolean;
  /**
   * Optional: called when the extractor encounters a new EXT-X-MAP, with the
   * init segment's bytes. Modes that need the init to parse subsequent
   * segments (e.g., fMP4-aware modes) implement this; pure passthrough
   * modes leave it undefined.
   */
  setInit?(bytes: Uint8Array): void;
  /** Reset any cached state at EXT-X-DISCONTINUITY boundaries. */
  resetContiguity?(): void;
}

/** Default mode: write segment bytes unchanged. Works for TS source and forwards fMP4 byte streams. */
export class TsPassthroughMode implements OutputMode {
  readonly id = 'ts';
  readonly forwardInitSection = true;
  transform(bytes: Uint8Array): Uint8Array {
    return bytes;
  }
}

/**
 * Demux MPEG-TS, concatenate audio PES payloads, write them to the sink.
 *
 * For AAC streams the payload IS valid ADTS-framed AAC, directly playable by
 * `ffmpeg -f aac -i pipe:0`. For MP3 / AC-3 streams the payload is likewise
 * the on-wire elementary bitstream. Per-frame parsing lands in phase 4b.
 *
 * Throws if the segment is not MPEG-TS (e.g., fMP4 .m4s segments). fMP4
 * audio extraction is a phase-7 concern.
 */
export class EsAudioMode implements OutputMode {
  readonly id = 'es-audio';
  readonly forwardInitSection = false;
  private readonly demuxer = new Demuxer();

  transform(bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength === 0) return bytes;
    let result;
    try {
      result = this.demuxer.demux(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `--output=es-audio requires MPEG-TS source; demux failed: ${msg}. fMP4 audio extraction lands in phase 7.`,
      );
    }
    if (result.audio.length === 0) return new Uint8Array(0);
    // Pre-compute total length so we allocate once.
    let total = 0;
    for (const pes of result.audio) total += pes.data.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const pes of result.audio) {
      out.set(pes.data, offset);
      offset += pes.data.byteLength;
    }
    return out;
  }

  resetContiguity(): void {
    this.demuxer.resetContiguity();
  }
}

/**
 * Demux MPEG-TS, concatenate video PES payloads, write them to the sink.
 *
 * For H.264 / HEVC streams the PES payload is the Annex-B elementary bitstream
 * (with start codes already inline) — directly playable by `ffmpeg -f h264 -i pipe:0`
 * or `ffmpeg -f hevc -i pipe:0`. Phase-7a.1 doesn't strip emulation-prevention
 * bytes or re-frame; it just concatenates the on-wire bytes.
 */
export class EsVideoMode implements OutputMode {
  readonly id = 'es-video';
  readonly forwardInitSection = false;
  private readonly demuxer = new Demuxer();

  transform(bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength === 0) return bytes;
    let result;
    try {
      result = this.demuxer.demux(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `--output=es-video requires MPEG-TS source; demux failed: ${msg}. fMP4 video extraction lands in phase 7b.`,
      );
    }
    if (result.video.length === 0) return new Uint8Array(0);
    let total = 0;
    for (const pes of result.video) total += pes.data.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const pes of result.video) {
      out.set(pes.data, offset);
      offset += pes.data.byteLength;
    }
    return out;
  }

  resetContiguity(): void {
    this.demuxer.resetContiguity();
  }
}

/**
 * Canonical MPEG-TS output. Passes through MPEG-TS sources unchanged; for
 * fMP4 sources, demuxes the init + each fragment and re-muxes to TS with
 * fresh PAT/PMT/PES + PCR on keyframes.
 *
 * Phase 7b.3 scope: video stream only. Audio multiplexed into the same TS
 * lands in phase 7b.3.2; for now multi-language audio continues to write to
 * per-language `.aac` files via `--audio=<langs>`.
 */
export class TsCanonicalMode implements OutputMode {
  readonly id = 'ts-canonical';
  readonly forwardInitSection = false; // We consume init via setInit()
  private readonly fmp4Video = new Fmp4VideoExtractor();
  private initLoaded = false;

  setInit(bytes: Uint8Array): void {
    // Only fMP4 sources have an EXT-X-MAP — feed it to the video extractor.
    this.fmp4Video.setInit(bytes);
    this.initLoaded = true;
  }

  transform(bytes: Uint8Array): Uint8Array {
    if (bytes.byteLength === 0) return bytes;
    // MPEG-TS passthrough: first byte 0x47 + a second sync byte 188 later.
    if (bytes[0] === 0x47 && (bytes.byteLength < 189 || bytes[188] === 0x47)) {
      return bytes;
    }
    // Otherwise assume fMP4 source. Require init to have been provided.
    if (!this.initLoaded) {
      throw new Error(
        '--output=ts-canonical received a non-TS segment before an EXT-X-MAP init section was loaded',
      );
    }
    const samples = this.fmp4Video.samples(bytes);
    if (samples.length === 0) return new Uint8Array(0);
    const muxer = new MpegTsMuxer();
    return muxer.mux(
      samples.map((s) => ({ data: s.data, pts: s.pts, dts: s.dts, isKeyframe: s.isKeyframe })),
    );
  }

  /**
   * Extract video samples for external AV-muxing. Used by the extractor's
   * inline-audio path when ts-canonical + inline-audio are configured.
   * Handles both source containers:
   *   - fMP4: uses Fmp4VideoExtractor (avcC-driven length-prefix → Annex-B)
   *   - MPEG-TS: demuxes the source TS, pulls video PES packets, parses NAL
   *     units to detect keyframes
   */
  extractVideoSamples(bytes: Uint8Array): {
    data: Uint8Array;
    pts: number;
    dts: number;
    isKeyframe: boolean;
  }[] {
    if (bytes.byteLength === 0) return [];
    if (bytes[0] === 0x47 && (bytes.byteLength < 189 || bytes[188] === 0x47)) {
      return this.extractFromTs(bytes);
    }
    if (!this.initLoaded) {
      throw new Error(
        'extractVideoSamples called before setInit; the extractor must load the fMP4 init segment first',
      );
    }
    return this.fmp4Video.samples(bytes).map((s) => ({
      data: s.data,
      pts: s.pts,
      dts: s.dts,
      isKeyframe: s.isKeyframe,
    }));
  }

  /** TS source: each video PES becomes one VideoSampleIn. */
  private readonly tsDemuxer = new Demuxer();
  private extractFromTs(
    bytes: Uint8Array,
  ): { data: Uint8Array; pts: number; dts: number; isKeyframe: boolean }[] {
    const result = this.tsDemuxer.demux(bytes);
    return result.video.map((pes) => ({
      data: pes.data,
      pts: pes.pts ?? pes.dts ?? 0,
      dts: pes.dts ?? pes.pts ?? 0,
      isKeyframe: nalUnitsContainKeyframe(parseAnnexB(pes.data)),
    }));
  }

  /**
   * Current PTS shift (90 kHz units) the video extractor has accumulated for
   * negative-CTS fixup. Inline-audio muxing applies the same shift to audio
   * PTS so AV alignment is preserved — without this, audio leads video by the
   * shift and ffplay periodically resyncs, which is audible as a soft click.
   * Returns 0 for MPEG-TS sources (no fmp4 extractor involved).
   */
  getVideoPtsShift(): number {
    return this.fmp4Video.getPtsShift();
  }

  resetContiguity(): void {
    // Init segment is re-loaded by the extractor on the next segment.
    this.initLoaded = false;
  }
}

export function makeOutputMode(id: OutputModeId): OutputMode {
  switch (id) {
    case 'ts':
      return new TsPassthroughMode();
    case 'es-audio':
      return new EsAudioMode();
    case 'es-video':
      return new EsVideoMode();
    case 'ts-canonical':
      return new TsCanonicalMode();
  }
}

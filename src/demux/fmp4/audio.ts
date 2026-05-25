/*
 * hls-pipe — fMP4 audio rendition extractor façade
 *
 * Stateful helper: feed it the init segment once, then call `transform()` on
 * each media segment to get a contiguous ADTS bytestream of that segment's
 * audio samples.
 *
 * Designed to plug into AudioRenditionExtractor (phase-5) replacing the
 * "fMP4 audio is unsupported" throw.
 */

import { readAudioTracks, type AudioTrackInfo } from './init-segment.js';
import { readTrackFragments } from './movie-fragment.js';
import { buildAdtsHeader, framesToAdts } from './aac-to-adts.js';

/** Per-sample AAC frame with ADTS header attached + PTS in 90 kHz. */
export interface Fmp4AudioFrame {
  /** 7-byte ADTS header + AAC raw_data_block bytes. */
  data: Uint8Array;
  /** Presentation timestamp in 90 kHz units (audio: PTS == DTS). */
  pts: number;
  /** Per-sample duration in 90 kHz units. */
  duration: number;
}

const PTS_TIMESCALE = 90000;

export class Fmp4AudioExtractor {
  private track: AudioTrackInfo | undefined;

  /** Feed the init segment (EXT-X-MAP bytes). Must be called before transform(). */
  setInit(initSegment: Uint8Array): void {
    const tracks = readAudioTracks(initSegment);
    if (tracks.length === 0) {
      throw new Error('fMP4 init segment contains no audio track');
    }
    this.track = tracks[0]!;
  }

  /** True once setInit has been called successfully. */
  isReady(): boolean {
    return this.track !== undefined;
  }

  /** Track metadata from the init segment (codec config + sample rate). */
  getTrack(): AudioTrackInfo | undefined {
    return this.track;
  }

  /**
   * Convert one media segment's raw AAC samples to an ADTS bytestream.
   * Returns an empty Uint8Array if the segment contains no samples for this
   * track (rare but possible).
   */
  transform(mediaSegment: Uint8Array): Uint8Array {
    if (!this.track) {
      throw new Error('Fmp4AudioExtractor.transform called before setInit');
    }
    const trackId = this.track.trackId;
    const frags = readTrackFragments(mediaSegment);
    const frames: Uint8Array[] = [];
    for (const frag of frags) {
      if (frag.trackId !== trackId) continue;
      for (const sample of frag.samples) {
        frames.push(sample.data);
      }
    }
    if (frames.length === 0) return new Uint8Array(0);
    return framesToAdts(frames, this.track.audioConfig);
  }

  /**
   * Return each AAC sample wrapped in its own ADTS header, tagged with its
   * PTS (90 kHz) and duration (90 kHz). Used by the AV-mux path
   * (`MpegTsMuxer.muxAv`) where each PES carries one ADTS frame.
   */
  frames(mediaSegment: Uint8Array): Fmp4AudioFrame[] {
    if (!this.track) {
      throw new Error('Fmp4AudioExtractor.frames called before setInit');
    }
    const { trackId, timescale, audioConfig } = this.track;
    const toPts = (v: number): number => Math.round((v * PTS_TIMESCALE) / timescale);
    const frags = readTrackFragments(mediaSegment);
    const out: Fmp4AudioFrame[] = [];
    for (const frag of frags) {
      if (frag.trackId !== trackId) continue;
      for (const sample of frag.samples) {
        const hdr = buildAdtsHeader(audioConfig, sample.data.byteLength);
        const adts = new Uint8Array(7 + sample.data.byteLength);
        adts.set(hdr, 0);
        adts.set(sample.data, 7);
        out.push({
          data: adts,
          pts: toPts(sample.dts),
          duration: toPts(sample.duration),
        });
      }
    }
    return out;
  }
}

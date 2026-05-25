/*
 * hls-pipe — TS demuxer façade
 *
 * Fresh implementation, inspired by hls.js src/demux/tsdemuxer.ts main loop
 * (lines ~210-475 in v1.6.x). The bit-level primitives this composes
 * (`src/demux/ts-packet.ts`, `src/demux/pat-pmt.ts`, `src/demux/pes.ts`) are
 * direct ports with Apache 2.0 attribution; this façade reorganizes them
 * into a per-segment API without the upstream's event-bus coupling, MSE
 * codec gating, or Web Worker hosting.
 *
 * Phase-4a scope: produce PES payloads tagged with PTS/DTS. Codec-level
 * parsing (H.264 NAL extraction, AAC ADTS frame validation, ID3 tag parsing)
 * lands in phase-4b. For audio that is already framed-on-wire (AAC ADTS,
 * MP3, AC-3) the PES payload IS the elementary-stream bitstream and is
 * directly playable by ffmpeg.
 */

import { parsePAT, parsePMT, type PmtStreams } from './pat-pmt.js';
import { PesAccumulator, type PesPacket } from './pes.js';
import {
  PACKET_LENGTH,
  PID_NULL,
  PID_PAT,
  parsePacketHeader,
  SYNC_BYTE,
  syncOffset,
} from './ts-packet.js';

export interface DemuxResult {
  /** PMT-derived stream map. `videoPid === -1` and `audioPid === -1` when PMT wasn't seen. */
  streams: PmtStreams;
  /** Complete PES packets emitted for the video PID, in stream order. */
  video: PesPacket[];
  /** Complete PES packets emitted for the audio PID, in stream order. */
  audio: PesPacket[];
  /** Complete PES packets emitted for the ID3 metadata PID, in stream order. */
  metadata: PesPacket[];
  /** Count of TS packets that failed the sync-byte check inside the segment. */
  malformedPackets: number;
}

export interface DemuxerOptions {
  /**
   * If true, PMT state persists across `demux()` calls. Set to false (or
   * call `resetContiguity()`) at EXT-X-DISCONTINUITY boundaries.
   * Default: true.
   */
  carryPmtAcrossSegments?: boolean;
}

/**
 * Stateful TS demuxer. Typical usage:
 *
 *   const demuxer = new Demuxer();
 *   for each segment {
 *     const result = demuxer.demux(segmentBytes);
 *     // pipe result.audio[i].data to your AAC sink, etc.
 *   }
 *
 * The demuxer caches PMT info across segments by default so live streams
 * don't repeat PMT-discovery work. On discontinuity, call resetContiguity().
 */
export class Demuxer {
  private readonly carryPmt: boolean;
  /** Cached streams from the most recent PMT seen. */
  private streams: PmtStreams = emptyStreams();
  /** PMT PID, discovered from PAT. */
  private pmtPid: number = -1;

  constructor(opts: DemuxerOptions = {}) {
    this.carryPmt = opts.carryPmtAcrossSegments ?? true;
  }

  /**
   * Demux one segment's worth of TS bytes. Discovers (or reuses) PMT,
   * reassembles PES packets across TS packets, and returns all complete
   * PES packets found. Any in-flight PES at the end of the segment is
   * finalized via a flush (HLS segments are expected to be self-contained).
   */
  demux(data: Uint8Array): DemuxResult {
    if (data.byteLength === 0) {
      return { streams: { ...this.streams }, video: [], audio: [], metadata: [], malformedPackets: 0 };
    }

    const start0 = Math.max(0, syncOffset(data));
    if (start0 < 0) {
      throw new Error('TS sync byte not found — input is not a valid MPEG-TS stream');
    }

    // Trim trailing bytes that don't fit a whole packet.
    const len = data.byteLength - ((data.byteLength - start0) % PACKET_LENGTH);

    // Local accumulators — finalized at end of segment.
    const videoAcc = new PesAccumulator();
    const audioAcc = new PesAccumulator();
    const id3Acc = new PesAccumulator();
    const videoOut: PesPacket[] = [];
    const audioOut: PesPacket[] = [];
    const id3Out: PesPacket[] = [];
    let malformed = 0;

    for (let start = start0; start < len; start += PACKET_LENGTH) {
      if (data[start] !== SYNC_BYTE) {
        malformed++;
        continue;
      }
      const hdr = parsePacketHeader(data, start);
      if (hdr.payloadOffset < 0) continue;
      const payload = data.subarray(hdr.payloadOffset, start + PACKET_LENGTH);

      // PID dispatch
      if (hdr.pid === PID_PAT) {
        // PAT — at most once per segment in practice, but a stream may carry it more often.
        let offset = hdr.payloadOffset;
        if (hdr.payloadUnitStart) {
          // First byte after the PAT header in a PSI packet is pointer_field;
          // skip it (plus the field's own length).
          offset += data[offset]! + 1;
        }
        this.pmtPid = parsePAT(data, offset);
        continue;
      }

      if (hdr.pid === this.pmtPid && this.pmtPid > 0) {
        let offset = hdr.payloadOffset;
        if (hdr.payloadUnitStart) {
          offset += data[offset]! + 1;
        }
        const parsed = parsePMT(data, offset);
        // Stream PIDs that come back as -1 mean "no stream of that type found".
        // We accept those and clear the corresponding cached value so a switch
        // (e.g., audio-only segment after audio+video) isn't sticky.
        this.streams = parsed;
        continue;
      }

      if (hdr.pid === this.streams.videoPid) {
        if (hdr.payloadUnitStart && !videoAcc.isEmpty()) {
          const pes = videoAcc.finish();
          if (pes) videoOut.push(pes);
        }
        videoAcc.push(payload);
        continue;
      }

      if (hdr.pid === this.streams.audioPid) {
        if (hdr.payloadUnitStart && !audioAcc.isEmpty()) {
          const pes = audioAcc.finish();
          if (pes) audioOut.push(pes);
        }
        audioAcc.push(payload);
        continue;
      }

      if (hdr.pid === this.streams.id3Pid) {
        if (hdr.payloadUnitStart && !id3Acc.isEmpty()) {
          const pes = id3Acc.finish();
          if (pes) id3Out.push(pes);
        }
        id3Acc.push(payload);
        continue;
      }

      // Null packets, unknown PIDs — drop silently.
      if (hdr.pid === PID_NULL) continue;
    }

    // Finalize any in-flight PES at end of segment.
    const tailVideo = videoAcc.finish();
    if (tailVideo) videoOut.push(tailVideo);
    const tailAudio = audioAcc.finish();
    if (tailAudio) audioOut.push(tailAudio);
    const tailId3 = id3Acc.finish();
    if (tailId3) id3Out.push(tailId3);

    const result: DemuxResult = {
      streams: { ...this.streams },
      video: videoOut,
      audio: audioOut,
      metadata: id3Out,
      malformedPackets: malformed,
    };

    if (!this.carryPmt) {
      this.streams = emptyStreams();
      this.pmtPid = -1;
    }
    return result;
  }

  /**
   * Clear cached PMT state. Call at EXT-X-DISCONTINUITY boundaries or when
   * switching between unrelated TS sources.
   */
  resetContiguity(): void {
    this.streams = emptyStreams();
    this.pmtPid = -1;
  }

  /** Most recently discovered PMT, for diagnostic use. */
  getStreams(): Readonly<PmtStreams> {
    return this.streams;
  }
}

function emptyStreams(): PmtStreams {
  return {
    videoPid: -1,
    videoCodec: undefined,
    audioPid: -1,
    audioCodec: undefined,
    id3Pid: -1,
  };
}

/*
 * hls-pipe — library entrypoint
 *
 * Re-exports the surfaces a programmatic user would need. CLI users go
 * through src/cli.ts instead.
 */

export { Extractor, clampStartTime } from './stream/extractor.js';
export type { ExtractorOptions } from './stream/extractor.js';
export { pickVariant, NoVariantsError } from './stream/variant-selector.js';
export type { QualityHint } from './stream/variant-selector.js';
export { StdoutSink } from './output/stdout-sink.js';
export type { SegmentSink } from './output/stdout-sink.js';
export { NodeLoader, HttpError } from './loader/node-loader.js';
export type { NodeLoaderOptions } from './loader/node-loader.js';
export {
  isMasterPlaylist,
  parseMaster,
  parseMedia,
  findSegmentAtTime,
  ParseError,
} from './parser/m3u8-parser.js';
export {
  AbrController,
  DEFAULT_ABR_CONFIG,
  UNSTABLE_NETWORK_ABR_CONFIG,
} from './abr/abr-controller.js';
export type { AbrConfig, LevelInfo } from './abr/abr-controller.js';
export { EwmaBandWidthEstimator } from './abr/bandwidth-estimator.js';
export { PlaylistCache } from './stream/playlist-cache.js';
export { LatencyController, DEFAULT_LATENCY_CONFIG } from './stream/latency-controller.js';
export type { LatencyConfig } from './stream/latency-controller.js';
export { Demuxer } from './demux/demuxer.js';
export type { DemuxResult, DemuxerOptions } from './demux/demuxer.js';
export { parsePAT, parsePMT, StreamType } from './demux/pat-pmt.js';
export type { PmtStreams, VideoCodec, AudioCodec } from './demux/pat-pmt.js';
export {
  TsPassthroughMode,
  EsAudioMode,
  EsVideoMode,
  makeOutputMode,
} from './output/output-mode.js';
export type { OutputMode, OutputModeId } from './output/output-mode.js';
export { parseAnnexB } from './demux/video/nal-framing.js';
export type { NalUnit } from './demux/video/nal-framing.js';
export { AvcNalType, avcNalType, isKeyframe, classify } from './demux/video/avc.js';
export type { AvcNalUnit } from './demux/video/avc.js';
export {
  iterateBoxes,
  iterateChildren,
  findBox,
  findChild,
  findChildren,
  findPath,
  boxPayload,
  readFullBoxHeader,
  BoxParseError,
} from './demux/fmp4/box.js';
export type { Box } from './demux/fmp4/box.js';
export {
  readAudioTracks,
  parseAudioSpecificConfig,
  InitSegmentError,
} from './demux/fmp4/init-segment.js';
export type { AudioTrackInfo, AudioSpecificConfig } from './demux/fmp4/init-segment.js';
export { readTrackFragments, MovieFragmentError } from './demux/fmp4/movie-fragment.js';
export type { TrackFragment, FragmentSample } from './demux/fmp4/movie-fragment.js';
export { buildAdtsHeader, framesToAdts } from './demux/fmp4/aac-to-adts.js';
export { Fmp4AudioExtractor } from './demux/fmp4/audio.js';
export { extractAacFrames, framesFromAdts, parseId3v2Header, RawAacExtractError } from './demux/raw-aac.js';
export type { RawAacFrame } from './demux/raw-aac.js';
export {
  readVideoTracks,
  parseAvcC,
  VideoInitError,
} from './demux/fmp4/avc-config.js';
export type { AvcConfig, VideoTrackInfo } from './demux/fmp4/avc-config.js';
export {
  Fmp4VideoExtractor,
  splitLengthPrefixed,
  toAnnexB,
} from './demux/fmp4/video.js';
export type { VideoSample as Fmp4VideoSample } from './demux/fmp4/video.js';
export {
  MpegTsMuxer,
  DEFAULT_PMT_PID,
  DEFAULT_VIDEO_PID,
  DEFAULT_AUDIO_PID,
  DEFAULT_SUBTITLE_PID_BASE,
  SUBTITLE_FORMAT_ID_WEBVTT,
} from './mux/ts/muxer.js';
export type {
  VideoSampleIn,
  AudioSampleIn,
  SubtitleSampleIn,
  SubtitleStreamIn,
  MpegTsMuxerOptions,
} from './mux/ts/muxer.js';
export { TsPacketWriter, PACKET_SIZE } from './mux/ts/packet.js';
export {
  buildPat,
  buildPmt,
  buildRegistrationDescriptor,
  withPointerField,
  crc32Mpeg2,
} from './mux/ts/pat-pmt.js';
export type { PmtStreamSpec } from './mux/ts/pat-pmt.js';
export { buildPes, StreamId } from './mux/ts/pes.js';
export type { BuildPesOptions } from './mux/ts/pes.js';
export { TsCanonicalMode } from './output/output-mode.js';
export { FileSink } from './output/file-sink.js';
export { AudioCoordinator } from './stream/audio-coordinator.js';
export type { AudioLanguageSelection } from './stream/audio-coordinator.js';
export { AudioRenditionExtractor } from './stream/audio-rendition-extractor.js';
export { SubtitleCoordinator } from './stream/subtitle-coordinator.js';
export type {
  SubtitleLanguageSelection,
  SubtitleTrackBinding,
} from './stream/subtitle-coordinator.js';
export { SubtitleRenditionExtractor } from './stream/subtitle-rendition-extractor.js';
export type { SubtitleRenditionExtractorOptions } from './stream/subtitle-rendition-extractor.js';
export {
  parseWebVttSegment,
  WebVttParseError,
  WEBVTT_PTS_HZ,
} from './parser/webvtt-parser.js';
export type { WebVttCue, ParsedWebVttSegment } from './parser/webvtt-parser.js';
export {
  detectAudioFormat,
  detectByUri,
  detectByContent,
  UnsupportedAudioFormatError,
} from './stream/audio-format.js';
export type { AudioFormat } from './stream/audio-format.js';
export {
  decryptAes128Cbc,
  deriveIv,
  DecryptError,
  UnsupportedKeyMethodError,
} from './crypt/decrypter.js';
export { KeyCache } from './crypt/key-cache.js';
export type {
  AlternateRendition,
  Loader,
  LoaderProgress,
  LoaderRequest,
  LoaderResult,
  MasterPlaylist,
  MediaPlaylist,
  Segment,
  SegmentKey,
  Variant,
} from './types.js';

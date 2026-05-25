/*
 * hls-pipe — M3U8 parser (master + media playlists)
 *
 * Inspired by hls.js src/loader/m3u8-parser.ts. Fresh implementation
 * scoped to the tags needed for phase 1 (VOD passthrough). The grammar
 * follows RFC 8216. As phases add features (encryption, LL-HLS partials,
 * date-ranges, etc.) we extend the tag handlers here.
 *
 * Upstream reference for the full tag surface:
 *   https://github.com/video-dev/hls.js/blob/master/src/loader/m3u8-parser.ts
 *
 * Notable omissions vs. hls.js (will be filled in later phases):
 *   - EXT-X-PART / EXT-X-PRELOAD-HINT (LL-HLS)
 *   - EXT-X-DATERANGE (interstitials, SCTE-35)
 *   - EXT-X-DEFINE variable substitution
 *   - EXT-X-SESSION-DATA / EXT-X-SESSION-KEY
 *   - EXT-X-RENDITION-REPORT
 *   - CLOSED-CAPTIONS=NONE handling
 */

import { AttrList } from './attr-list.js';
import { resolveUrl } from './url.js';
import type {
  AlternateRendition,
  MasterPlaylist,
  MediaPlaylist,
  Segment,
  SegmentKey,
  Variant,
} from '../types.js';

const MAGIC = '#EXTM3U';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Determines whether a manifest is a master (multivariant) playlist or a
 * media playlist. Spec: master playlists contain EXT-X-STREAM-INF; media
 * playlists contain EXTINF. They MUST NOT both appear in the same playlist.
 */
export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF[: ]/m.test(text);
}

export function parseMaster(text: string, baseUrl: string): MasterPlaylist {
  if (!text.startsWith(MAGIC)) {
    throw new ParseError('manifest does not start with #EXTM3U');
  }

  const variants: Variant[] = [];
  const audio: AlternateRendition[] = [];
  const subtitles: AlternateRendition[] = [];
  const closedCaptions: AlternateRendition[] = [];
  let independentSegments = false;

  const lines = splitLines(text);
  let pendingStreamInf: AttrList | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;

    if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
      independentSegments = true;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = new AttrList(line.slice('#EXT-X-MEDIA:'.length));
      const rendition = readMedia(attrs, baseUrl);
      if (!rendition) continue;
      switch (rendition.type) {
        case 'AUDIO':
          audio.push(rendition);
          break;
        case 'SUBTITLES':
          subtitles.push(rendition);
          break;
        case 'CLOSED-CAPTIONS':
          closedCaptions.push(rendition);
          break;
        default:
          break;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingStreamInf = new AttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    // Non-tag line following an EXT-X-STREAM-INF — its URI.
    if (pendingStreamInf && !line.startsWith('#')) {
      variants.push(readVariant(pendingStreamInf, line, baseUrl));
      pendingStreamInf = undefined;
      continue;
    }

    // Ignore unhandled tags silently — phase 1 scope.
  }

  return { variants, audio, subtitles, closedCaptions, independentSegments };
}

function readVariant(attrs: AttrList, uri: string, baseUrl: string): Variant {
  const bandwidth = attrs.int('BANDWIDTH');
  if (bandwidth === undefined) {
    throw new ParseError('EXT-X-STREAM-INF missing BANDWIDTH');
  }
  const variant: Variant = {
    uri: resolveUrl(uri, baseUrl),
    bitrate: bandwidth,
  };
  const avg = attrs.int('AVERAGE-BANDWIDTH');
  if (avg !== undefined) variant.averageBitrate = avg;
  const codecs = attrs.get('CODECS');
  if (codecs) variant.codecs = codecs;
  const resolution = attrs.resolution('RESOLUTION');
  if (resolution) variant.resolution = resolution;
  const frameRate = attrs.float('FRAME-RATE');
  if (frameRate !== undefined) variant.frameRate = frameRate;
  const audioGroup = attrs.get('AUDIO');
  if (audioGroup) variant.audioGroup = audioGroup;
  const subtitleGroup = attrs.get('SUBTITLES');
  if (subtitleGroup) variant.subtitleGroup = subtitleGroup;
  const name = attrs.get('NAME');
  if (name) variant.name = name;
  return variant;
}

function readMedia(attrs: AttrList, baseUrl: string): AlternateRendition | undefined {
  const type = attrs.get('TYPE');
  if (!type) return undefined;
  if (type !== 'AUDIO' && type !== 'SUBTITLES' && type !== 'CLOSED-CAPTIONS' && type !== 'VIDEO') {
    return undefined;
  }
  const groupId = attrs.get('GROUP-ID');
  const name = attrs.get('NAME');
  if (!groupId || !name) return undefined;

  const uri = attrs.get('URI');
  const rendition: AlternateRendition = {
    type,
    groupId,
    name,
    isDefault: attrs.bool('DEFAULT'),
    autoselect: attrs.bool('AUTOSELECT'),
    forced: attrs.bool('FORCED'),
  };
  const language = attrs.get('LANGUAGE');
  if (language) rendition.language = language;
  const assocLanguage = attrs.get('ASSOC-LANGUAGE');
  if (assocLanguage) rendition.assocLanguage = assocLanguage;
  const characteristics = attrs.get('CHARACTERISTICS');
  if (characteristics) rendition.characteristics = characteristics;
  const channels = attrs.get('CHANNELS');
  if (channels) rendition.channels = channels;
  if (uri) rendition.uri = resolveUrl(uri, baseUrl);
  return rendition;
}

// -- Media playlist --------------------------------------------------------

/**
 * Find the segment in `playlist` whose `[startTimeSec, startTimeSec + duration)`
 * range contains `mediaTimeSec`. Returns undefined if `mediaTimeSec` is past
 * the playlist's end. Used by the extractor for cross-variant alignment when
 * mediaSequence numbers don't line up across variants (phase 7b.4).
 */
export function findSegmentAtTime(
  playlist: MediaPlaylist,
  mediaTimeSec: number,
): Segment | undefined {
  if (playlist.segments.length === 0) return undefined;
  if (mediaTimeSec < 0) return playlist.segments[0]!;
  // Linear scan — adequate for typical HLS playlists (< 10k segments) and
  // avoids a binary-search edge case on empty/zero-duration runs. Phase
  // 7b.4 stretch goal: switch to bisect if profiling shows it's hot.
  for (const seg of playlist.segments) {
    if (mediaTimeSec < seg.startTimeSec + seg.duration) return seg;
  }
  return undefined;
}

export function parseMedia(text: string, baseUrl: string): MediaPlaylist {
  if (!text.startsWith(MAGIC)) {
    throw new ParseError('manifest does not start with #EXTM3U');
  }

  const playlist: MediaPlaylist = {
    uri: baseUrl,
    version: 1,
    targetDuration: 0,
    mediaSequence: 0,
    discontinuitySequence: 0,
    endList: false,
    segments: [],
    totalDuration: 0,
  };

  const lines = splitLines(text);

  // Carried state across lines
  let pendingDuration: number | undefined;
  let pendingTitle: string | undefined;
  let pendingByteRange: { length: number; offset: number } | undefined;
  let pendingDiscontinuity = false;
  let pendingPDT: number | undefined;
  let activeKey: SegmentKey | undefined;
  let activeInit: { uri: string; byteRange?: { length: number; offset: number } } | undefined;
  // Used to compute default BYTERANGE offset (continuation from prior segment in same resource).
  let lastByteRangeEnd: number | undefined;
  let lastByteRangeUri: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;

    if (line.startsWith('#EXT-X-VERSION:')) {
      const v = parseInt(line.slice('#EXT-X-VERSION:'.length), 10);
      if (Number.isFinite(v)) playlist.version = v;
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const v = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (Number.isFinite(v)) playlist.targetDuration = v;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const v = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
      if (Number.isFinite(v)) playlist.mediaSequence = v;
      continue;
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      const v = parseInt(line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length), 10);
      if (Number.isFinite(v)) playlist.discontinuitySequence = v;
      continue;
    }

    if (line === '#EXT-X-ENDLIST') {
      playlist.endList = true;
      continue;
    }

    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true;
      continue;
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const v = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
      if (v === 'VOD' || v === 'EVENT') playlist.playlistType = v;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = new AttrList(line.slice('#EXT-X-KEY:'.length));
      activeKey = readKey(attrs, baseUrl);
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = new AttrList(line.slice('#EXT-X-MAP:'.length));
      const uri = attrs.get('URI');
      if (uri) {
        activeInit = { uri: resolveUrl(uri, baseUrl) };
        const br = attrs.get('BYTERANGE');
        if (br) {
          const parsed = parseByteRange(br, undefined);
          if (parsed) activeInit.byteRange = parsed;
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const v = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
      const t = Date.parse(v);
      if (Number.isFinite(t)) pendingPDT = t;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const br = line.slice('#EXT-X-BYTERANGE:'.length);
      const parsed = parseByteRange(br, lastByteRangeEnd);
      if (parsed) pendingByteRange = parsed;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      // EXTINF:<duration>[,<title>]
      const payload = line.slice('#EXTINF:'.length);
      const commaIdx = payload.indexOf(',');
      const durStr = commaIdx === -1 ? payload : payload.slice(0, commaIdx);
      const titleStr = commaIdx === -1 ? '' : payload.slice(commaIdx + 1);
      pendingDuration = parseFloat(durStr);
      if (!Number.isFinite(pendingDuration)) pendingDuration = 0;
      if (titleStr) pendingTitle = titleStr;
      continue;
    }

    // Non-tag, non-empty line: segment URI
    if (!line.startsWith('#') && pendingDuration !== undefined) {
      const segUrl = resolveUrl(line, baseUrl);
      const index = playlist.segments.length;
      const seg: Segment = {
        index,
        mediaSequence: playlist.mediaSequence + index,
        uri: segUrl,
        duration: pendingDuration,
        startTimeSec: playlist.totalDuration,
        discontinuity: pendingDiscontinuity,
      };
      if (pendingTitle !== undefined) seg.title = pendingTitle;
      if (pendingByteRange) {
        seg.byteRange = pendingByteRange;
        lastByteRangeEnd = pendingByteRange.offset + pendingByteRange.length;
        lastByteRangeUri = segUrl;
      } else {
        // Different resource → reset implicit byterange chain
        if (lastByteRangeUri !== segUrl) {
          lastByteRangeEnd = undefined;
          lastByteRangeUri = undefined;
        }
      }
      if (activeInit) seg.initSection = activeInit;
      if (activeKey) seg.key = activeKey;
      if (pendingPDT !== undefined) seg.programDateTime = pendingPDT;

      playlist.segments.push(seg);
      playlist.totalDuration += pendingDuration;

      // Reset per-segment carriers
      pendingDuration = undefined;
      pendingTitle = undefined;
      pendingByteRange = undefined;
      pendingDiscontinuity = false;
      pendingPDT = undefined;
      continue;
    }
  }

  return playlist;
}

function readKey(attrs: AttrList, baseUrl: string): SegmentKey {
  const method = attrs.get('METHOD') ?? 'NONE';
  const key: SegmentKey = {
    method: method === 'AES-128' || method === 'SAMPLE-AES' ? method : 'NONE',
  };
  const uri = attrs.get('URI');
  if (uri) key.uri = resolveUrl(uri, baseUrl);
  const iv = attrs.hex('IV');
  if (iv) key.iv = iv;
  const fmt = attrs.get('KEYFORMAT');
  if (fmt) key.keyFormat = fmt;
  const ver = attrs.get('KEYFORMATVERSIONS');
  if (ver) key.keyFormatVersions = ver;
  return key;
}

/** BYTERANGE format: `length[@offset]`. Offset defaults to previous range's end. */
function parseByteRange(
  raw: string,
  previousEnd: number | undefined,
): { length: number; offset: number } | undefined {
  const trimmed = raw.trim();
  const at = trimmed.indexOf('@');
  let lenStr: string;
  let offsetStr: string | undefined;
  if (at === -1) {
    lenStr = trimmed;
  } else {
    lenStr = trimmed.slice(0, at);
    offsetStr = trimmed.slice(at + 1);
  }
  const length = parseInt(lenStr, 10);
  if (!Number.isFinite(length)) return undefined;
  let offset: number;
  if (offsetStr !== undefined) {
    offset = parseInt(offsetStr, 10);
    if (!Number.isFinite(offset)) return undefined;
  } else if (previousEnd !== undefined) {
    offset = previousEnd;
  } else {
    return undefined; // ambiguous offset, can't represent
  }
  return { length, offset };
}

function splitLines(text: string): string[] {
  // HLS allows CR, LF, or CRLF line endings. Trim each line.
  return text.split(/\r\n|\r|\n/).map((l) => l.trim());
}

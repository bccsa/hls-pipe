/*
 * hls-pipe — SubtitleRenditionExtractor tests
 *
 * Covers the live-stream edge cases that aren't exercised by the VOD smoke
 * test: EXT-X-DISCONTINUITY watermark reset, and skip-to-live cursor jump
 * with watermark + cue-buffer flush.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SubtitleRenditionExtractor } from '../src/stream/subtitle-rendition-extractor.js';
import type { WebVttCue } from '../src/parser/webvtt-parser.js';
import type {
  AlternateRendition,
  Loader,
  LoaderRequest,
  LoaderResult,
  Segment,
} from '../src/types.js';

/** Build a UTF-8 byte buffer from a WebVTT-shaped text. */
function vtt(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Tiny loader that returns canned playlist + canned per-segment WebVTT. */
class CannedLoader implements Loader {
  constructor(
    public playlistText: string,
    /** Map from segment URL substring → WebVTT body. */
    public readonly segments: Map<string, Uint8Array>,
  ) {}
  async fetch(req: LoaderRequest): Promise<LoaderResult> {
    let body: Uint8Array | undefined;
    if (req.url.includes('.m3u8')) {
      body = new TextEncoder().encode(this.playlistText);
    } else {
      for (const [key, val] of this.segments) {
        if (req.url.includes(key)) { body = val; break; }
      }
    }
    if (!body) throw new Error(`CannedLoader: no canned body for ${req.url}`);
    return {
      url: req.url,
      status: 200,
      headers: {},
      body,
      stats: { ttfbMs: 1, totalMs: 2, bytes: body.byteLength },
    };
  }
}

const RENDITION: AlternateRendition = {
  type: 'SUBTITLES',
  groupId: 'subs',
  name: 'English',
  language: 'eng',
  isDefault: true,
  autoselect: true,
  forced: false,
  uri: 'https://x/eng.m3u8',
};

describe('SubtitleRenditionExtractor — EXT-X-DISCONTINUITY resets dedup watermark', () => {
  it('post-discontinuity cues with smaller MPEGTS PTS are NOT dropped by the dedup filter', async () => {
    // Two VOD segments, separated by EXT-X-DISCONTINUITY. The second
    // segment's X-TIMESTAMP-MAP restarts MPEGTS at a smaller value — a
    // realistic ad-insertion / encoder-restart shape. Without the reset,
    // the watermark from segment 1 would drop every cue from segment 2.
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:6.0,',
      'seg0.vtt',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:6.0,',
      'seg1.vtt',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const seg0 = vtt(
      [
        'WEBVTT',
        'X-TIMESTAMP-MAP=MPEGTS:9000000,LOCAL:00:00:00.000',
        '',
        '00:00:01.000 --> 00:00:03.000',
        'before discontinuity',
        '',
      ].join('\n'),
    );
    const seg1 = vtt(
      [
        'WEBVTT',
        // Encoder restart — MPEGTS now far smaller.
        'X-TIMESTAMP-MAP=MPEGTS:90000,LOCAL:00:00:00.000',
        '',
        '00:00:01.000 --> 00:00:03.000',
        'after discontinuity',
        '',
      ].join('\n'),
    );
    const loader = new CannedLoader(
      playlist,
      new Map([['seg0.vtt', seg0], ['seg1.vtt', seg1]]),
    );
    const collected: { cue: WebVttCue; seg: Segment }[] = [];
    const ext = new SubtitleRenditionExtractor({
      rendition: RENDITION,
      loader,
      onCues: (cues, seg) => { for (const c of cues) collected.push({ cue: c, seg }); },
    });
    await ext.run();
    assert.equal(collected.length, 2, 'both cues should pass through (no drop)');
    // Segment 0: pts = 9_000_000 + 1s*90000 = 9_090_000
    assert.equal(collected[0]!.cue.pts, 9_090_000);
    // Segment 1: pts = 90_000 + 1s*90000 = 180_000 — strictly smaller than 9_090_000.
    // Without the discontinuity reset, the filter `c.pts > lastEmittedPts`
    // would have dropped this cue. Watermark reset on `segment.discontinuity`
    // lets it through.
    assert.equal(collected[1]!.cue.pts, 180_000);
    assert.equal(collected[1]!.seg.discontinuity, true);
  });

  it('without EXT-X-DISCONTINUITY, watermark still dedupes carryover cues', async () => {
    // Two segments where the second includes the first's cue (HLS carryover
    // behaviour). The dedup should drop the duplicate.
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:6.0,',
      'seg0.vtt',
      '#EXTINF:6.0,',
      'seg1.vtt',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const seg0 = vtt(
      [
        'WEBVTT',
        'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
        '',
        '00:00:01.000 --> 00:00:07.000',
        'long cue spans two segments',
        '',
      ].join('\n'),
    );
    const seg1 = vtt(
      [
        'WEBVTT',
        'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
        '',
        // Carryover of the same cue from seg0
        '00:00:01.000 --> 00:00:07.000',
        'long cue spans two segments',
        '',
        // A genuinely new cue
        '00:00:08.000 --> 00:00:10.000',
        'new cue',
        '',
      ].join('\n'),
    );
    const loader = new CannedLoader(
      playlist,
      new Map([['seg0.vtt', seg0], ['seg1.vtt', seg1]]),
    );
    const collected: WebVttCue[] = [];
    const ext = new SubtitleRenditionExtractor({
      rendition: RENDITION,
      loader,
      onCues: (cues) => { for (const c of cues) collected.push(c); },
    });
    await ext.run();
    assert.equal(collected.length, 2, 'carryover cue should be deduped');
    assert.equal(collected[0]!.pts, 90_000);  // 1s
    assert.equal(collected[1]!.pts, 720_000); // 8s
  });
});

describe('SubtitleRenditionExtractor — skip-to-live', () => {
  it('skipToLiveEdge on a live playlist jumps the cursor (observable via fetched segment URLs)', async () => {
    // Gated loader: playlist fetches return instantly; segment fetches block
    // on a per-URL gate. Lets the test pause the extractor mid-flight,
    // trigger skipToLiveEdge, and observe which segment the extractor goes
    // for next.
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      ...Array.from({ length: 10 }, (_, i) => `#EXTINF:6.0,\nseg${i}.vtt`),
    ].join('\n');
    const cannedSeg = vtt(
      [
        'WEBVTT',
        'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
        '',
        '00:00:01.000 --> 00:00:03.000',
        'cue',
        '',
      ].join('\n'),
    );

    const fetched: string[] = [];
    const gates = new Map<string, () => void>();
    const loader: Loader = {
      async fetch(req: LoaderRequest): Promise<LoaderResult> {
        fetched.push(req.url);
        if (req.url.endsWith('.m3u8')) {
          const body = new TextEncoder().encode(playlist);
          return {
            url: req.url,
            status: 200,
            headers: {},
            body,
            stats: { ttfbMs: 1, totalMs: 2, bytes: body.byteLength },
          };
        }
        // Segment fetch — block until released.
        await new Promise<void>((resolve) => {
          gates.set(req.url, resolve);
        });
        return {
          url: req.url,
          status: 200,
          headers: {},
          body: cannedSeg,
          stats: { ttfbMs: 1, totalMs: 2, bytes: cannedSeg.byteLength },
        };
      },
    };

    const ctl = new AbortController();
    const ext = new SubtitleRenditionExtractor({
      rendition: RENDITION,
      loader,
      signal: ctl.signal,
      onCues: () => undefined,
    });
    const runPromise = ext.run().catch((e) => {
      if (e?.name !== 'AbortError') throw e;
    });

    const segFetches = () => fetched.filter((u) => /seg\d+\.vtt/.test(u));

    // Spin until the extractor has queued its first segment fetch. Initial
    // cursor = lastSeq - liveOffset + 1 = 9 - 6 + 1 = 4 → seg4.vtt.
    for (let tries = 0; tries < 1000 && segFetches().length === 0; tries++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(segFetches().length, 1, 'first segment fetch should be queued');
    assert.match(segFetches()[0]!, /seg4\.vtt/, 'first segment fetch should be seg4.vtt');
    const segFetchesBeforeSkip = segFetches().length;

    // Call skipToLiveEdge(2) → target cursor = 9 - 2 + 1 = 8.
    await ext.skipToLiveEdge(2);

    // Release the in-flight seg4 fetch. The loop will process its cue (under
    // the OLD cursor) but the cursor advance is gated by the seekEpoch
    // bumped inside skipToLiveEdge — so the next iteration picks up at the
    // post-skip cursor (8), not seg 5.
    const seg4Url = fetched.find((u) => u.includes('seg4.vtt'))!;
    const seg4Release = gates.get(seg4Url);
    seg4Release?.();

    // Wait for the NEXT segment fetch (not playlist) to land in `fetched`.
    for (
      let tries = 0;
      tries < 1000 && segFetches().length === segFetchesBeforeSkip;
      tries++
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const allSegFetches = segFetches();
    assert.ok(
      allSegFetches.length > segFetchesBeforeSkip,
      `expected a second segment fetch after skip; segFetches=${JSON.stringify(allSegFetches)}`,
    );
    assert.match(
      allSegFetches[allSegFetches.length - 1]!,
      /seg8\.vtt/,
      `expected post-skip segment fetch to be seg8.vtt; got ${allSegFetches[allSegFetches.length - 1]}; trace=${JSON.stringify(allSegFetches)}`,
    );

    // Cleanup — release every pending gate so the run loop can exit on abort.
    for (const release of gates.values()) release();
    ctl.abort();
    await runPromise;
  });

  it('skipToLiveEdge is a no-op on VOD', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:6.0,',
      'seg0.vtt',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const seg0 = vtt(
      [
        'WEBVTT',
        'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
        '',
        '00:00:01.000 --> 00:00:03.000',
        'only cue',
        '',
      ].join('\n'),
    );
    const loader = new CannedLoader(playlist, new Map([['seg0.vtt', seg0]]));
    const ext = new SubtitleRenditionExtractor({
      rendition: RENDITION,
      loader,
      onCues: () => undefined,
    });
    await ext.run();
    // VOD playlist has endList → isLive=false after run() — skipToLiveEdge
    // is a no-op (no throw, no playlist refresh).
    await ext.skipToLiveEdge(2);
  });
});

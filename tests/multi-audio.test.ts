/*
 * hls-pipe — multi-audio muxer + channel filter tests
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MpegTsMuxer } from '../src/mux/ts/muxer.js';
import { StreamType } from '../src/demux/pat-pmt.js';
import { Demuxer } from '../src/demux/demuxer.js';
import {
  groupHasStereo,
  groupIsAllMono,
  isMonoRendition,
  renditionMaxChannels,
} from '../src/stream/rendition-filters.js';
import type { AlternateRendition } from '../src/types.js';

/** Find the first byte equal to `tableId` inside the payload of the TS packet starting at packetOffset. */
function findTableStart(ts: Uint8Array, packetOffset: number, tableId: number): number {
  // Parse the TS header to find where payload begins (skip adaptation field if present).
  const atf = (ts[packetOffset + 3]! >> 4) & 0x03;
  let cursor = packetOffset + 4;
  if (atf === 2 || atf === 3) {
    const afLen = ts[cursor]!;
    cursor += 1 + afLen;
  }
  if (atf === 2) return -1; // AF only, no payload
  // First payload byte is pointer_field for PSI packets.
  cursor += 1 + ts[cursor]!;
  if (ts[cursor] === tableId) return cursor;
  return -1;
}

function rendition(channels: string | undefined, opts: Partial<AlternateRendition> = {}): AlternateRendition {
  const r: AlternateRendition = {
    type: 'AUDIO',
    groupId: opts.groupId ?? 'g',
    name: opts.name ?? 'r',
    isDefault: opts.isDefault ?? false,
    autoselect: opts.autoselect ?? false,
    forced: opts.forced ?? false,
    uri: opts.uri ?? 'https://x/r.m3u8',
  };
  if (channels !== undefined) r.channels = channels;
  if (opts.language !== undefined) r.language = opts.language;
  return r;
}

describe('renditionMaxChannels', () => {
  it('parses the first CHANNELS parameter as an integer', () => {
    assert.equal(renditionMaxChannels(rendition('1')), 1);
    assert.equal(renditionMaxChannels(rendition('2')), 2);
    assert.equal(renditionMaxChannels(rendition('6')), 6);
  });

  it('ignores trailing CHANNELS parameters (spatial layout etc.)', () => {
    assert.equal(renditionMaxChannels(rendition('2,JOC')), 2);
    assert.equal(renditionMaxChannels(rendition('  6  ,/16')), 6);
  });

  it('returns undefined when CHANNELS is absent', () => {
    assert.equal(renditionMaxChannels(rendition(undefined)), undefined);
  });

  it('returns undefined for malformed CHANNELS', () => {
    assert.equal(renditionMaxChannels(rendition('abc')), undefined);
    assert.equal(renditionMaxChannels(rendition('')), undefined);
  });
});

describe('isMonoRendition / groupIsAllMono / groupHasStereo', () => {
  it('isMonoRendition matches CHANNELS="1" only', () => {
    assert.equal(isMonoRendition(rendition('1')), true);
    assert.equal(isMonoRendition(rendition('2')), false);
    assert.equal(isMonoRendition(rendition(undefined)), false);
  });

  it('groupIsAllMono: every rendition declared CHANNELS=1 → true', () => {
    assert.equal(
      groupIsAllMono([rendition('1'), rendition('1'), rendition('1')]),
      true,
    );
  });

  it('groupIsAllMono: any non-mono → false', () => {
    assert.equal(
      groupIsAllMono([rendition('1'), rendition('2'), rendition('1')]),
      false,
    );
  });

  it('groupIsAllMono: unknown CHANNELS → false (conservative)', () => {
    assert.equal(
      groupIsAllMono([rendition('1'), rendition(undefined)]),
      false,
    );
  });

  it('groupHasStereo: any rendition with CHANNELS≥2 → true', () => {
    assert.equal(groupHasStereo([rendition('1'), rendition('2')]), true);
    assert.equal(groupHasStereo([rendition('6')]), true);
  });

  it('groupHasStereo: all mono → false', () => {
    assert.equal(groupHasStereo([rendition('1'), rendition('1')]), false);
  });

  it('groupHasStereo: only renditions without CHANNELS → false', () => {
    assert.equal(groupHasStereo([rendition(undefined), rendition(undefined)]), false);
  });
});

describe('MpegTsMuxer.muxMulti with 3 audio streams', () => {
  it('PMT announces all 3 audio PIDs', () => {
    const video = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true },
    ];
    const audios = [
      { pid: 0x101, streamType: StreamType.AAC_ADTS, samples: [{ data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 0 }] },
      { pid: 0x102, streamType: StreamType.AAC_ADTS, samples: [{ data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 0 }] },
      { pid: 0x103, streamType: StreamType.AAC_ADTS, samples: [{ data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 0 }] },
    ];
    const ts = new MpegTsMuxer().muxMulti({ video, audios });
    assert.equal(ts[0], 0x47);

    // The PMT section is in packet 1 (the second TS packet, PID 0x1000).
    // Find the section by locating the table_id (0x02) byte inside the
    // packet payload — robust to whether the writer added an adaptation
    // field for stuffing.
    const pmtSectionStart = findTableStart(ts, 188, 0x02);
    assert.ok(pmtSectionStart > 0, 'PMT section not found in packet 1');

    // Parse ES entries (5 bytes each, no descriptors). PMT layout after the
    // section header: see src/mux/ts/pat-pmt.ts.
    // Bytes 0..11 are the PMT header (12 bytes including PCR_PID, program_info_length=0).
    const firstES = pmtSectionStart + 12;
    const pids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const offset = firstES + i * 5;
      const pid = ((ts[offset + 1]! & 0x1f) << 8) | ts[offset + 2]!;
      pids.push(pid);
    }
    assert.equal(pids[0], 0x100, `video PID; got 0x${pids[0]!.toString(16)}`);
    assert.equal(pids[1], 0x101);
    assert.equal(pids[2], 0x102);
    assert.equal(pids[3], 0x103);
  });

  it('audio streams get distinct stream_ids (0xC0, 0xC1, 0xC2 ...)', () => {
    // Each audio PES is one TS packet. We can grep through the output for PES
    // start code 00 00 01 followed by the stream_id byte.
    const audios = [
      { pid: 0x101, streamType: StreamType.AAC_ADTS, samples: [{ data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 0 }] },
      { pid: 0x102, streamType: StreamType.AAC_ADTS, samples: [{ data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 0 }] },
    ];
    const ts = new MpegTsMuxer().muxMulti({ video: [], audios });
    // Find PES start codes after byte 376 (past PAT+PMT)
    const streamIds: number[] = [];
    for (let i = 376; i < ts.byteLength - 3; i++) {
      if (ts[i] === 0 && ts[i + 1] === 0 && ts[i + 2] === 1) {
        streamIds.push(ts[i + 3]!);
      }
    }
    assert.ok(streamIds.includes(0xc0), `expected stream_id 0xC0 in ${streamIds.map((s) => s.toString(16))}`);
    assert.ok(streamIds.includes(0xc1), `expected stream_id 0xC1 in ${streamIds.map((s) => s.toString(16))}`);
  });

  it('muxAv (single-audio convenience) still works', () => {
    const video = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true },
    ];
    const audio = [{ data: new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0, 0, 0xfc]), pts: 0 }];
    const ts = new MpegTsMuxer().muxAv({ video, audio });
    const result = new Demuxer().demux(ts);
    assert.equal(result.streams.videoPid, 0x100);
    assert.equal(result.streams.audioPid, 0x101);
  });
});

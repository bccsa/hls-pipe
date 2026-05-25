/*
 * hls-pipe — subtitle muxer + PMT registration_descriptor tests
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MpegTsMuxer,
  DEFAULT_SUBTITLE_PID_BASE,
  SUBTITLE_FORMAT_ID_WEBVTT,
} from '../src/mux/ts/muxer.js';
import {
  buildPmt,
  buildRegistrationDescriptor,
} from '../src/mux/ts/pat-pmt.js';

const PACKET_SIZE = 188;

/** Find the first byte equal to `tableId` inside the payload of the TS packet starting at packetOffset. */
function findTableStart(ts: Uint8Array, packetOffset: number, tableId: number): number {
  const atf = (ts[packetOffset + 3]! >> 4) & 0x03;
  let cursor = packetOffset + 4;
  if (atf === 2 || atf === 3) {
    const afLen = ts[cursor]!;
    cursor += 1 + afLen;
  }
  if (atf === 2) return -1;
  cursor += 1 + ts[cursor]!;
  if (ts[cursor] === tableId) return cursor;
  return -1;
}

function vttCue(text: string): Uint8Array {
  return new TextEncoder().encode(`00:00:01.000 --> 00:00:03.000\n${text}\n`);
}

describe('buildRegistrationDescriptor', () => {
  it('emits tag 0x05, length 4, and the 4CC bytes', () => {
    const d = buildRegistrationDescriptor('VTT ');
    assert.equal(d.byteLength, 6);
    assert.equal(d[0], 0x05);
    assert.equal(d[1], 0x04);
    assert.equal(d[2], 'V'.charCodeAt(0));
    assert.equal(d[3], 'T'.charCodeAt(0));
    assert.equal(d[4], 'T'.charCodeAt(0));
    assert.equal(d[5], ' '.charCodeAt(0));
  });

  it('rejects non-4-character identifiers', () => {
    assert.throws(() => buildRegistrationDescriptor('VTT'));
    assert.throws(() => buildRegistrationDescriptor('VTT  '));
  });

  it('SUBTITLE_FORMAT_ID_WEBVTT is "VTT "', () => {
    assert.equal(SUBTITLE_FORMAT_ID_WEBVTT, 'VTT ');
  });
});

describe('buildPmt with descriptors[]', () => {
  it('emits the ISO 639 descriptor BEFORE caller descriptors', () => {
    const section = buildPmt(1, [
      {
        streamType: 0x06,
        pid: 0x110,
        language: 'eng',
        descriptors: [buildRegistrationDescriptor('VTT ')],
      },
    ]);
    // Section layout up to the first ES entry:
    //   [0]   table_id = 0x02
    //   [1-2] section_length
    //   [3-4] program_number
    //   [5]   version
    //   [6]   section_number
    //   [7]   last_section_number
    //   [8-9] PCR_PID
    //   [10-11] program_info_length = 0
    //   [12] stream_type
    //   [13-14] ES_PID
    //   [15-16] ES_info_length
    //   [17..] ES_info (descriptors)
    assert.equal(section[12], 0x06, 'stream_type');
    const pid = ((section[13]! & 0x1f) << 8) | section[14]!;
    assert.equal(pid, 0x110, 'subtitle PID');
    const esInfoLen = ((section[15]! & 0x0f) << 8) | section[16]!;
    // ISO 639 descriptor = 6 bytes, registration_descriptor = 6 bytes → 12 total
    assert.equal(esInfoLen, 12);
    // ISO 639 descriptor at offset 17
    assert.equal(section[17], 0x0a, 'iso639 tag');
    assert.equal(section[18], 0x04, 'iso639 length');
    assert.equal(section[19], 'e'.charCodeAt(0));
    assert.equal(section[20], 'n'.charCodeAt(0));
    assert.equal(section[21], 'g'.charCodeAt(0));
    // registration_descriptor at offset 23
    assert.equal(section[23], 0x05, 'registration tag');
    assert.equal(section[24], 0x04, 'registration length');
    assert.equal(section[25], 'V'.charCodeAt(0));
    assert.equal(section[26], 'T'.charCodeAt(0));
    assert.equal(section[27], 'T'.charCodeAt(0));
    assert.equal(section[28], ' '.charCodeAt(0));
  });
});

describe('MpegTsMuxer.muxMulti with subtitle streams', () => {
  it('PMT announces the subtitle PIDs with stream_type 0x06 + VTT registration descriptor', () => {
    const video = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true },
    ];
    const subtitles = [
      {
        pid: DEFAULT_SUBTITLE_PID_BASE,
        language: 'eng',
        samples: [{ data: vttCue('hello'), pts: 90_000 }],
      },
      {
        pid: DEFAULT_SUBTITLE_PID_BASE + 1,
        language: 'fra',
        samples: [{ data: vttCue('bonjour'), pts: 90_000 }],
      },
    ];
    const ts = new MpegTsMuxer().muxMulti({ video, audios: [], subtitles });
    assert.equal(ts[0], 0x47, 'TS sync byte');

    // PMT is in packet 1 (PID 0x1000)
    const pmtStart = findTableStart(ts, PACKET_SIZE, 0x02);
    assert.ok(pmtStart > 0, 'PMT section not found');

    // ES loop starts at pmtStart + 12. Walk and collect entries.
    // Layout per entry: stream_type(8) | reserved+ES_PID(16) | reserved+ES_info_length(16) | ES_info(ES_info_length)
    let cursor = pmtStart + 12;
    // Read section_length so we know where ES loop ends (before 4-byte CRC).
    const sectionLength = ((ts[pmtStart + 1]! & 0x0f) << 8) | ts[pmtStart + 2]!;
    const sectionEnd = pmtStart + 3 + sectionLength;
    const esLoopEnd = sectionEnd - 4;

    const entries: { streamType: number; pid: number; descriptors: Uint8Array }[] = [];
    while (cursor < esLoopEnd) {
      const streamType = ts[cursor]!;
      const pid = ((ts[cursor + 1]! & 0x1f) << 8) | ts[cursor + 2]!;
      const esInfoLen = ((ts[cursor + 3]! & 0x0f) << 8) | ts[cursor + 4]!;
      const descriptors = ts.slice(cursor + 5, cursor + 5 + esInfoLen);
      entries.push({ streamType, pid, descriptors });
      cursor += 5 + esInfoLen;
    }

    // Expect: video (0x100) + 2 subtitles (0x110, 0x111)
    assert.equal(entries.length, 3);
    assert.equal(entries[0]!.streamType, 0x1b, 'video AVC');
    assert.equal(entries[0]!.pid, 0x100);
    assert.equal(entries[1]!.streamType, 0x06, 'subtitle stream_type');
    assert.equal(entries[1]!.pid, 0x110);
    assert.equal(entries[2]!.streamType, 0x06);
    assert.equal(entries[2]!.pid, 0x111);

    // Both subtitle entries should have an ISO 639 descriptor + registration_descriptor.
    for (const entry of entries.slice(1)) {
      const d = entry.descriptors;
      // ISO 639 = 6 bytes (tag 0x0a, len 4, 3-byte lang, audio_type byte)
      // Registration = 6 bytes (tag 0x05, len 4, 4-byte 4CC)
      assert.equal(d.byteLength, 12, `subtitle ES_info should be 12 bytes for PID 0x${entry.pid.toString(16)}`);
      assert.equal(d[0], 0x0a, 'iso639 descriptor first');
      assert.equal(d[6], 0x05, 'registration descriptor second');
      // 4CC bytes
      assert.equal(d[8], 'V'.charCodeAt(0));
      assert.equal(d[9], 'T'.charCodeAt(0));
      assert.equal(d[10], 'T'.charCodeAt(0));
      assert.equal(d[11], ' '.charCodeAt(0));
    }
    // Languages
    assert.equal(entries[1]!.descriptors[2], 'e'.charCodeAt(0));
    assert.equal(entries[1]!.descriptors[3], 'n'.charCodeAt(0));
    assert.equal(entries[1]!.descriptors[4], 'g'.charCodeAt(0));
    assert.equal(entries[2]!.descriptors[2], 'f'.charCodeAt(0));
    assert.equal(entries[2]!.descriptors[3], 'r'.charCodeAt(0));
    assert.equal(entries[2]!.descriptors[4], 'a'.charCodeAt(0));
  });

  it('subtitle PES uses stream_id 0xBD (private_stream_1) and cue payload round-trips', () => {
    const cuePayload = vttCue('test cue');
    const subtitles = [
      {
        pid: DEFAULT_SUBTITLE_PID_BASE,
        language: 'eng',
        samples: [{ data: cuePayload, pts: 90_000 }],
      },
    ];
    const ts = new MpegTsMuxer().muxMulti({ video: [], audios: [], subtitles });

    // Scan for PES start codes after the PSI (which lives in packets 0 + 1).
    // Each PES is one TS packet here (small payload).
    const streamIds: number[] = [];
    let foundCueBytes = false;
    const cueAscii = new TextDecoder().decode(cuePayload);
    for (let i = 2 * PACKET_SIZE; i < ts.byteLength - 3; i++) {
      if (ts[i] === 0 && ts[i + 1] === 0 && ts[i + 2] === 1) {
        streamIds.push(ts[i + 3]!);
      }
    }
    // The cue text must appear in the TS bytestream verbatim
    const tsText = new TextDecoder().decode(ts);
    if (tsText.includes(cueAscii.trim())) foundCueBytes = true;

    assert.ok(
      streamIds.includes(0xbd),
      `expected stream_id 0xBD in ${streamIds.map((s) => '0x' + s.toString(16)).join(',')}`,
    );
    assert.ok(foundCueBytes, 'cue payload bytes should appear verbatim in the TS');
  });

  it('empty subtitle samples produce no PES on that PID', () => {
    const video = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true },
    ];
    const subtitles = [
      { pid: DEFAULT_SUBTITLE_PID_BASE, language: 'eng', samples: [] as { data: Uint8Array; pts: number }[] },
    ];
    const ts = new MpegTsMuxer().muxMulti({ video, audios: [], subtitles });
    // No TS packet should carry PID 0x110.
    let sawSubPid = false;
    for (let off = 0; off < ts.byteLength; off += PACKET_SIZE) {
      const pid = ((ts[off + 1]! & 0x1f) << 8) | ts[off + 2]!;
      if (pid === 0x110) sawSubPid = true;
    }
    assert.equal(sawSubPid, false, 'no subtitle PES expected when samples empty');
  });
});

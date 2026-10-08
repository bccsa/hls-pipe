/*
 * hls-pipe — subtitle carrier seam + cue-to-wire timing tests
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  VTT_PRIVATE_CARRIER,
  cueText,
  drainCues,
  type ActiveCue,
  type SubtitleCarrier,
  type SubtitleCueOut,
} from '../src/stream/subtitle-carrier.js';
import { muxWindow } from '../src/stream/extractor.js';
import type { WebVttCue } from '../src/parser/webvtt-parser.js';

const S = 90_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function cue(startSec: number, endSec: number, text: string, settings = ''): WebVttCue {
  return {
    pts: Math.round(startSec * S),
    durationTicks: Math.round((endSec - startSec) * S),
    payload: enc.encode(`00:00:${startSec.toFixed(3)} --> 00:00:${endSec.toFixed(3)}${settings}\n${text}\n`),
  };
}

interface Call {
  text: string;
  start: number;
  end: number;
  pesPts: number;
}

function recordingCarrier(resendTicks = 0): SubtitleCarrier & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    streamType: 0x06,
    descriptors: [],
    pidBase: 0x180,
    resendTicks,
    calls,
    encode(c: SubtitleCueOut, pesPts: number): Uint8Array {
      calls.push({ text: c.text, start: c.startTicks, end: c.endTicks, pesPts });
      return enc.encode(`${c.text}@${pesPts}`);
    },
  };
}

const win = (startSec: number, endSec: number) => ({ startTicks: startSec * S, endTicks: endSec * S });

describe('cueText', () => {
  it('returns the text lines only, tags stripped and entities decoded', () => {
    const block = enc.encode(
      '00:00:01.000 --> 00:00:03.000 align:start position:10%\n<v Anna><i>Hello</i> &amp; <c.yellow>welcome</c>\nline two &lt;3&gt;&nbsp;\n\n',
    );
    assert.equal(cueText(block), 'Hello & welcome\nline two <3> ');
  });

  it('keeps a cue with no text empty', () => {
    assert.equal(cueText(enc.encode('00:00:01.000 --> 00:00:03.000\n')), '');
  });
});

describe('VTT_PRIVATE_CARRIER', () => {
  it('is the verbatim cue block on 0x06 + "VTT " from 0x110, never re-sent', () => {
    const c = cue(1, 3, 'hi');
    const out = VTT_PRIVATE_CARRIER.encode(
      { startTicks: S, endTicks: 3 * S, text: 'hi', payload: c.payload },
      S,
    );
    assert.equal(dec.decode(out), dec.decode(c.payload));
    assert.equal(VTT_PRIVATE_CARRIER.streamType, 0x06);
    assert.equal(VTT_PRIVATE_CARRIER.pidBase, 0x110);
    assert.equal(VTT_PRIVATE_CARRIER.resendTicks, 0);
    assert.deepEqual([...VTT_PRIVATE_CARRIER.descriptors[0]!], [0x05, 0x04, 0x56, 0x54, 0x54, 0x20]);
  });
});

describe('drainCues', () => {
  it('writes a cue at its start, once, and keeps it active past the window', () => {
    const carrier = recordingCarrier();
    const pending = [cue(1, 4, 'one')];
    const r = drainCues(pending, undefined, win(0, 2), 0, carrier);
    assert.equal(pending.length, 0, 'consumed');
    assert.deepEqual(r.samples.map((s) => s.pts), [1 * S]);
    assert.deepEqual(carrier.calls, [{ text: 'one', start: S, end: 4 * S, pesPts: S }]);
    assert.equal(r.active?.text, 'one');
    assert.equal(r.dropped, 0);
  });

  it('holds a cue whose start lies beyond the window', () => {
    const carrier = recordingCarrier();
    const pending = [cue(5, 7, 'later')];
    const r = drainCues(pending, undefined, win(0, 2), 0, carrier);
    assert.equal(pending.length, 1, 'still buffered');
    assert.equal(r.samples.length, 0);
    assert.equal(r.active, undefined);
  });

  it('writes a past-due cue at the window start with its remaining span', () => {
    const carrier = recordingCarrier();
    const r = drainCues([cue(8, 11, 'late')], undefined, win(10, 12), 0, carrier);
    assert.deepEqual(r.samples.map((s) => s.pts), [10 * S]);
    assert.deepEqual(carrier.calls, [{ text: 'late', start: 8 * S, end: 11 * S, pesPts: 10 * S }]);
  });

  it('drops a cue that ended before the window and counts it', () => {
    const carrier = recordingCarrier();
    const r = drainCues([cue(8, 9, 'gone')], undefined, win(10, 12), 0, carrier);
    assert.equal(r.samples.length, 0);
    assert.equal(r.dropped, 1);
    assert.equal(r.active, undefined);
  });

  it('orders cues by start whatever the buffer order, and applies ptsShift', () => {
    const carrier = recordingCarrier();
    const r = drainCues([cue(3, 4, 'b'), cue(1, 2, 'a')], undefined, win(0, 5), S / 2, carrier);
    assert.deepEqual(r.samples.map((s) => s.pts), [1.5 * S, 3.5 * S]);
    assert.deepEqual(carrier.calls.map((c) => c.text), ['a', 'b']);
  });

  it('re-sends a live cue every resendTicks within the window and across windows', () => {
    const carrier = recordingCarrier(2 * S);
    const r1 = drainCues([cue(0, 7, 'long')], undefined, win(0, 5), 0, carrier);
    assert.deepEqual(r1.samples.map((s) => s.pts), [0, 2 * S, 4 * S]);
    assert.deepEqual(carrier.calls.map((c) => c.pesPts), [0, 2 * S, 4 * S]);
    assert.equal(r1.active?.nextResend, 6 * S);

    const r2 = drainCues([], r1.active, win(5, 10), 0, carrier);
    assert.deepEqual(r2.samples.map((s) => s.pts), [6 * S], 'one more re-send, none past the end');
    assert.equal(r2.active, undefined, 'ended inside this window');
  });

  it('a newer cue ends the previous cue\'s re-sends', () => {
    const carrier = recordingCarrier(2 * S);
    const r = drainCues([cue(0, 10, 'A'), cue(3, 6, 'B')], undefined, win(0, 8), 0, carrier);
    assert.deepEqual(
      carrier.calls.map((c) => `${c.text}@${c.pesPts / S}`),
      ['A@0', 'A@2', 'B@3', 'B@5'],
    );
    assert.deepEqual(r.samples.map((s) => s.pts / S), [0, 2, 3, 5]);
    assert.equal(r.active, undefined);
  });

  it('a re-send never lands before the window start', () => {
    const carrier = recordingCarrier(2 * S);
    const active: ActiveCue = {
      startTicks: 0,
      endTicks: 20 * S,
      text: 'A',
      payload: new Uint8Array(0),
      nextResend: 2 * S,
    };
    const r = drainCues([], active, win(9, 11), 0, carrier);
    assert.deepEqual(r.samples.map((s) => s.pts / S), [9]);
    assert.equal(r.active?.nextResend, 11 * S);
  });
});

describe('muxWindow', () => {
  it('spans the video DTS ladder plus one average frame', () => {
    const w = muxWindow([{ dts: 100 }, { dts: 200 }, { dts: 300 }], []);
    assert.deepEqual(w, { startTicks: 100, endTicks: 400 });
  });

  it('falls back to the audio span without video, and to undefined with nothing', () => {
    const w = muxWindow([], [{ samples: [{ pts: 50 }, { pts: 60 }] }, { samples: [] }]);
    assert.deepEqual(w, { startTicks: 50, endTicks: 70 });
    assert.equal(muxWindow([], [{ samples: [] }]), undefined);
  });
});

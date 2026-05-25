/*
 * hls-pipe — audio rendition selection tests
 *
 * Tests the pure selection logic only. Live fetching is exercised via the
 * smoke-test workflow against real streams (see references memory).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { selectAudioRenditions } from '../src/stream/audio-coordinator.js';
import type { AlternateRendition, MasterPlaylist } from '../src/types.js';

function rendition(opts: {
  language?: string;
  name: string;
  groupId: string;
  isDefault?: boolean;
}): AlternateRendition {
  const r: AlternateRendition = {
    type: 'AUDIO',
    groupId: opts.groupId,
    name: opts.name,
    isDefault: opts.isDefault ?? false,
    autoselect: true,
    forced: false,
    uri: `https://example/audio-${opts.name}.m3u8`,
  };
  if (opts.language) r.language = opts.language;
  return r;
}

const FULL_MASTER: MasterPlaylist = {
  variants: [],
  audio: [
    // BCC-like: three groups (mono/stereo/hq) × five languages
    rendition({ language: 'mul', name: 'Untranslated', groupId: 'audio_mono' }),
    rendition({ language: 'eng', name: 'English', groupId: 'audio_mono', isDefault: true }),
    rendition({ language: 'fra', name: 'Française', groupId: 'audio_mono' }),
    rendition({ language: 'nya', name: 'Chichewa', groupId: 'audio_mono' }),
    rendition({ language: 'swa', name: 'Swahili', groupId: 'audio_mono' }),
    rendition({ language: 'mul', name: 'Untranslated', groupId: 'audio_stereo' }),
    rendition({ language: 'eng', name: 'English', groupId: 'audio_stereo', isDefault: true }),
    rendition({ language: 'fra', name: 'Française', groupId: 'audio_stereo' }),
    rendition({ language: 'nya', name: 'Chichewa', groupId: 'audio_stereo' }),
    rendition({ language: 'swa', name: 'Swahili', groupId: 'audio_stereo' }),
    rendition({ language: 'mul', name: 'Untranslated', groupId: 'audio_hq' }),
    rendition({ language: 'eng', name: 'English', groupId: 'audio_hq', isDefault: true }),
    rendition({ language: 'fra', name: 'Française', groupId: 'audio_hq' }),
    rendition({ language: 'nya', name: 'Chichewa', groupId: 'audio_hq' }),
    rendition({ language: 'swa', name: 'Swahili', groupId: 'audio_hq' }),
  ],
  subtitles: [],
  closedCaptions: [],
  independentSegments: false,
};

describe('selectAudioRenditions', () => {
  it("'all' returns one rendition per language (deduped across groups)", () => {
    const r = selectAudioRenditions(FULL_MASTER, 'all');
    // 5 distinct languages
    assert.equal(r.length, 5);
    const langs = new Set(r.map((x) => x.language));
    assert.deepEqual(langs, new Set(['mul', 'eng', 'fra', 'nya', 'swa']));
  });

  it('all renditions land in a single GROUP-ID', () => {
    const r = selectAudioRenditions(FULL_MASTER, 'all');
    const groups = new Set(r.map((x) => x.groupId));
    assert.equal(groups.size, 1);
  });

  it('respects preferredGroup', () => {
    const r = selectAudioRenditions(FULL_MASTER, 'all', 'audio_hq');
    assert.equal(r.length, 5);
    assert.ok(r.every((x) => x.groupId === 'audio_hq'));
  });

  it('language list filters', () => {
    const r = selectAudioRenditions(FULL_MASTER, ['eng', 'fra']);
    assert.equal(r.length, 2);
    assert.deepEqual(new Set(r.map((x) => x.language)), new Set(['eng', 'fra']));
  });

  it('language list + preferredGroup', () => {
    const r = selectAudioRenditions(FULL_MASTER, ['nor', 'eng'], 'audio_stereo');
    // 'nor' not present — only eng matches
    assert.equal(r.length, 1);
    assert.equal(r[0]!.language, 'eng');
    assert.equal(r[0]!.groupId, 'audio_stereo');
  });

  it('NAME also matches when LANGUAGE is missing', () => {
    const master: MasterPlaylist = {
      ...FULL_MASTER,
      audio: [rendition({ name: 'Norsk', groupId: 'g1' })],
    };
    const r = selectAudioRenditions(master, ['norsk']);
    assert.equal(r.length, 1);
  });

  it('returns empty array when nothing matches', () => {
    const r = selectAudioRenditions(FULL_MASTER, ['nonexistent']);
    assert.equal(r.length, 0);
  });

  it('ignores renditions without URI (e.g., CLOSED-CAPTIONS-style)', () => {
    const noUri: AlternateRendition = {
      type: 'AUDIO',
      groupId: 'g',
      name: 'NoURI',
      language: 'xxx',
      isDefault: false,
      autoselect: false,
      forced: false,
      // uri intentionally omitted
    };
    const master: MasterPlaylist = { ...FULL_MASTER, audio: [noUri] };
    const r = selectAudioRenditions(master, 'all');
    assert.equal(r.length, 0);
  });

  it('prefers DEFAULT rendition when multiple match the same language in a group', () => {
    const master: MasterPlaylist = {
      ...FULL_MASTER,
      audio: [
        rendition({ language: 'eng', name: 'English-Alt', groupId: 'g' }),
        rendition({ language: 'eng', name: 'English-Main', groupId: 'g', isDefault: true }),
      ],
    };
    const r = selectAudioRenditions(master, 'all');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.name, 'English-Main');
  });
});

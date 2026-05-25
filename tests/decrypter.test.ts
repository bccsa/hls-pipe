/*
 * hls-pipe — AES-128 decrypter tests
 *
 * Round-trip an openssl-encrypted version of the phase-4a TS fixture:
 *
 *   openssl aes-128-cbc -e -nosalt -K 000102...0f -iv 00...01 \
 *     -in tests/fixtures/synth-2s.ts -out tests/fixtures/synth-2s.ts.aes
 *
 * Decrypting with the same key + IV must yield bytes identical to the
 * original plaintext.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decryptAes128Cbc,
  deriveIv,
  DecryptError,
  UnsupportedKeyMethodError,
} from '../src/crypt/decrypter.js';
import { KeyCache } from '../src/crypt/key-cache.js';
import type { Loader, LoaderRequest, LoaderResult } from '../src/types.js';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PLAIN = new Uint8Array(readFileSync(join(FIX_DIR, 'synth-2s.ts')));
const CIPHER = new Uint8Array(readFileSync(join(FIX_DIR, 'synth-2s.ts.aes')));
const KEY = new Uint8Array(readFileSync(join(FIX_DIR, 'synth-2s.key')));
const IV = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

describe('decryptAes128Cbc', () => {
  it('round-trips an openssl-encrypted file back to the original plaintext', async () => {
    const result = await decryptAes128Cbc(CIPHER, KEY, IV);
    assert.equal(result.byteLength, PLAIN.byteLength);
    // Compare byte-for-byte
    for (let i = 0; i < PLAIN.byteLength; i++) {
      if (result[i] !== PLAIN[i]) {
        assert.fail(`byte ${i} mismatch: ${result[i]} !== ${PLAIN[i]}`);
      }
    }
  });

  it('produces a valid MPEG-TS sync byte after decryption', async () => {
    const result = await decryptAes128Cbc(CIPHER, KEY, IV);
    assert.equal(result[0], 0x47, 'first byte should be TS sync 0x47');
  });

  it('rejects non-16-byte keys', async () => {
    await assert.rejects(
      decryptAes128Cbc(CIPHER, new Uint8Array(8), IV),
      (e) => e instanceof DecryptError && e.message.includes('key must be 16 bytes'),
    );
  });

  it('rejects non-16-byte IVs', async () => {
    await assert.rejects(
      decryptAes128Cbc(CIPHER, KEY, new Uint8Array(15)),
      (e) => e instanceof DecryptError && e.message.includes('IV must be 16 bytes'),
    );
  });

  it('rejects ciphertext that is not a multiple of 16', async () => {
    await assert.rejects(
      decryptAes128Cbc(CIPHER.subarray(0, 17), KEY, IV),
      (e) => e instanceof DecryptError && e.message.includes('not a positive multiple of 16'),
    );
  });

  it('rejects empty ciphertext', async () => {
    await assert.rejects(decryptAes128Cbc(new Uint8Array(0), KEY, IV), (e) => e instanceof DecryptError);
  });

  it('throws an OperationError on wrong key', async () => {
    const wrongKey = new Uint8Array(16);
    wrongKey.fill(0xff);
    await assert.rejects(decryptAes128Cbc(CIPHER, wrongKey, IV));
  });
});

describe('deriveIv', () => {
  it('produces a 16-byte IV with mediaSequence in the low 8 bytes (big-endian)', () => {
    const iv = deriveIv(1);
    // Bytes 0..7 are zero, bytes 8..14 are zero, byte 15 is 1.
    for (let i = 0; i < 15; i++) assert.equal(iv[i], 0, `byte ${i} should be 0`);
    assert.equal(iv[15], 1);
  });

  it('encodes large (but < 2^53) sequence numbers correctly', () => {
    // 0x123456789abcde = 5,124,095,575,370,462 — within Number.MAX_SAFE_INTEGER.
    // Real mediaSequence values are typically < 2^40 so this is far beyond
    // anything we'd see in the wild.
    const iv = deriveIv(0x123456789abcde);
    assert.equal(iv.byteLength, 16);
    for (let i = 0; i < 8; i++) assert.equal(iv[i], 0);
    assert.equal(iv[8], 0x00);
    assert.equal(iv[9], 0x12);
    assert.equal(iv[10], 0x34);
    assert.equal(iv[11], 0x56);
    assert.equal(iv[12], 0x78);
    assert.equal(iv[13], 0x9a);
    assert.equal(iv[14], 0xbc);
    assert.equal(iv[15], 0xde);
  });
});

describe('UnsupportedKeyMethodError', () => {
  it('flags SAMPLE-AES with a phase-7a hint', () => {
    const err = new UnsupportedKeyMethodError('SAMPLE-AES');
    assert.ok(err.message.includes('SAMPLE-AES'));
    assert.ok(err.message.includes('phase 7a'));
  });
});

// -- KeyCache --------------------------------------------------------------

class MockLoader implements Loader {
  public fetchCalls = 0;
  constructor(private readonly body: Uint8Array) {}
  async fetch(req: LoaderRequest): Promise<LoaderResult> {
    this.fetchCalls++;
    return {
      url: req.url,
      status: 200,
      headers: {},
      body: this.body,
      stats: { ttfbMs: 1, totalMs: 2, bytes: this.body.byteLength },
    };
  }
}

describe('KeyCache', () => {
  it('fetches a 16-byte key on first call and reuses it on subsequent calls', async () => {
    const loader = new MockLoader(KEY);
    const cache = new KeyCache(loader);
    const k1 = await cache.get('https://example/k');
    const k2 = await cache.get('https://example/k');
    assert.equal(loader.fetchCalls, 1, 'should only fetch once');
    assert.equal(k1, k2, 'cached key should be the same reference');
  });

  it('throws when the key URI does not return 16 bytes', async () => {
    const loader = new MockLoader(new Uint8Array(8));
    const cache = new KeyCache(loader);
    await assert.rejects(cache.get('https://example/short-key'));
  });

  it('does not cache failures — retries on next call', async () => {
    const badLoader = new MockLoader(new Uint8Array(8));
    const cache = new KeyCache(badLoader);
    await assert.rejects(cache.get('https://example/k'));
    await assert.rejects(cache.get('https://example/k'));
    assert.equal(badLoader.fetchCalls, 2);
  });

  it('dedupes concurrent fetches', async () => {
    const loader = new MockLoader(KEY);
    const cache = new KeyCache(loader);
    const [a, b, c] = await Promise.all([
      cache.get('https://example/k'),
      cache.get('https://example/k'),
      cache.get('https://example/k'),
    ]);
    assert.equal(loader.fetchCalls, 1);
    assert.equal(a, b);
    assert.equal(b, c);
  });
});

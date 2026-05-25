/*
 * hls-pipe — AES-128 segment decryption
 *
 * Inspired by hls.js src/crypt/decrypter.ts and src/crypt/aes-crypto.ts.
 * Unlike the upstream we do NOT port the pure-JS AES implementation
 * (`aes-decryptor.ts`) — Node's built-in WebCrypto handles AES-CBC with
 * PKCS#7 padding natively, which is both faster and more secure than a JS
 * implementation.
 *
 * Spec references:
 *   - RFC 8216 §4.4.4.4 EXT-X-KEY: METHOD, URI, IV
 *   - RFC 8216 §5.2 IV derivation: if IV is absent in EXT-X-KEY, the IV
 *     is the segment's MEDIA-SEQUENCE encoded as a 16-byte big-endian
 *     integer (8 leading zero bytes + 8 bytes of sequence number).
 *
 * Phase-6 scope: METHOD=AES-128 (full-segment AES-CBC) only. METHOD=SAMPLE-AES
 * requires codec-aware NAL/frame boundary detection that lands in phase 7a.
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

/** Derive the implicit IV from a segment's mediaSequence (RFC 8216 §5.2). */
export function deriveIv(mediaSequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  // 16-byte big-endian: 8 zero bytes + 8-byte mediaSequence.
  view.setBigUint64(8, BigInt(mediaSequence), false);
  return iv;
}

/**
 * Decrypt one AES-128-CBC encrypted segment.
 *
 * `keyBytes` must be exactly 16 bytes (the AES-128 key fetched from the
 * EXT-X-KEY URI). `iv` must be 16 bytes (either from the manifest or derived
 * via deriveIv()).
 *
 * Returns the plaintext bytes. WebCrypto strips PKCS#7 padding automatically.
 */
export async function decryptAes128Cbc(
  ciphertext: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.byteLength !== 16) {
    throw new DecryptError(`AES-128 key must be 16 bytes, got ${keyBytes.byteLength}`);
  }
  if (iv.byteLength !== 16) {
    throw new DecryptError(`AES-CBC IV must be 16 bytes, got ${iv.byteLength}`);
  }
  // Encrypted segments are always a positive multiple of 16 bytes (block size)
  // because PKCS#7 always adds at least 1 byte of padding.
  if (ciphertext.byteLength === 0 || ciphertext.byteLength % 16 !== 0) {
    throw new DecryptError(
      `AES-CBC ciphertext length ${ciphertext.byteLength} is not a positive multiple of 16`,
    );
  }
  const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plaintext = await subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

export class UnsupportedKeyMethodError extends Error {
  constructor(public readonly method: string) {
    super(
      method === 'SAMPLE-AES'
        ? 'SAMPLE-AES encryption is not yet supported — see phase 7a (requires codec-aware NAL/frame parsing)'
        : `unsupported EXT-X-KEY METHOD: ${method}`,
    );
    this.name = 'UnsupportedKeyMethodError';
  }
}

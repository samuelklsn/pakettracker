import { describe, expect, it } from 'vitest';
import { DecryptionError } from '../src/core/errors';
import {
  MIN_KDF_ITERATIONS,
  decryptJson,
  deriveKey,
  encryptJson,
  fromBase64,
  generateSalt,
  toBase64,
  utf8,
} from '../src/services/crypto.service';

// Lower iteration count keeps the test-suite fast; production uses KDF_ITERATIONS (600k).
const IT = MIN_KDF_ITERATIONS;

describe('CryptoService', () => {
  it('round-trips JSON with AES-GCM', async () => {
    const salt = generateSalt();
    const key = await deriveKey('correct horse battery staple', salt, IT);
    const payload = await encryptJson(key, { hello: 'wörld', n: 42 });
    expect(payload.iv.byteLength).toBe(12);
    await expect(decryptJson(key, payload)).resolves.toEqual({ hello: 'wörld', n: 42 });
  });

  it('derives non-extractable keys', async () => {
    const key = await deriveKey('password-123', generateSalt(), IT);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
  });

  it('uses a fresh IV for every encryption', async () => {
    const key = await deriveKey('password-123', generateSalt(), IT);
    const a = await encryptJson(key, 'x');
    const b = await encryptJson(key, 'x');
    expect(toBase64(a.iv)).not.toBe(toBase64(b.iv));
    expect(toBase64(a.ciphertext)).not.toBe(toBase64(b.ciphertext));
  });

  it('fails with DecryptionError on a wrong password', async () => {
    const salt = generateSalt();
    const key = await deriveKey('right-password', salt, IT);
    const wrong = await deriveKey('wrong-password', salt, IT);
    const payload = await encryptJson(key, { secret: true });
    await expect(decryptJson(wrong, payload)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects tampering of ciphertext and AAD', async () => {
    const key = await deriveKey('right-password', generateSalt(), IT);
    const aad = utf8('header-v1');
    const payload = await encryptJson(key, { a: 1 }, aad);
    const tampered = { iv: payload.iv, ciphertext: payload.ciphertext.slice() };
    tampered.ciphertext[0]! ^= 0xff;
    await expect(decryptJson(key, tampered, aad)).rejects.toBeInstanceOf(DecryptionError);
    await expect(decryptJson(key, payload, utf8('header-v2'))).rejects.toBeInstanceOf(DecryptionError);
  });

  it('normalises unicode passwords (NFC)', async () => {
    const salt = generateSalt();
    const composed = await deriveKey('Pässwort-Ünicode', salt, IT);
    const decomposed = await deriveKey('Pässwort-Ünicode'.normalize('NFD'), salt, IT);
    const payload = await encryptJson(composed, 'ok');
    await expect(decryptJson(decomposed, payload)).resolves.toBe('ok');
  });

  it('rejects iteration counts below the security floor', async () => {
    await expect(deriveKey('pw', generateSalt(), 1000)).rejects.toThrow(RangeError);
  });

  it('base64 round-trips binary data', () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(() => fromBase64('not base64!')).toThrow(DecryptionError);
  });
});

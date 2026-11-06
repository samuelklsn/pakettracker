import { CryptoUnavailableError, DecryptionError } from '../core/errors';

/**
 * CryptoService – thin, auditable wrapper around the Web Crypto API.
 *
 *  - Key derivation:  PBKDF2-HMAC-SHA-256, 600 000 iterations (OWASP 2023), 128-bit random salt
 *  - Encryption:      AES-256-GCM, 96-bit random IV per encryption, 128-bit auth tag
 *  - Derived keys are NON-extractable: raw key bytes never become visible to JavaScript.
 *  - Optional additional authenticated data (AAD) binds ciphertext to its envelope header,
 *    so KDF parameters can't be silently swapped (downgrade attacks).
 *
 * The service is stateless; the session key is held by the VaultService.
 */

type Bytes = Uint8Array<ArrayBuffer>;

export const KDF_ITERATIONS = 600_000;
/** Hard floor accepted when reading foreign/imported vaults (requirement: ≥ 100 000). */
export const MIN_KDF_ITERATIONS = 100_000;
/** Ceiling to prevent DoS through manipulated backup files. */
export const MAX_KDF_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new CryptoUnavailableError(
      'Die Web Crypto API ist nicht verfügbar. Bitte die App über HTTPS oder localhost öffnen.',
    );
  }
  return s;
}

export function randomBytes(length: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function generateSalt(): Bytes {
  return randomBytes(SALT_BYTES);
}

/**
 * Derives a non-extractable AES-GCM-256 key from a password.
 * The password is NFC-normalised so identical passwords typed on different
 * platforms/keyboards always produce the same key.
 */
export async function deriveKey(
  password: string,
  salt: Bytes,
  iterations: number = KDF_ITERATIONS,
): Promise<CryptoKey> {
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new RangeError(`PBKDF2-Iterationen außerhalb des erlaubten Bereichs: ${iterations}`);
  }
  if (salt.byteLength < SALT_BYTES) throw new RangeError('Salt zu kurz');

  const s = subtle();
  const baseKey = await s.importKey(
    'raw',
    encoder.encode(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return s.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable
    ['encrypt', 'decrypt'],
  );
}

export interface CipherPayload {
  iv: Bytes;
  ciphertext: Bytes;
}

export async function encrypt(key: CryptoKey, plaintext: Bytes, aad?: Bytes): Promise<CipherPayload> {
  const iv = randomBytes(IV_BYTES);
  const params: AesGcmParams = { name: 'AES-GCM', iv, tagLength: 128 };
  if (aad) params.additionalData = aad;
  const ct = await subtle().encrypt(params, key, plaintext);
  return { iv, ciphertext: new Uint8Array(ct) };
}

/**
 * Decrypts and authenticates. Any failure (wrong key, modified IV/ciphertext/AAD)
 * surfaces as a single `DecryptionError` – no oracle about *why* it failed.
 */
export async function decrypt(key: CryptoKey, payload: CipherPayload, aad?: Bytes): Promise<Bytes> {
  if (payload.iv.byteLength !== IV_BYTES) throw new DecryptionError('Ungültiger IV');
  const params: AesGcmParams = { name: 'AES-GCM', iv: payload.iv, tagLength: 128 };
  if (aad) params.additionalData = aad;
  try {
    const pt = await subtle().decrypt(params, key, payload.ciphertext);
    return new Uint8Array(pt);
  } catch (err) {
    throw new DecryptionError('Entschlüsselung fehlgeschlagen', { cause: err });
  }
}

export async function encryptJson(key: CryptoKey, value: unknown, aad?: Bytes): Promise<CipherPayload> {
  return encrypt(key, encoder.encode(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(key: CryptoKey, payload: CipherPayload, aad?: Bytes): Promise<T> {
  const bytes = await decrypt(key, payload, aad);
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch (err) {
    // Authenticated but not valid JSON → should be impossible unless written by a buggy client.
    throw new DecryptionError('Entschlüsselte Daten sind beschädigt', { cause: err });
  }
}

export function utf8(value: string): Bytes {
  return encoder.encode(value);
}

/* ---------- Base64 helpers (no external deps, no string-length limits) ---------- */

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Bytes {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new DecryptionError('Ungültige Base64-Kodierung');
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


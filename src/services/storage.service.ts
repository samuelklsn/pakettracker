import { InvalidVaultFormatError, StorageUnavailableError } from '../core/errors';
import {
  IV_BYTES,
  MAX_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  SALT_BYTES,
  fromBase64,
  utf8,
} from './crypto.service';

/**
 * StorageService – persistence of the *encrypted* vault envelope.
 *
 * This layer never sees plaintext user data. It only validates and moves
 * opaque envelopes between localStorage and backup files.
 *
 * Integrity strategy:
 *  - Before overwriting, the current envelope is copied to a "last known good" slot.
 *  - Writes only happen after the VaultService verified the new ciphertext decrypts.
 *  - Nothing is written on a failed unlock → a wrong password can never corrupt data.
 */

export const STORAGE_KEY = 'pakettracker.vault.v1';
export const STORAGE_KEY_PREVIOUS = 'pakettracker.vault.v1.previous';
export const BACKUP_FORMAT = 'pakettracker-backup';

export interface KdfParams {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  /** base64 */
  salt: string;
}

export interface VaultEnvelope {
  v: 1;
  kdf: KdfParams;
  cipher: {
    name: 'AES-GCM';
    /** base64, 12 bytes */
    iv: string;
  };
  /** base64 ciphertext incl. GCM auth tag */
  ct: string;
  updatedAt: string;
}

export interface BackupFile extends VaultEnvelope {
  format: typeof BACKUP_FORMAT;
  exportedAt: string;
  app: string;
}

/**
 * The envelope header (everything except IV, ciphertext and timestamps) is
 * authenticated as AES-GCM additional data. Changing e.g. the iteration count
 * makes decryption fail instead of silently weakening the vault.
 */
export function envelopeAad(env: Pick<VaultEnvelope, 'v' | 'kdf'>): Uint8Array<ArrayBuffer> {
  const header = {
    v: env.v,
    kdf: { name: env.kdf.name, hash: env.kdf.hash, iterations: env.kdf.iterations, salt: env.kdf.salt },
    cipher: 'AES-GCM',
  };
  return utf8(`pakettracker:${JSON.stringify(header)}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isBase64(v: unknown, expectedBytes?: number): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  try {
    const bytes = fromBase64(v);
    return expectedBytes === undefined || bytes.byteLength === expectedBytes;
  } catch {
    return false;
  }
}

/** Strict structural validation – rejects anything unexpected before crypto touches it. */
export function parseEnvelope(raw: unknown): VaultEnvelope {
  if (!isRecord(raw)) throw new InvalidVaultFormatError('Kein gültiges Tresor-Objekt');
  const { v, kdf, cipher, ct, updatedAt } = raw;
  if (v !== 1) throw new InvalidVaultFormatError('Nicht unterstützte Tresor-Version');
  if (!isRecord(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new InvalidVaultFormatError('Nicht unterstützte Schlüsselableitung');
  }
  if (
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_KDF_ITERATIONS ||
    kdf.iterations > MAX_KDF_ITERATIONS
  ) {
    throw new InvalidVaultFormatError('Unsichere oder ungültige PBKDF2-Parameter');
  }
  if (!isBase64(kdf.salt, SALT_BYTES)) throw new InvalidVaultFormatError('Ungültiger Salt');
  if (!isRecord(cipher) || cipher.name !== 'AES-GCM' || !isBase64(cipher.iv, IV_BYTES)) {
    throw new InvalidVaultFormatError('Ungültige Verschlüsselungsparameter');
  }
  // 16 bytes = GCM tag only; anything shorter can't be valid
  if (!isBase64(ct) || fromBase64(ct).byteLength < 16) {
    throw new InvalidVaultFormatError('Ungültiger Ciphertext');
  }
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: kdf.salt },
    cipher: { name: 'AES-GCM', iv: cipher.iv },
    ct,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date(0).toISOString(),
  };
}

export class StorageService {
  private readonly storage: Storage;

  constructor(storage: Storage = globalThis.localStorage) {
    this.storage = storage;
  }

  hasVault(): boolean {
    return this.safeGet(STORAGE_KEY) !== null;
  }

  /** Returns the stored envelope, or null if none exists. Throws on corrupt data. */
  load(): VaultEnvelope | null {
    const raw = this.safeGet(STORAGE_KEY);
    if (raw === null) return null;
    return parseEnvelope(this.parseJson(raw));
  }

  loadPrevious(): VaultEnvelope | null {
    const raw = this.safeGet(STORAGE_KEY_PREVIOUS);
    if (raw === null) return null;
    try {
      return parseEnvelope(this.parseJson(raw));
    } catch {
      return null;
    }
  }

  save(envelope: VaultEnvelope): void {
    const serialized = JSON.stringify(parseEnvelope(envelope));
    const current = this.safeGet(STORAGE_KEY);
    try {
      if (current !== null && current !== serialized) this.storage.setItem(STORAGE_KEY_PREVIOUS, current);
      this.storage.setItem(STORAGE_KEY, serialized);
    } catch (err) {
      throw new StorageUnavailableError(
        'Speichern fehlgeschlagen – der lokale Speicher ist voll oder blockiert.',
        { cause: err },
      );
    }
  }

  /** Irreversibly deletes the vault (user-confirmed "factory reset"). */
  destroy(): void {
    this.storage.removeItem(STORAGE_KEY);
    this.storage.removeItem(STORAGE_KEY_PREVIOUS);
  }

  /* ---------------------------- Backup files ---------------------------- */

  createBackup(envelope: VaultEnvelope): BackupFile {
    return {
      format: BACKUP_FORMAT,
      app: 'pakettracker',
      exportedAt: new Date().toISOString(),
      ...envelope,
    };
  }

  /** Parses and validates a backup file's text content. Still encrypted afterwards. */
  parseBackup(text: string): VaultEnvelope {
    if (text.length > 5 * 1024 * 1024) throw new InvalidVaultFormatError('Backup-Datei ist zu groß');
    const raw = this.parseJson(text);
    if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) {
      throw new InvalidVaultFormatError('Keine Pakettracker-Backup-Datei');
    }
    return parseEnvelope(raw);
  }

  /** Subscribe to vault changes made in other browser tabs. */
  onExternalChange(callback: () => void): () => void {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) callback();
    };
    globalThis.addEventListener('storage', handler);
    return () => globalThis.removeEventListener('storage', handler);
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new InvalidVaultFormatError('Die Daten sind kein gültiges JSON', { cause: err });
    }
  }

  private safeGet(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch (err) {
      throw new StorageUnavailableError('Der lokale Speicher ist nicht verfügbar.', { cause: err });
    }
  }
}

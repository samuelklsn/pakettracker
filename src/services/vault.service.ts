import { DecryptionError, InvalidVaultFormatError } from '../core/errors';
import {
  type CarrierId,
  type InboxState,
  type MailSuggestion,
  type Shipment,
  type ShipmentStatus,
  type TrackingEvent,
  type VaultData,
  DEFAULT_SETTINGS,
  createDefaultInbox,
  createEmptyVault,
} from '../core/types';
import {
  KDF_ITERATIONS,
  decryptJson,
  deriveKey,
  encryptJson,
  fromBase64,
  generateSalt,
  toBase64,
} from './crypto.service';
import { type BackupFile, type KdfParams, type VaultEnvelope, StorageService, envelopeAad } from './storage.service';

/**
 * VaultService – owns the unlocked session.
 *
 * The derived CryptoKey lives only in memory (non-extractable) and is dropped on lock().
 * The password itself is never stored – not even in memory beyond key derivation.
 */

export const MIN_PASSWORD_LENGTH = 10;

interface Session {
  key: CryptoKey;
  kdf: KdfParams;
  data: VaultData;
}

export type ImportMode = 'merge' | 'replace';

export class WrongPasswordError extends DecryptionError {
  constructor() {
    super('Falsches Master-Passwort. Deine Daten wurden nicht verändert.');
  }
}

export class VaultService {
  private session: Session | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly storage: StorageService;

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  get isUnlocked(): boolean {
    return this.session !== null;
  }

  get data(): VaultData {
    if (!this.session) throw new Error('Tresor ist gesperrt');
    return this.session.data;
  }

  hasVault(): boolean {
    return this.storage.hasVault();
  }

  async create(password: string): Promise<void> {
    assertPasswordPolicy(password);
    if (this.storage.hasVault()) throw new InvalidVaultFormatError('Es existiert bereits ein Tresor');
    const kdf = newKdfParams();
    const key = await deriveKey(password, fromBase64(kdf.salt), kdf.iterations);
    this.session = { key, kdf, data: createEmptyVault() };
    await this.persist();
  }

  /**
   * Unlocks the vault. On a wrong password nothing is written and the session stays locked.
   */
  async unlock(password: string): Promise<void> {
    const envelope = this.storage.load();
    if (!envelope) throw new InvalidVaultFormatError('Kein Tresor vorhanden');
    const { key, data } = await openEnvelope(envelope, password);
    this.session = { key, kdf: envelope.kdf, data };
  }

  lock(): void {
    this.session = null;
  }

  /** Re-reads the vault (e.g. after another tab saved). Locks if the key no longer fits. */
  async reloadFromStorage(): Promise<'reloaded' | 'locked'> {
    if (!this.session) return 'locked';
    const envelope = this.storage.load();
    if (!envelope || envelope.kdf.salt !== this.session.kdf.salt) {
      this.lock();
      return 'locked';
    }
    try {
      const data = await decryptJson<unknown>(this.session.key, cipherOf(envelope), envelopeAad(envelope));
      this.session.data = sanitizeVaultData(data);
      return 'reloaded';
    } catch {
      this.lock();
      return 'locked';
    }
  }

  /** Applies a mutation to the in-memory data and persists the re-encrypted vault. */
  async update(mutator: (draft: VaultData) => void): Promise<void> {
    if (!this.session) throw new Error('Tresor ist gesperrt');
    const draft = structuredClone(this.session.data);
    mutator(draft);
    const previous = this.session.data;
    this.session.data = sanitizeVaultData(draft);
    try {
      await this.persist();
    } catch (err) {
      // roll back in-memory state so UI and storage never diverge
      if (this.session) this.session.data = previous;
      throw err;
    }
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.session) return false;
    const key = await deriveKey(password, fromBase64(this.session.kdf.salt), this.session.kdf.iterations);
    const envelope = this.storage.load();
    if (!envelope) return false;
    try {
      await decryptJson(key, cipherOf(envelope), envelopeAad(envelope));
      return true;
    } catch {
      return false;
    }
  }

  async changePassword(current: string, next: string): Promise<void> {
    if (!this.session) throw new Error('Tresor ist gesperrt');
    assertPasswordPolicy(next);
    if (!(await this.verifyPassword(current))) throw new WrongPasswordError();
    const kdf = newKdfParams();
    const key = await deriveKey(next, fromBase64(kdf.salt), kdf.iterations);
    const old = this.session;
    this.session = { key, kdf, data: old.data };
    try {
      await this.persist();
    } catch (err) {
      this.session = old;
      throw err;
    }
  }

  exportBackup(): BackupFile {
    const envelope = this.storage.load();
    if (!envelope || !this.session) throw new Error('Kein entsperrter Tresor zum Exportieren');
    return this.storage.createBackup(envelope);
  }

  /**
   * Imports an encrypted backup. The backup is decrypted with ITS password, then
   * re-encrypted with the CURRENT session key → the master password stays unchanged.
   * Returns the number of shipments added/replaced.
   */
  async importBackup(fileText: string, backupPassword: string, mode: ImportMode): Promise<number> {
    const envelope = this.storage.parseBackup(fileText);
    const { data: incoming } = await openEnvelope(envelope, backupPassword);
    let count = 0;
    await this.update((draft) => {
      if (mode === 'replace') {
        draft.shipments = incoming.shipments;
        draft.settings = incoming.settings;
        count = incoming.shipments.length;
        return;
      }
      const known = new Map(draft.shipments.map((s) => [shipmentKey(s), s]));
      for (const s of incoming.shipments) {
        const existing = known.get(shipmentKey(s));
        if (!existing) {
          draft.shipments.push(s);
          count++;
        } else if (s.updatedAt > existing.updatedAt) {
          Object.assign(existing, s, { id: existing.id });
          count++;
        }
      }
    });
    return count;
  }

  /** Factory reset – deletes everything. */
  destroy(): void {
    this.lock();
    this.storage.destroy();
  }

  private async persist(): Promise<void> {
    // serialise writes so rapid edits can't interleave
    const run = this.writeQueue.then(async () => {
      const session = this.session;
      if (!session) return;
      const header = { v: 1 as const, kdf: session.kdf };
      const aad = envelopeAad(header);
      const { iv, ciphertext } = await encryptJson(session.key, session.data, aad);
      const envelope: VaultEnvelope = {
        ...header,
        cipher: { name: 'AES-GCM', iv: toBase64(iv) },
        ct: toBase64(ciphertext),
        updatedAt: new Date().toISOString(),
      };
      // Verify round-trip BEFORE touching storage → never persist something we can't read back.
      await decryptJson(session.key, cipherOf(envelope), aad);
      this.storage.save(envelope);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}

/* ------------------------------------------------------------------------- */

function newKdfParams(): KdfParams {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64(generateSalt()) };
}

function cipherOf(env: VaultEnvelope) {
  return { iv: fromBase64(env.cipher.iv), ciphertext: fromBase64(env.ct) };
}

async function openEnvelope(envelope: VaultEnvelope, password: string): Promise<{ key: CryptoKey; data: VaultData }> {
  const key = await deriveKey(password, fromBase64(envelope.kdf.salt), envelope.kdf.iterations);
  let raw: unknown;
  try {
    raw = await decryptJson<unknown>(key, cipherOf(envelope), envelopeAad(envelope));
  } catch (err) {
    if (err instanceof DecryptionError) throw new WrongPasswordError();
    throw err;
  }
  return { key, data: sanitizeVaultData(raw) };
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidVaultFormatError(`Das Master-Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
  }
}

function shipmentKey(s: Shipment): string {
  return `${s.carrier}:${s.trackingNumber.toUpperCase()}`;
}

/* ------------------------- Defensive schema sanitising ------------------------- */

const CARRIERS: readonly CarrierId[] = ['dhl', 'ups', 'dpd', 'hermes', 'other'];
const STATUSES: readonly ShipmentStatus[] = ['pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'exception'];

const str = (v: unknown, max = 2000): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
const iso = (v: unknown): string => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : new Date().toISOString());
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback;

function sanitizeEvent(raw: unknown): TrackingEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const title = str(e.title, 200);
  if (!title) return null;
  return {
    id: str(e.id, 64) ?? crypto.randomUUID(),
    status: oneOf(e.status, STATUSES, 'in_transit'),
    at: iso(e.at),
    title,
    description: str(e.description, 1000),
    location: str(e.location, 200),
    origin: oneOf(e.origin, ['manual', 'remote', 'system', 'mail'] as const, 'manual'),
  };
}

function sanitizeShipment(raw: unknown): Shipment | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const trackingNumber = str(s.trackingNumber, 120);
  if (!trackingNumber) return null;
  const events = Array.isArray(s.events) ? s.events.map(sanitizeEvent).filter((e): e is TrackingEvent => !!e) : [];
  let remote: Shipment['remote'];
  if (typeof s.remote === 'object' && s.remote !== null) {
    const r = s.remote as Record<string, unknown>;
    remote = {
      fetchedAt: iso(r.fetchedAt),
      status: oneOf(r.status, STATUSES, 'in_transit'),
      events: Array.isArray(r.events) ? r.events.map(sanitizeEvent).filter((e): e is TrackingEvent => !!e) : [],
      estimatedDelivery: str(r.estimatedDelivery, 64),
    };
  }
  return {
    id: str(s.id, 64) ?? crypto.randomUUID(),
    trackingNumber,
    carrier: oneOf(s.carrier, CARRIERS, 'other'),
    label: str(s.label, 120) ?? trackingNumber,
    email: str(s.email, 254),
    sourceUrl: str(s.sourceUrl, 2048),
    notes: str(s.notes, 5000),
    events: events.slice(0, 500),
    remote,
    archived: s.archived === true,
    source: s.source === 'gmail' ? 'gmail' : s.source === 'manual' ? 'manual' : undefined,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

const MAX_PROCESSED_IDS = 2000;
const MAX_DISMISSED = 1000;
const MAX_SUGGESTIONS = 200;

function sanitizeSuggestion(raw: unknown): MailSuggestion | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const trackingNumber = str(s.trackingNumber, 120);
  const messageId = str(s.messageId, 64);
  if (!trackingNumber || !messageId) return null;
  const confidence = Number(s.confidence);
  return {
    id: str(s.id, 64) ?? crypto.randomUUID(),
    trackingNumber,
    carrier: oneOf(s.carrier, CARRIERS, 'other'),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    reason: str(s.reason, 200) ?? '',
    label: str(s.label, 120) ?? trackingNumber,
    email: str(s.email, 254),
    sourceUrl: str(s.sourceUrl, 2048),
    messageId,
    receivedAt: iso(s.receivedAt),
  };
}

const stringList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= maxLen).slice(0, maxItems) : [];

export function sanitizeInbox(raw: unknown): InboxState {
  const base = createDefaultInbox();
  if (typeof raw !== 'object' || raw === null) return base;
  const i = raw as Record<string, unknown>;
  const interval = Number(i.autoScanMinutes);
  return {
    provider: 'gmail',
    enabled: i.enabled === true,
    account: str(i.account, 254),
    autoScanMinutes: Number.isFinite(interval) && interval >= 0 && interval <= 1440 ? Math.round(interval) : base.autoScanMinutes,
    lastScanAt: typeof i.lastScanAt === 'string' && !Number.isNaN(Date.parse(i.lastScanAt)) ? i.lastScanAt : undefined,
    processedIds: stringList(i.processedIds, MAX_PROCESSED_IDS, 64),
    dismissed: stringList(i.dismissed, MAX_DISMISSED, 120),
    suggestions: Array.isArray(i.suggestions)
      ? i.suggestions.map(sanitizeSuggestion).filter((s): s is MailSuggestion => !!s).slice(0, MAX_SUGGESTIONS)
      : [],
  };
}

export function sanitizeVaultData(raw: unknown): VaultData {
  if (typeof raw !== 'object' || raw === null) throw new InvalidVaultFormatError('Tresorinhalt ist ungültig');
  const d = raw as Record<string, unknown>;
  const shipments = Array.isArray(d.shipments)
    ? d.shipments.map(sanitizeShipment).filter((s): s is Shipment => !!s)
    : [];
  const settingsRaw = (typeof d.settings === 'object' && d.settings !== null ? d.settings : {}) as Record<string, unknown>;
  const autoLock = Number(settingsRaw.autoLockMinutes);
  return {
    schema: 1,
    shipments,
    settings: {
      autoLockMinutes:
        Number.isFinite(autoLock) && autoLock >= 0 && autoLock <= 240 ? Math.round(autoLock) : DEFAULT_SETTINGS.autoLockMinutes,
    },
    inbox: sanitizeInbox(d.inbox),
  };
}

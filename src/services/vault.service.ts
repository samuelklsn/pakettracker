import { DecryptionError, InvalidVaultFormatError } from '../core/errors';
import {
  type CarrierId,
  type InboxState,
  type MailSuggestion,
  type Shipment,
  type ShipmentStatus,
  type Tombstone,
  type TrackingEvent,
  type VaultData,
  DEFAULT_SETTINGS,
  MAX_TOMBSTONES,
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
  /** Keys replaced by a password change in this session (salt → key), so the old cloud copy can still be merged */
  previousKeys?: Map<string, CryptoKey>;
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
  private readonly persistListeners = new Set<() => void>();

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

  /** Called after every user-initiated save (not for sync-internal writes). */
  onPersisted(fn: () => void): () => void {
    this.persistListeners.add(fn);
    return () => this.persistListeners.delete(fn);
  }

  /** The currently stored (encrypted) envelope. */
  envelope(): VaultEnvelope | null {
    return this.storage.load();
  }

  /** Installs an envelope from another device on a device that has no vault yet. */
  installEnvelope(envelope: VaultEnvelope): void {
    if (this.storage.hasVault()) throw new InvalidVaultFormatError('Auf diesem Gerät existiert bereits ein Tresor');
    this.storage.save(envelope);
  }

  /**
   * Tries to decrypt a foreign envelope (e.g. from the cloud) with the current session key.
   * Returns null if it was encrypted with a different password/salt.
   */
  async openWithSessionKey(envelope: VaultEnvelope): Promise<{ data: VaultData; currentKey: boolean } | null> {
    const s = this.session;
    if (!s) return null;
    const current = envelope.kdf.salt === s.kdf.salt && envelope.kdf.iterations === s.kdf.iterations;
    const key = current ? s.key : s.previousKeys?.get(envelope.kdf.salt);
    if (!key) return null;
    try {
      const data = sanitizeVaultData(await decryptJson<unknown>(key, cipherOf(envelope), envelopeAad(envelope)));
      return { data, currentKey: current };
    } catch {
      return null;
    }
  }

  /**
   * Merges remote data into the session atomically (no await between read and write, so a
   * concurrent local edit can't be lost) and saves the result without firing persist listeners.
   * Returns true if the local data changed.
   */
  async mergeIn(remote: VaultData, merge: (local: VaultData, remote: VaultData) => VaultData, same: (a: VaultData, b: VaultData) => boolean): Promise<boolean> {
    if (!this.session) throw new Error('Tresor ist gesperrt');
    const merged = sanitizeVaultData(merge(this.session.data, remote));
    if (same(merged, this.session.data)) return false;
    this.session.data = merged;
    await this.persist({ silent: true });
    return true;
  }

  /**
   * Opens a foreign envelope with ITS password, merges it into the local data and switches this
   * device to that envelope's key (used when the password was changed on another device).
   */
  async adoptEnvelope(envelope: VaultEnvelope, password: string, merge: (local: VaultData, remote: VaultData) => VaultData): Promise<void> {
    if (!this.session) throw new Error('Tresor ist gesperrt');
    const { key, data } = await openEnvelope(envelope, password);
    const merged = merge(this.session.data, data);
    const old = this.session;
    this.session = { key, kdf: envelope.kdf, data: sanitizeVaultData(merged) };
    try {
      await this.persist({ silent: true });
    } catch (err) {
      this.session = old;
      throw err;
    }
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
    const before = new Set(draft.shipments.map((s) => s.id));
    mutator(draft);
    // Record deletions as tombstones so they propagate to other devices.
    const after = new Set(draft.shipments.map((s) => s.id));
    const now = new Date().toISOString();
    const removed = [...before].filter((id) => !after.has(id)).map((id) => ({ id, at: now }));
    if (removed.length) draft.deleted = [...removed, ...draft.deleted];
    draft.updatedAt = now;
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
    const previousKeys = new Map(old.previousKeys);
    previousKeys.set(old.kdf.salt, old.key);
    this.session = { key, kdf, data: old.data, previousKeys };
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

  private async persist(opts: { silent?: boolean } = {}): Promise<void> {
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
    if (!opts.silent) {
      void run.then(
        () => this.persistListeners.forEach((fn) => fn()),
        () => undefined,
      );
    }
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

function sanitizeItems(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.slice(0, 160)).slice(0, 20);
  return items.length ? items : undefined;
}

function sanitizeMailRef(v: unknown): Shipment['mail'] {
  if (typeof v !== 'object' || v === null) return undefined;
  const m = v as Record<string, unknown>;
  const messageId = typeof m.messageId === 'string' && /^[0-9a-zA-Z_-]{1,64}$/.test(m.messageId) ? m.messageId : undefined;
  if (!messageId) return undefined;
  return { messageId, subject: str(m.subject, 200), account: str(m.account, 254) };
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
    shop: str(s.shop, 80),
    items: sanitizeItems(s.items),
    orderNumber: str(s.orderNumber, 40),
    mail: sanitizeMailRef(s.mail),
    labelAuto: s.labelAuto === true ? true : undefined,
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
    shop: str(s.shop, 80),
    items: sanitizeItems(s.items),
    orderNumber: str(s.orderNumber, 40),
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
    extractVersion: Number.isInteger(i.extractVersion) ? (i.extractVersion as number) : undefined,
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
    deleted: Array.isArray(d.deleted)
      ? d.deleted
          .filter((t): t is Tombstone => typeof t === 'object' && t !== null && typeof (t as Tombstone).id === 'string' && (t as Tombstone).id.length <= 64)
          .map((t) => ({ id: t.id, at: iso(t.at) }))
          .slice(0, MAX_TOMBSTONES)
      : [],
    // missing timestamp (older vault format) → epoch, so it never wins a settings conflict
    updatedAt: typeof d.updatedAt === 'string' && !Number.isNaN(Date.parse(d.updatedAt)) ? d.updatedAt : new Date(0).toISOString(),
  };
}

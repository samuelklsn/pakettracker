import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shipment, VaultData } from '../src/core/types';
import { createEmptyVault } from '../src/core/types';
import { fingerprint, mergeVaults } from '../src/services/sync-merge';

vi.mock('../src/services/crypto.service', async (orig) => ({
  ...(await orig<typeof import('../src/services/crypto.service')>()),
  KDF_ITERATIONS: 100_000,
}));

const { StorageService } = await import('../src/services/storage.service');
const { VaultService, WrongPasswordError } = await import('../src/services/vault.service');
const { SyncService } = await import('../src/services/sync.service');
type Envelope = import('../src/services/storage.service').VaultEnvelope;

const ship = (id: string, over: Partial<Shipment> = {}): Shipment => ({
  id,
  trackingNumber: `NUM${id}`.toUpperCase(),
  carrier: 'dhl',
  label: `Paket ${id}`,
  events: [],
  archived: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...over,
});
const vault = (over: Partial<VaultData>): VaultData => ({ ...createEmptyVault(), updatedAt: '2026-11-01T10:00:00.000Z', ...over });

describe('mergeVaults', () => {
  it('unions shipments and is commutative + idempotent', () => {
    const a = vault({ shipments: [ship('a')] });
    const b = vault({ shipments: [ship('b')] });
    const ab = mergeVaults(a, b);
    expect(ab.shipments.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(fingerprint(ab)).toBe(fingerprint(mergeVaults(b, a)));
    expect(fingerprint(mergeVaults(ab, ab))).toBe(fingerprint(ab));
  });

  it('newer edits win and timeline events are never lost', () => {
    const e = (id: string, at: string) => ({ id, status: 'in_transit' as const, at, title: id, origin: 'manual' as const });
    const a = vault({ shipments: [ship('x', { label: 'alt', updatedAt: '2026-11-02T00:00:00.000Z', events: [e('e1', '2026-11-02T00:00:00.000Z')] })] });
    const b = vault({ shipments: [ship('x', { label: 'neu', updatedAt: '2026-11-03T00:00:00.000Z', events: [e('e2', '2026-11-03T00:00:00.000Z')] })] });
    const m = mergeVaults(a, b).shipments[0]!;
    expect(m.label).toBe('neu');
    expect(m.events.map((x) => x.id)).toEqual(['e1', 'e2']);
  });

  it('applies deletions via tombstones, but a later edit revives', () => {
    const a = vault({ shipments: [], deleted: [{ id: 'x', at: '2026-11-02T00:00:00.000Z' }] });
    expect(mergeVaults(a, vault({ shipments: [ship('x')] })).shipments).toHaveLength(0);
    const edited = vault({ shipments: [ship('x', { updatedAt: '2026-11-05T00:00:00.000Z' })] });
    expect(mergeVaults(a, edited).shipments).toHaveLength(1);
  });

  it('collapses the same parcel added on two devices', () => {
    const a = vault({ shipments: [ship('a', { trackingNumber: '1Z999AA10123456784', carrier: 'ups', createdAt: '2026-11-01T09:00:00.000Z' })] });
    const b = vault({ shipments: [ship('b', { trackingNumber: '1Z999AA10123456784', carrier: 'ups', createdAt: '2026-11-01T11:00:00.000Z', label: 'Kopfhörer', updatedAt: '2026-11-02T00:00:00.000Z' })] });
    const m = mergeVaults(a, b);
    expect(m.shipments).toHaveLength(1);
    expect(m.shipments[0]).toMatchObject({ id: 'a', label: 'Kopfhörer' });
    expect(fingerprint(m)).toBe(fingerprint(mergeVaults(b, a)));
  });

  it('merges inbox state and drops suggestions that were accepted or dismissed elsewhere', () => {
    const sug = (n: string) => ({ id: n, trackingNumber: n, carrier: 'dpd' as const, confidence: 0.6, reason: '', label: n, messageId: 'm', receivedAt: '2026-11-01T00:00:00.000Z' });
    const a = vault({ inbox: { ...createEmptyVault().inbox, processedIds: ['m1'], suggestions: [sug('S1'), sug('S2')] } });
    const b = vault({
      updatedAt: '2026-11-04T00:00:00.000Z',
      shipments: [ship('k', { trackingNumber: 'S1' })],
      inbox: { ...createEmptyVault().inbox, processedIds: ['m2'], dismissed: ['S2'], autoScanMinutes: 30 },
    });
    const m = mergeVaults(a, b);
    expect(m.inbox.processedIds.sort()).toEqual(['m1', 'm2']);
    expect(m.inbox.suggestions).toEqual([]);
    expect(m.inbox.autoScanMinutes).toBe(30);
  });
});

/* ------------------------- two devices, one "cloud" ------------------------- */

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

class FakeDrive {
  stored: Envelope | null = null;
  uploads = 0;
  get configured() { return true; }
  get hasValidToken() { return true; }
  async connect() {}
  async download() { return this.stored ? { fileId: 'f1', envelope: structuredClone(this.stored) } : null; }
  async upload(env: Envelope) { this.uploads++; this.stored = structuredClone(env); }
  async deleteRemote() { this.stored = null; }
}

const PW = 'test-master-passwort';
const device = () => new VaultService(new StorageService(new MemoryStorage() as Storage));
const add = (v: InstanceType<typeof VaultService>, n: string) =>
  v.update((d) => d.shipments.unshift(ship(crypto.randomUUID(), { trackingNumber: n, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() })));
const numbers = (v: InstanceType<typeof VaultService>) => v.data.shipments.map((s) => s.trackingNumber).sort();

describe('SyncService (two devices)', () => {
  let drive: FakeDrive;
  let phone: InstanceType<typeof VaultService>;
  let laptop: InstanceType<typeof VaultService>;

  beforeEach(async () => {
    drive = new FakeDrive();
    phone = device();
    await phone.create(PW);
    await add(phone, '111111111111');
    expect((await new SyncService(phone, drive as never).sync()).outcome).toBe('uploaded');

    // new device: install the cloud envelope, unlock with the same password
    laptop = device();
    laptop.installEnvelope(drive.stored!);
    await laptop.unlock(PW);
  });

  it('brings a new device to the same state', () => {
    expect(numbers(laptop)).toEqual(['111111111111']);
  });

  it('propagates additions and deletions both ways', async () => {
    const phoneSync = new SyncService(phone, drive as never);
    const laptopSync = new SyncService(laptop, drive as never);

    await add(laptop, '222222222222');
    expect((await laptopSync.sync()).outcome).toBe('uploaded');
    await add(phone, '333333333333');
    expect((await phoneSync.sync()).outcome).toBe('merged');
    expect(numbers(phone)).toEqual(['111111111111', '222222222222', '333333333333']);

    await phone.update((d) => (d.shipments = d.shipments.filter((s) => s.trackingNumber !== '111111111111')));
    await phoneSync.sync();
    expect((await laptopSync.sync()).outcome).toBe('downloaded');
    expect(numbers(laptop)).toEqual(['222222222222', '333333333333']);

    // nothing left to do
    const uploads = drive.uploads;
    expect((await laptopSync.sync()).outcome).toBe('unchanged');
    expect((await phoneSync.sync()).outcome).toBe('unchanged');
    expect(drive.uploads).toBe(uploads);
  });

  it('cloud only ever contains ciphertext', () => {
    expect(JSON.stringify(drive.stored)).not.toContain('111111111111');
  });

  it('asks for the new password after a password change on another device', async () => {
    await phone.changePassword(PW, 'ganz-neues-passwort');
    await add(phone, '444444444444');
    expect((await new SyncService(phone, drive as never).sync()).outcome).toBe('uploaded');

    const laptopSync = new SyncService(laptop, drive as never);
    await add(laptop, '555555555555');
    const r = await laptopSync.sync();
    expect(r.outcome).toBe('needs-password');
    await expect(laptopSync.adoptRemote(r.remote!, 'falsch-falsch')).rejects.toBeInstanceOf(WrongPasswordError);
    await laptopSync.adoptRemote(r.remote!, 'ganz-neues-passwort');
    expect(numbers(laptop)).toEqual(['111111111111', '444444444444', '555555555555']);

    // laptop now uses the new password and both are in sync
    laptop.lock();
    await laptop.unlock('ganz-neues-passwort');
    expect((await new SyncService(phone, drive as never).sync()).outcome).toBe('downloaded');
    expect(numbers(phone)).toEqual(numbers(laptop));
  });
});

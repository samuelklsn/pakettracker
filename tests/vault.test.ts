import { beforeEach, describe, expect, it, vi } from 'vitest';

// Speed up PBKDF2 in tests – the production constant stays at 600k.
vi.mock('../src/services/crypto.service', async (orig) => ({
  ...(await orig<typeof import('../src/services/crypto.service')>()),
  KDF_ITERATIONS: 100_000,
}));

const { StorageService, STORAGE_KEY } = await import('../src/services/storage.service');
const { VaultService, WrongPasswordError } = await import('../src/services/vault.service');
const { InvalidVaultFormatError } = await import('../src/core/errors');

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const PW = 'super-secret-master-pw';

function shipment(n: string) {
  const now = new Date().toISOString();
  return { id: n, trackingNumber: n, carrier: 'dhl' as const, label: `Paket ${n}`, events: [], archived: false, createdAt: now, updatedAt: now };
}

describe('VaultService', () => {
  let mem: MemoryStorage;
  let storage: InstanceType<typeof StorageService>;
  let vault: InstanceType<typeof VaultService>;

  beforeEach(() => {
    mem = new MemoryStorage();
    storage = new StorageService(mem);
    vault = new VaultService(storage);
  });

  it('stores only ciphertext', async () => {
    await vault.create(PW);
    await vault.update((d) => d.shipments.push({ ...shipment('00340434161234567890'), notes: 'Geheime Notiz', email: 'me@example.com' }));
    const raw = mem.getItem(STORAGE_KEY)!;
    expect(raw).not.toContain('00340434161234567890');
    expect(raw).not.toContain('Geheime');
    expect(raw).not.toContain('example.com');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256' }, cipher: { name: 'AES-GCM' } });
  });

  it('unlocks with the right password and keeps data', async () => {
    await vault.create(PW);
    await vault.update((d) => d.shipments.push(shipment('123456789012')));
    vault.lock();
    expect(vault.isUnlocked).toBe(false);
    await vault.unlock(PW);
    expect(vault.data.shipments).toHaveLength(1);
  });

  it('rejects a wrong password without modifying stored data', async () => {
    await vault.create(PW);
    await vault.update((d) => d.shipments.push(shipment('123456789012')));
    vault.lock();
    const before = mem.getItem(STORAGE_KEY);
    await expect(vault.unlock('wrong-password-123')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(vault.isUnlocked).toBe(false);
    expect(mem.getItem(STORAGE_KEY)).toBe(before);
    await vault.unlock(PW);
    expect(vault.data.shipments).toHaveLength(1);
  });

  it('refuses tampered KDF parameters (AAD binding)', async () => {
    await vault.create(PW);
    vault.lock();
    const env = JSON.parse(mem.getItem(STORAGE_KEY)!);
    env.kdf.iterations = 100_001;
    mem.setItem(STORAGE_KEY, JSON.stringify(env));
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects malformed envelopes and downgraded iteration counts', () => {
    mem.setItem(STORAGE_KEY, '{"v":1}');
    expect(() => storage.load()).toThrow(InvalidVaultFormatError);
    mem.setItem(STORAGE_KEY, 'not json');
    expect(() => storage.load()).toThrow(InvalidVaultFormatError);
  });

  it('exports and imports encrypted backups (re-encrypted with the current key)', async () => {
    await vault.create(PW);
    await vault.update((d) => d.shipments.push(shipment('111111111111')));
    const backup = JSON.stringify(vault.exportBackup());
    expect(backup).not.toContain('111111111111');

    const other = new VaultService(new StorageService(new MemoryStorage()));
    await other.create('another-password-456');
    await other.update((d) => d.shipments.push(shipment('222222222222')));

    await expect(other.importBackup(backup, 'wrong-password-xyz', 'merge')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(other.data.shipments).toHaveLength(1);

    const added = await other.importBackup(backup, PW, 'merge');
    expect(added).toBe(1);
    expect(other.data.shipments.map((s) => s.trackingNumber).sort()).toEqual(['111111111111', '222222222222']);

    // master password unchanged
    other.lock();
    await expect(other.unlock(PW)).rejects.toBeInstanceOf(WrongPasswordError);
    await other.unlock('another-password-456');
    expect(other.data.shipments).toHaveLength(2);
  });

  it('changes the master password with a new salt', async () => {
    await vault.create(PW);
    const saltBefore = JSON.parse(mem.getItem(STORAGE_KEY)!).kdf.salt;
    await expect(vault.changePassword('wrong-password-1', 'new-password-123')).rejects.toBeInstanceOf(WrongPasswordError);
    await vault.changePassword(PW, 'new-password-123');
    expect(JSON.parse(mem.getItem(STORAGE_KEY)!).kdf.salt).not.toBe(saltBefore);
    vault.lock();
    await expect(vault.unlock(PW)).rejects.toBeInstanceOf(WrongPasswordError);
    await vault.unlock('new-password-123');
  });

  it('enforces the password policy', async () => {
    await expect(vault.create('short')).rejects.toBeInstanceOf(InvalidVaultFormatError);
  });
});

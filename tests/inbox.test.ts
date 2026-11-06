import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '../src/services/mail-extract.service';

vi.mock('../src/services/crypto.service', async (orig) => ({
  ...(await orig<typeof import('../src/services/crypto.service')>()),
  KDF_ITERATIONS: 100_000,
}));

const { StorageService } = await import('../src/services/storage.service');
const { VaultService } = await import('../src/services/vault.service');
const { scanInbox, acceptSuggestion, dismissSuggestion, resetScanHistory } = await import('../src/services/inbox.service');
const { deriveStatus } = await import('../src/services/tracking.service');

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

function fakeSource(mails: MailMessage[], failing: string[] = []) {
  return {
    queries: [] as string[],
    async listMessageIds(q: string) {
      this.queries.push(q);
      return mails.map((m) => m.id).concat(failing);
    },
    async getMessage(id: string) {
      const m = mails.find((x) => x.id === id);
      if (!m) throw new Error('boom');
      return m;
    },
  };
}

const m = (id: string, over: Partial<MailMessage>): MailMessage => ({
  id, from: 'Shop <info@shop.example>', subject: '', date: '2026-11-05T10:00:00.000Z', text: '', links: [], ...over,
});

describe('InboxService', () => {
  let vault: InstanceType<typeof VaultService>;
  beforeEach(async () => {
    vault = new VaultService(new StorageService(new MemoryStorage() as Storage));
    await vault.create('super-secret-master-pw');
  });

  it('auto-adds safe hits, suggests uncertain ones and is idempotent', async () => {
    const source = fakeSource([
      m('a', { subject: 'Ihre Bestellung wurde versandt', text: 'UPS Tracking: 1Z999AA10123456784' }),
      m('b', { subject: 'Versandbestätigung', text: 'Sendungsnummer 01234567890123' }),
      m('c', { subject: 'Newsletter', text: 'Rabatt 123456789012' }),
    ]);
    const r1 = await scanInbox(vault, source);
    expect(r1).toMatchObject({ scanned: 3, suggested: 1, failed: 0 });
    expect(r1.added.map((s) => s.trackingNumber)).toEqual(['1Z999AA10123456784']);
    const added = vault.data.shipments[0]!;
    expect(added).toMatchObject({ source: 'gmail', label: 'Bestellung bei Shop', shop: 'Shop', email: 'info@shop.example', labelAuto: true });
    expect(added.mail?.messageId).toBe('a');
    expect(deriveStatus(added)).toBe('in_transit');
    expect(vault.data.inbox.suggestions).toHaveLength(1);
    expect(vault.data.inbox.processedIds.sort()).toEqual(['a', 'b', 'c']);
    expect(vault.data.inbox.lastScanAt).toBeTruthy();

    const r2 = await scanInbox(vault, source);
    expect(r2).toMatchObject({ scanned: 0, suggested: 0 });
    expect(r2.added).toHaveLength(0);
    expect(source.queries[1]).toMatch(/after:\d+/);
  });

  it('adds timeline events to existing shipments from later mails', async () => {
    await scanInbox(vault, fakeSource([m('a', { subject: 'Versandt', text: 'Tracking 1Z999AA10123456784' })]));
    await scanInbox(vault, fakeSource([
      m('d', { subject: 'Ihr UPS Paket wird heute zugestellt', date: '2026-11-06T08:00:00.000Z', text: '1Z999AA10123456784' }),
    ]));
    const s = vault.data.shipments[0]!;
    expect(s.events).toHaveLength(2);
    expect(deriveStatus(s)).toBe('out_for_delivery');
  });

  it('retries mails that failed to load', async () => {
    const r = await scanInbox(vault, fakeSource([m('a', { text: '1Z999AA10123456784' })], ['broken']));
    expect(r.failed).toBe(1);
    expect(vault.data.inbox.processedIds).toEqual(['a']);
    expect(vault.data.inbox.lastScanAt).toBeUndefined();
  });

  it('accepts and dismisses suggestions; dismissed numbers never come back', async () => {
    const source = fakeSource([
      m('b', { text: 'Sendungsnummer 01234567890123' }),
      m('e', { text: 'Sendungsnummer 09876543210987' }),
    ]);
    await scanInbox(vault, source);
    const [first, second] = vault.data.inbox.suggestions;
    const created = await acceptSuggestion(vault, first!.id);
    expect(created?.trackingNumber).toBe(first!.trackingNumber);
    await dismissSuggestion(vault, second!.id);
    expect(vault.data.inbox.suggestions).toHaveLength(0);
    expect(vault.data.inbox.dismissed).toEqual([second!.trackingNumber]);

    // same number in a new mail → not suggested again
    await scanInbox(vault, fakeSource([m('f', { text: `Sendungsnummer ${second!.trackingNumber}` })]));
    expect(vault.data.inbox.suggestions).toHaveLength(0);
  });

  it('reports already-processed mails and brings deleted parcels back after a reset', async () => {
    const source = fakeSource([m('a', { subject: 'Versandt', text: 'Tracking 1Z999AA10123456784' })]);
    await scanInbox(vault, source);
    await vault.update((d) => (d.shipments = []));

    // first scan after deleting: mail found, but already processed → nothing comes back
    const before = await scanInbox(vault, { ...source, listMessageIds: async () => ['a'] });
    expect(before).toMatchObject({ found: 1, skipped: 1, scanned: 0 });
    expect(vault.data.shipments).toHaveLength(0);

    await resetScanHistory(vault);
    const after = await scanInbox(vault, source);
    expect(after).toMatchObject({ found: 1, skipped: 0, scanned: 1 });
    expect(vault.data.shipments.map((s) => s.trackingNumber)).toEqual(['1Z999AA10123456784']);
  });

  it('keeps inbox state encrypted across lock/unlock', async () => {
    await scanInbox(vault, fakeSource([m('b', { text: 'Sendungsnummer 01234567890123' })]));
    vault.lock();
    await vault.unlock('super-secret-master-pw');
    expect(vault.data.inbox.suggestions).toHaveLength(1);
    expect(vault.data.inbox.processedIds).toEqual(['b']);
  });
});

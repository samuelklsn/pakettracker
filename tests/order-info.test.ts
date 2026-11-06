import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MailMessage, extractOrderInfo, gmailLink, htmlToText, shipmentLabel } from '../src/services/mail-extract.service';

const mail = (over: Partial<MailMessage>): MailMessage => ({
  id: 'm1', from: '', subject: '', date: '2026-11-05T10:00:00.000Z', text: '', links: [], ...over,
});

describe('extractOrderInfo', () => {
  it('reads shop, items and order number from a shop shipping mail (HTML table)', () => {
    const html = `<p>Hallo Max,</p><p>deine Bestellung 302-1234567-7654321 wurde versandt.</p>
      <table><tr><td>Sony WH-1000XM6 Kopfhörer, schwarz</td><td>Menge: 1</td><td>349,99 €</td></tr>
      <tr><td>USB-C Ladekabel 2 m</td><td>Menge: 2</td><td>12,98 €</td></tr>
      <tr><td>Zwischensumme</td><td>362,97 €</td></tr><tr><td>Versand</td><td>0,00 €</td></tr></table>`;
    const info = extractOrderInfo(mail({ from: '"Amazon.de" <versandbestaetigung@amazon.de>', subject: 'Versandbestätigung', text: htmlToText(html) }));
    expect(info.shop).toBe('Amazon.de');
    expect(info.orderNumber).toBe('302-1234567-7654321');
    expect(info.items).toEqual(['Sony WH-1000XM6 Kopfhörer, schwarz', 'USB-C Ladekabel 2 m']);
    expect(shipmentLabel(info, 'Versandbestätigung', 'dhl')).toBe('Sony WH-1000XM6 Kopfhörer, schwarz (+1)');
  });

  it('understands "1 x Artikel" lists and cleans sender names', () => {
    const info = extractOrderInfo(
      mail({ from: 'Zalando Kundenservice <info@service-mail.zalando.de>', text: 'Deine Artikel:\n1 x Nike Air Max 90 – Größe 43\n1 x Levi’s 501 Jeans\nBestellnummer: 10203040506' }),
    );
    expect(info.shop).toBe('Zalando');
    expect(info.items).toEqual(['Nike Air Max 90 – Größe 43', 'Levi’s 501 Jeans']);
    expect(info.orderNumber).toBe('10203040506');
  });

  it('finds the shop inside a carrier notification', () => {
    const info = extractOrderInfo(mail({ from: 'DHL Paket <noreply@dhl.de>', subject: 'Ihr Paket von OTTO kommt heute', text: 'Sendungsnummer 00340434161234567890' }));
    expect(info.shop).toBe('OTTO');
    expect(info.items).toEqual([]);
    expect(shipmentLabel(info, 'Ihr Paket von OTTO kommt heute', 'dhl')).toBe('Bestellung bei OTTO');
  });

  it('never treats the carrier itself, greetings or totals as shop / item', () => {
    const info = extractOrderInfo(mail({ from: 'UPS <pkginfo@ups.com>', text: 'Hallo Max\nGesamtsumme 49,99 €\nVielen Dank für Ihren Einkauf' }));
    expect(info.shop).toBeUndefined();
    expect(info.items).toEqual([]);
  });

  it('falls back to the sender domain', () => {
    expect(extractOrderInfo(mail({ from: 'noreply@kleiner-laden.de' })).shop).toBe('Kleiner-laden');
    expect(extractOrderInfo(mail({ from: 'max@gmail.com' })).shop).toBeUndefined();
  });

  it('builds a Gmail deep link for the right account', () => {
    expect(gmailLink('18c2f0a1b2c3d4e5', 'max@gmail.com')).toBe('https://mail.google.com/mail/?authuser=max%40gmail.com#all/18c2f0a1b2c3d4e5');
  });
});

/* ---------------- enrichment of shipments created by an older version ---------------- */

vi.mock('../src/services/crypto.service', async (orig) => ({
  ...(await orig<typeof import('../src/services/crypto.service')>()),
  KDF_ITERATIONS: 100_000,
}));
const { StorageService } = await import('../src/services/storage.service');
const { VaultService } = await import('../src/services/vault.service');
const { scanInbox } = await import('../src/services/inbox.service');

class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe('one-time enrichment of existing shipments', () => {
  let vault: InstanceType<typeof VaultService>;
  const amazonMail = mail({
    id: 'amz1',
    from: '"Amazon.de" <versandbestaetigung@amazon.de>',
    subject: 'Ihre Sendung ist unterwegs',
    text: 'Bestellung 302-1234567-7654321\nSony Kopfhörer\nMenge: 1\nTracking: 1Z999AA10123456784',
  });
  const source = { calls: 0, async listMessageIds() { this.calls++; return ['amz1']; }, async getMessage() { return amazonMail; } };

  beforeEach(async () => {
    vault = new VaultService(new StorageService(new MemoryStorage() as Storage));
    await vault.create('test-master-passwort');
    // state as left by the previous app version: label = subject, mail already processed
    await vault.update((d) => {
      d.shipments.push({
        id: 'old', trackingNumber: '1Z999AA10123456784', carrier: 'ups', label: 'Ihre Sendung ist unterwegs', events: [],
        archived: false, source: 'gmail', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z',
      });
      d.inbox.processedIds = ['amz1'];
      d.inbox.lastScanAt = new Date().toISOString();
    });
  });

  it('re-reads processed mails once and fills in shop, items and a better label', async () => {
    const r = await scanInbox(vault, source);
    expect(r.added).toHaveLength(0);
    expect(r.updated).toBe(1);
    expect(vault.data.shipments).toHaveLength(1);
    expect(vault.data.shipments[0]).toMatchObject({
      label: 'Sony Kopfhörer', shop: 'Amazon.de', items: ['Sony Kopfhörer'], orderNumber: '302-1234567-7654321', mail: { messageId: 'amz1' },
    });
    // second run: nothing to do anymore
    const again = await scanInbox(vault, source);
    expect(again.scanned).toBe(0);
  });

  it('keeps a name the user chose', async () => {
    await vault.update((d) => {
      d.shipments[0]!.label = 'Geschenk für Mama';
      d.shipments[0]!.labelAuto = false;
    });
    await scanInbox(vault, source);
    expect(vault.data.shipments[0]).toMatchObject({ label: 'Geschenk für Mama', shop: 'Amazon.de' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  type MailMessage,
  buildGmailQuery,
  extractFromMail,
  extractLinks,
  htmlToText,
  inferStatus,
  labelFromSubject,
  senderAddress,
  senderCarrier,
} from '../src/services/mail-extract.service';
import { parseGmailMessage } from '../src/services/gmail.service';

const mail = (over: Partial<MailMessage>): MailMessage => ({
  id: 'm1',
  from: 'Shop <info@shop.example>',
  subject: '',
  date: '2026-11-05T10:00:00.000Z',
  text: '',
  links: [],
  ...over,
});

describe('mail extraction', () => {
  it('parses sender address and carrier', () => {
    expect(senderAddress('DHL Paket <NoReply@dhl.de>')).toBe('noreply@dhl.de');
    expect(senderCarrier('DHL Paket <noreply@dhl.de>')).toBe('dhl');
    expect(senderCarrier('"UPS" <pkginfo@ups.com>')).toBe('ups');
    expect(senderCarrier('fake <x@dhl.de.evil.example>')).toBeNull();
  });

  it('auto-adds tracking numbers from carrier links', () => {
    const r = extractFromMail(
      mail({ links: ['https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161234567890'] }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ trackingNumber: '00340434161234567890', carrier: 'dhl', auto: true });
  });

  it('ignores generic shop links with id parameters', () => {
    expect(extractFromMail(mail({ links: ['https://shop.example/order?id=123456789012'] }))).toEqual([]);
  });

  it('auto-adds distinctive formats with valid checksum', () => {
    const r = extractFromMail(mail({ text: 'Ihr Paket ist unterwegs: 1Z999AA10123456784' }));
    expect(r[0]).toMatchObject({ trackingNumber: '1Z999AA10123456784', carrier: 'ups', auto: true });
  });

  it('recognises grouped digits next to a keyword in a carrier mail', () => {
    const r = extractFromMail(
      mail({ from: 'DHL <noreply@dhl.de>', subject: 'Ihre Sendung kommt', text: 'Sendungsnummer: 0034 0434 1612 3456 7890' }),
    );
    expect(r[0]).toMatchObject({ trackingNumber: '00340434161234567890', carrier: 'dhl', auto: true });
  });

  it('only suggests ambiguous numbers with weaker context', () => {
    const r = extractFromMail(mail({ text: 'Deine Sendungsnummer lautet 01234567890123' }));
    expect(r[0]).toMatchObject({ trackingNumber: '01234567890123', auto: false });
  });

  it('prefers the sender carrier for ambiguous formats', () => {
    const r = extractFromMail(mail({ from: 'Hermes <noreply@myhermes.de>', text: 'Sendungsnummer 01234567890123' }));
    expect(r[0]).toMatchObject({ carrier: 'hermes', auto: true });
  });

  it('drops order, customer and phone numbers', () => {
    const text = 'Bestellnummer: 123456789012\nKundennummer 9876543210\nTelefon: 0800123456789\nIBAN DE00 1234 5678 9012 3456 78';
    expect(extractFromMail(mail({ text }))).toEqual([]);
  });

  it('drops plain numbers without any context', () => {
    expect(extractFromMail(mail({ text: 'Vielen Dank 123456789012 für Ihren Einkauf' }))).toEqual([]);
  });

  it('converts HTML to text and extracts links', () => {
    const html =
      '<html><head><style>.x{}</style></head><body><p>Hallo&nbsp;Max</p><table><tr><td>Sendungsnummer:</td><td>JJD000390007843123456</td></tr></table>' +
      '<a href="https://www.ups.com/track?tracknum=1Z999AA10123456784&amp;loc=de_DE">Verfolgen</a><script>alert(1)</script></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Hallo Max');
    expect(text).toContain('Sendungsnummer: JJD000390007843123456');
    expect(text).not.toContain('alert');
    expect(extractLinks(html)).toEqual(['https://www.ups.com/track?tracknum=1Z999AA10123456784&loc=de_DE']);
  });

  it('infers the status from subjects', () => {
    expect(inferStatus('Ihre Sendung wurde versandt')).toBe('in_transit');
    expect(inferStatus('Ihr Paket wird heute zugestellt')).toBe('out_for_delivery');
    expect(inferStatus('Ihr Paket wurde zugestellt')).toBe('delivered');
    expect(inferStatus('Ihr Paket konnte nicht zugestellt werden')).toBe('exception');
    expect(inferStatus('Newsletter November')).toBeNull();
  });

  it('builds labels and queries', () => {
    expect(labelFromSubject('AW: Fwd:  Deine Bestellung   wurde versandt', 'dhl')).toBe('Deine Bestellung wurde versandt');
    expect(labelFromSubject('', 'ups')).toBe('UPS-Sendung');
    expect(buildGmailQuery()).toContain('newer_than:30d');
    expect(buildGmailQuery(1_700_000_000)).toContain('after:1700000000');
  });

  it('parses Gmail API messages (multipart, base64url, charset)', () => {
    const toB64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const b64url = (s: string) => toB64url(new TextEncoder().encode(s));
    const latin1 = toB64url(Uint8Array.from('Grüße, Sendungsnummer H1002290001234567890', (c) => c.charCodeAt(0)));
    const parsed = parseGmailMessage({
      id: 'abc',
      internalDate: '1762423200000',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'Hermes <noreply@myhermes.de>' },
          { name: 'Subject', value: 'Deine Sendung ist unterwegs' },
        ],
        parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }], body: { data: latin1 } },
          { mimeType: 'text/html', body: { data: b64url('<a href="https://www.myhermes.de/x#H1002290001234567890">Link</a>') } },
        ],
      },
    });
    expect(parsed.subject).toBe('Deine Sendung ist unterwegs');
    expect(parsed.text).toContain('Grüße');
    expect(parsed.links).toHaveLength(1);
    expect(parsed.date).toBe(new Date(1762423200000).toISOString());
    expect(extractFromMail(parsed)[0]).toMatchObject({ trackingNumber: 'H1002290001234567890', carrier: 'hermes', auto: true });
  });
});

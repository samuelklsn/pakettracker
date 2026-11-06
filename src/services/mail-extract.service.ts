import type { CarrierId, OrderInfo, ShipmentStatus } from '../core/types';
import { CARRIERS, carrierForHost } from './carriers';
import { type CarrierCandidate, detect, matchCarriers, normalizeTrackingNumber } from './detection.service';

/**
 * Mail extraction – pure functions (no DOM, no network), fully unit-tested.
 *
 * Turns a decoded e-mail into tracking-number candidates and decides which ones are
 * safe to add automatically and which ones should be confirmed by the user.
 */

export interface MailMessage {
  id: string;
  /** Raw "From" header, e.g. `DHL Paket <noreply@dhl.de>` */
  from: string;
  subject: string;
  /** ISO timestamp */
  date: string;
  /** Plain text content (HTML already converted) */
  text: string;
  /** All hyperlinks found in the HTML part */
  links: string[];
}

export interface ExtractedShipment {
  trackingNumber: string;
  carrier: CarrierId;
  confidence: number;
  reason: string;
  /** true → safe to add without confirmation */
  auto: boolean;
  sourceUrl?: string;
}

/** Words that indicate a tracking number follows. */
const KEYWORD_RE =
  /(sendungs-?\s?(?:nummer|nr\.?|verfolgung|id)|paket-?\s?(?:nummer|nr\.?|schein(?:nummer)?)|tracking[\s-]?(?:nummer|number|no\.?|id|code|link)?|track\s?(?:&|und|and)\s?trace|sendung\s+verfolgen|shipment\s?(?:number|id)|parcel\s?(?:number|no\.?|id)|identcode|piececode)/i;

/** Labels of numbers we must NOT treat as tracking numbers. */
const NEGATIVE_RE =
  /(bestell|auftrags|order|kunden|customer|rechnung|invoice|telefon|tel\.?|phone|fax|iban|bic|artikel|article|plz|postleitzahl|ust|steuer|konto|referenz|ref\.?|mitglieds|gutschein|voucher|pin|tan)\s*[-:.#nr]*\s*$/i;

/** Search patterns for candidate tokens in plain text. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b1Z[0-9A-Z]{16}\b/gi, // UPS
  /\bJJD\d{18,20}\b/gi, // DHL JJD
  /\bH\d{19}\b/g, // Hermes
  /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g, // UPU S10
  /\b\d{4}(?: \d{4}){2,4}(?: \d{1,4})?\b/g, // grouped digits "0034 0434 1612 …"
  /\b\d{10,20}[A-Z]?\b/g, // contiguous digits
];

const AUTO_RULE_CONFIDENCE = 0.9;
const MIN_SUGGEST_CONFIDENCE = 0.45;

export function senderAddress(from: string): string | undefined {
  const m = /<([^>\s]+@[^>\s]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from);
  return m?.[1]?.toLowerCase();
}

export function senderCarrier(from: string): CarrierId | null {
  const domain = senderAddress(from)?.split('@')[1];
  return domain ? carrierForHost(domain) : null;
}

/** Cleans a subject line into a shipment label. */
export function labelFromSubject(subject: string, carrier: CarrierId): string {
  const cleaned = subject
    .replace(/^\s*((re|aw|fw|fwd|wg)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return `${CARRIERS[carrier].name}-Sendung`;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

export function extractFromMail(mail: MailMessage): ExtractedShipment[] {
  const fromCarrier = senderCarrier(mail.from);
  const found = new Map<string, ExtractedShipment>();

  const keep = (e: ExtractedShipment) => {
    const prev = found.get(e.trackingNumber);
    if (!prev || prev.confidence < e.confidence || (e.auto && !prev.auto)) {
      found.set(e.trackingNumber, { ...e, sourceUrl: e.sourceUrl ?? prev?.sourceUrl });
    }
  };

  // 1) Carrier tracking links – the strongest signal.
  for (const link of new Set(mail.links.slice(0, 300))) {
    let host: string;
    try {
      host = new URL(link).hostname;
    } catch {
      continue;
    }
    if (!carrierForHost(host)) continue; // ignore shop links with generic ?id= parameters
    const d = detect(link);
    const top = d.candidates[0];
    if (d.kind !== 'url' || !d.trackingNumber || !top) continue;
    keep({
      trackingNumber: d.trackingNumber,
      carrier: top.carrier,
      confidence: 0.98,
      reason: `Tracking-Link von ${host}`,
      auto: true,
      sourceUrl: link,
    });
  }

  // 2) Numbers in the text, scored by context.
  const text = `${mail.subject}\n${mail.text}`;
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const number = normalizeTrackingNumber(m[0]);
      const candidates = matchCarriers(number);
      if (candidates.length === 0) continue;

      const before = text.slice(Math.max(0, m.index - 80), m.index);
      const near = text.slice(Math.max(0, m.index - 35), m.index);
      const keyword = KEYWORD_RE.test(before);
      if (NEGATIVE_RE.test(near) && !KEYWORD_RE.test(near)) continue;

      const scored = scoreCandidate(candidates, fromCarrier, keyword);
      if (scored) keep({ trackingNumber: number, ...scored });
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

function scoreCandidate(
  candidates: CarrierCandidate[],
  fromCarrier: CarrierId | null,
  keyword: boolean,
): Omit<ExtractedShipment, 'trackingNumber'> | null {
  // Prefer the sender's carrier if the number format fits it.
  const best = (fromCarrier && candidates.find((c) => c.carrier === fromCarrier)) || candidates[0]!;
  const senderMatch = fromCarrier !== null && best.carrier === fromCarrier;
  const distinctive = best.confidence >= AUTO_RULE_CONFIDENCE && !best.reason.includes('ungültig');

  let confidence = best.confidence;
  const reasons = [best.reason];
  if (senderMatch) {
    confidence += 0.2;
    reasons.push(`Absender ${CARRIERS[best.carrier].name}`);
  }
  if (keyword) {
    confidence += 0.15;
    reasons.push('Tracking-Stichwort im Text');
  }
  confidence = Math.min(0.99, confidence);

  // Without any context a plain digit string is far too likely to be something else.
  if (!distinctive && !senderMatch && !keyword) return null;
  if (confidence < MIN_SUGGEST_CONFIDENCE) return null;

  const auto = (distinctive && (keyword || senderMatch || best.reason.includes('gültig'))) || (senderMatch && keyword);
  return { carrier: best.carrier, confidence, reason: reasons.join(' · '), auto };
}

/* ------------------------------ Order details ------------------------------ */

/** Bump when the extraction gets better → existing shipments are enriched by a one-time re-scan. */
export const EXTRACT_VERSION = 2;

const SHOP_NOISE =
  /\b(kundenservice|kundendienst|customer service|service|team|versand|versandabteilung|shipping|bestellung(en)?|order(s)?|benachrichtigung(en)?|notifications?|newsletter|no-?reply|info|mailer|shop-?team)\b/gi;

function cleanShop(name: string): string | undefined {
  const cleaned = name
    .replace(/["'„“]/g, '')
    .replace(/\s+(via|über)\s+.*$/i, '')
    .replace(SHOP_NOISE, '')
    .replace(/[|•·:–-]+\s*$/, '')
    .replace(/^\s*[|•·:–-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 2 && cleaned.length <= 40 && /[a-zA-ZäöüÄÖÜ]/.test(cleaned) ? cleaned : undefined;
}

function shopFromDomain(address: string | undefined): string | undefined {
  const domain = address?.split('@')[1];
  if (!domain) return undefined;
  const parts = domain.toLowerCase().split('.');
  // mail.shop.de → shop; amazon.de → amazon
  const base = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
  if (!base || /^(gmail|googlemail|web|gmx|outlook|hotmail|yahoo|t-online|icloud|mail)$/.test(base)) return undefined;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const SHOP_IN_TEXT =
  /(?:[Pp]aket|[Ss]endung|[Ll]ieferung|[Bb]estellung|[Pp]äckchen)\s+(?:von|vom [Aa]bsender)\s+([A-ZÄÖÜ0-9][\wÄÖÜäöüß&.'+-]*(?:\s+[A-ZÄÖÜ0-9][\wÄÖÜäöüß&.'+-]*){0,3})/;
const SENDER_LABEL = /^(?:absender|versender|händler|haendler|shop|verkäufer|verkaeufer)\s*:\s*(.{2,60})$/im;

function extractShop(mail: MailMessage): string | undefined {
  const fromCarrier = senderCarrier(mail.from);
  const text = `${mail.subject}\n${mail.text}`;
  if (fromCarrier) {
    // Carrier notification: the shop is mentioned in the text ("Ihr Paket von Zalando …")
    const m = SHOP_IN_TEXT.exec(text) ?? SENDER_LABEL.exec(mail.text);
    const shop = m?.[1] ? cleanShop(m[1].replace(/\s+(ist|wird|wurde|kommt|an|in|am|für)\b.*$/i, '')) : undefined;
    return shop && !carrierForHost(`${shop.toLowerCase()}.de`) ? shop : undefined;
  }
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(mail.from)?.[1];
  return (display ? cleanShop(display) : undefined) ?? shopFromDomain(senderAddress(mail.from));
}

const ITEM_BLOCKLIST =
  /(summe|gesamt|zwischensumme|versand|lieferkosten|lieferung|mwst|ust\.?|steuer|rabatt|gutschein|total|subtotal|tax|shipping|zahlung|payment|rechnung|adresse|anschrift|sendungsnummer|tracking|bestellnummer|bestelldatum|kundennummer|datum|uhr|http|www\.|@|impressum|datenschutz|abmelden|newsletter|hallo|liebe|vielen dank|danke|grüße|gruesse|mfg|telefon|straße|strasse|verfolgen|status)/i;
const PRICE = /(?:\d{1,5}[.,]\d{2}\s?(?:€|eur)|(?:€|eur)\s?\d{1,5}[.,]\d{2})/i;

function cleanItem(s: string): string | undefined {
  const item = s
    .replace(/\b(?:menge|anzahl|stück|stückzahl|qty|quantity)\s*:?\s*\d+\b/gi, '')
    .replace(/\s[x×]\s?\d{1,2}\b/gi, '')
    .replace(PRICE, '')
    .replace(/^[-•*·▪︎\s]+/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:–-]+$/, '')
    .trim();
  if (item.length < 3 || item.length > 140) return undefined;
  if (!/[a-zA-ZäöüÄÖÜ]{3}/.test(item) || ITEM_BLOCKLIST.test(item)) return undefined;
  if (/^\d[\d\s.,]*$/.test(item)) return undefined;
  return item;
}

function extractItems(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 600);
  const found: string[] = [];
  const add = (s: string | undefined) => {
    const item = s ? cleanItem(s) : undefined;
    if (item && !found.some((f) => f.toLowerCase() === item.toLowerCase())) found.push(item);
  };
  lines.forEach((line, i) => {
    let m: RegExpExecArray | null;
    if ((m = /^(\d{1,2})\s*[x×]\s+(.+)$/i.exec(line))) add(m[2]);
    else if ((m = /^(.+?)\s+[x×]\s*\d{1,2}$/i.exec(line))) add(m[1]);
    else if ((m = /^(?:artikel|artikelname|produkt|produktname|item|bezeichnung)\s*:\s*(.+)$/i.exec(line))) add(m[1]);
    else if (/^(?:menge|anzahl|stück|stückzahl|qty|quantity)\s*:?\s*\d+/i.test(line)) add(lines[i - 1]);
    else if (new RegExp(`^${PRICE.source}$`, 'i').test(line)) add(lines[i - 1]);
    else if ((m = new RegExp(`^(.{3,120}?)\\s+${PRICE.source}$`, 'i').exec(line))) add(m[1]);
  });
  return found.slice(0, 5);
}

const ORDER_RE =
  /(?:bestell(?:ung)?s?[-\s]?(?:nummer|nr\.?)|auftrags(?:nummer|nr\.?)|order\s?(?:number|no\.?|#|id)|bestellung)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,30}\d)/i;

export function extractOrderInfo(mail: MailMessage): OrderInfo {
  const order = ORDER_RE.exec(`${mail.subject}\n${mail.text}`)?.[1];
  return {
    shop: extractShop(mail),
    items: extractItems(mail.text),
    orderNumber: order && /\d{3,}/.test(order) ? order : undefined,
  };
}

/** Human-friendly label: item name > "Bestellung bei Shop" > cleaned subject. */
export function shipmentLabel(info: OrderInfo, subject: string, carrier: CarrierId): string {
  const first = info.items[0];
  if (first) {
    const short = first.length > 60 ? `${first.slice(0, 59)}…` : first;
    return info.items.length > 1 ? `${short} (+${info.items.length - 1})` : short;
  }
  if (info.shop) return `Bestellung bei ${info.shop}`;
  return labelFromSubject(subject, carrier);
}

/** Deep link that opens the original notification in Gmail. */
export function gmailLink(messageId: string, account?: string): string {
  const user = account ? `?authuser=${encodeURIComponent(account)}` : '';
  return `https://mail.google.com/mail/${user}#all/${encodeURIComponent(messageId)}`;
}

/**
 * Infers the shipment status from a notification subject. Order matters:
 * "nicht zugestellt" must win over "zugestellt", "heute zugestellt" over "zugestellt".
 */
export function inferStatus(subject: string): ShipmentStatus | null {
  const s = subject.toLowerCase();
  if (/(nicht zugestellt|konnte nicht|zustellversuch|verzöger|problem|zurück an|rücksendung an den absender|delay|exception|failed)/.test(s)) return 'exception';
  if (/(in zustellung|heute (zugestellt|geliefert|zustellung)|wird heute|kommt heute|out for delivery|arriving today|zustellfahrzeug|zusteller ist unterwegs)/.test(s)) return 'out_for_delivery';
  if (/(zugestellt|wurde geliefert|ist angekommen|abgeholt|delivered|abgegeben)/.test(s)) return 'delivered';
  if (/(versandt|verschickt|unterwegs|auf dem weg|shipped|dispatched|übergeben|abgeschickt|on its way|versendet)/.test(s)) return 'in_transit';
  if (/(angekündigt|versandbereit|wird vorbereitet|label created|elektronisch angekündigt)/.test(s)) return 'pre_transit';
  return null;
}

/* ------------------------------ HTML → text ------------------------------ */

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", shy: '' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Lightweight, inert HTML-to-text conversion (never touches the DOM). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = decodeEntities((m[1] ?? m[2] ?? '').trim());
    if (/^https?:\/\//i.test(href)) links.push(href);
  }
  return links;
}

/** Gmail search query limited to shipping-related mails. */
export function buildGmailQuery(sinceEpochSeconds?: number): string {
  const senders = [
    'dhl.de', 'dhl.com', 'deutschepost.de', 'ups.com', 'dpd.de', 'dpd.com', 'myhermes.de', 'hermesworld.com',
    'amazon.de', 'amazon.com', 'zalando.de', 'otto.de', 'ebay.de', 'ebay.com', 'paypal.de',
  ];
  const subjects = ['Sendungsnummer', 'Sendungsverfolgung', 'versandt', 'verschickt', 'Versandbestätigung', 'Lieferung', 'Paket', '"tracking number"', 'shipped'];
  const time = sinceEpochSeconds ? `after:${Math.floor(sinceEpochSeconds)}` : 'newer_than:30d';
  return `${time} -in:spam -in:trash {from:(${senders.join(' OR ')}) subject:(${subjects.join(' OR ')})}`;
}

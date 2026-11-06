import type { CarrierId } from '../core/types';
import { carrierForHost } from './carriers';

/**
 * Smart-Input classification. Pure functions, fully unit-tested.
 *
 * Distinguishes between e-mail addresses, URLs (incl. extraction of the tracking
 * number from carrier links) and carrier-specific tracking IDs. Where formats
 * overlap (e.g. 14 digits = DPD *or* Hermes) multiple ranked candidates are returned.
 */

export type DetectionKind = 'empty' | 'email' | 'url' | 'tracking' | 'unknown';

export interface CarrierCandidate {
  carrier: CarrierId;
  /** 0..1 – heuristic confidence */
  confidence: number;
  /** Human readable reason, e.g. "UPS 1Z-Format, Prüfziffer gültig" */
  reason: string;
}

export interface DetectionResult {
  kind: DetectionKind;
  raw: string;
  /** Normalised tracking number (uppercase, no whitespace) – if any */
  trackingNumber?: string;
  email?: string;
  url?: string;
  candidates: CarrierCandidate[];
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i;

/** Ordered rules; first matching rules get higher confidence. */
interface Rule {
  carrier: CarrierId;
  re: RegExp;
  confidence: number;
  reason: string;
  checksum?: (n: string) => boolean;
}

const RULES: readonly Rule[] = [
  { carrier: 'ups', re: /^1Z[0-9A-Z]{16}$/, confidence: 0.9, reason: 'UPS 1Z-Format', checksum: upsChecksum },
  { carrier: 'ups', re: /^(?:T\d{10}|\d{9}|\d{26})$/, confidence: 0.35, reason: 'UPS-Sonderformat' },
  { carrier: 'dhl', re: /^JJD\d{18,20}$/, confidence: 0.95, reason: 'DHL JJD-Paketnummer' },
  { carrier: 'dhl', re: /^00340\d{15}$/, confidence: 0.95, reason: 'DHL Paket (20-stellig, 00340…)' },
  { carrier: 'dhl', re: /^[A-Z]{2}\d{9}DE$/, confidence: 0.9, reason: 'Deutsche Post / DHL International', checksum: s10Checksum },
  { carrier: 'dhl', re: /^\d{12}$/, confidence: 0.75, reason: 'DHL Paket (12-stellig)' },
  { carrier: 'dhl', re: /^\d{20}$/, confidence: 0.65, reason: 'DHL Paket (20-stellig)' },
  { carrier: 'dhl', re: /^\d{10}$/, confidence: 0.55, reason: 'DHL Express (10-stellig)' },
  { carrier: 'hermes', re: /^H\d{19}$/, confidence: 0.95, reason: 'Hermes H-Sendungsnummer' },
  { carrier: 'hermes', re: /^\d{16}$/, confidence: 0.6, reason: 'Hermes (16-stellig)' },
  { carrier: 'dpd', re: /^0\d{13}$/, confidence: 0.7, reason: 'DPD Paketscheinnummer (14-stellig)' },
  { carrier: 'dpd', re: /^\d{14}[A-Z]?$/, confidence: 0.5, reason: 'DPD (14-stellig)' },
  { carrier: 'hermes', re: /^\d{14}$/, confidence: 0.45, reason: 'Hermes (14-stellig)' },
  { carrier: 'other', re: /^[A-Z]{2}\d{9}[A-Z]{2}$/, confidence: 0.6, reason: 'Internationale Post (UPU S10)', checksum: s10Checksum },
];

/** Query parameters / fragments carriers commonly use for tracking numbers in links. */
const URL_PARAM_KEYS = [
  'piececode', 'idc', 'tracking-id', 'trackingnumber', 'tracknum', 'tracknumbers', 'tracking',
  'parcelnumber', 'parcelno', 'parcel', 'shipmentid', 'sendungsnummer', 'query', 'id', 'nums', 'q',
];

export function normalizeTrackingNumber(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

export function detect(input: string): DetectionResult {
  const raw = input.trim();
  if (!raw) return { kind: 'empty', raw, candidates: [] };

  if (EMAIL_RE.test(raw) && raw.length <= 254) {
    return { kind: 'email', raw, email: raw.toLowerCase(), candidates: [] };
  }

  if (URL_RE.test(raw)) {
    return detectUrl(raw);
  }

  const n = normalizeTrackingNumber(raw);
  const candidates = matchCarriers(n);
  if (candidates.length > 0) return { kind: 'tracking', raw, trackingNumber: n, candidates };

  // Looks like an ID but unknown format → let the user pick a carrier manually
  if (/^[A-Z0-9]{8,40}$/.test(n) && /\d/.test(n)) {
    return { kind: 'unknown', raw, trackingNumber: n, candidates: [] };
  }
  return { kind: 'unknown', raw, candidates: [] };
}

export function matchCarriers(n: string): CarrierCandidate[] {
  const best = new Map<CarrierId, CarrierCandidate>();
  for (const rule of RULES) {
    if (!rule.re.test(n)) continue;
    let confidence = rule.confidence;
    let reason = rule.reason;
    if (rule.checksum) {
      if (rule.checksum(n)) {
        confidence = Math.min(0.99, confidence + 0.08);
        reason += ', Prüfziffer gültig';
      } else {
        confidence -= 0.25;
        reason += ', Prüfziffer ungültig';
      }
    }
    const prev = best.get(rule.carrier);
    if (!prev || prev.confidence < confidence) best.set(rule.carrier, { carrier: rule.carrier, confidence, reason });
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function detectUrl(raw: string): DetectionResult {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { kind: 'unknown', raw, candidates: [] };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'unknown', raw, candidates: [] };

  const hostCarrier = carrierForHost(url.hostname);
  const number = extractNumberFromUrl(url);
  let candidates: CarrierCandidate[] = number ? matchCarriers(number) : [];

  if (hostCarrier) {
    // The host is the strongest signal – promote it to the top.
    const fromHost: CarrierCandidate = {
      carrier: hostCarrier,
      confidence: 0.98,
      reason: `Link von ${url.hostname}`,
    };
    candidates = [fromHost, ...candidates.filter((c) => c.carrier !== hostCarrier)];
  }

  return {
    kind: 'url',
    raw,
    url: url.toString(),
    trackingNumber: number ?? undefined,
    candidates,
  };
}

function extractNumberFromUrl(url: URL): string | null {
  const plausible = (v: string | null | undefined): string | null => {
    if (!v) return null;
    const first = v.split(/[,;|]/)[0] ?? '';
    const n = normalizeTrackingNumber(decodeURIComponentSafe(first));
    return /^[A-Z0-9]{8,40}$/.test(n) && /\d{4,}/.test(n) ? n : null;
  };

  for (const [key, value] of url.searchParams) {
    if (URL_PARAM_KEYS.includes(key.toLowerCase())) {
      const n = plausible(value);
      if (n) return n;
    }
  }
  // Fragment, e.g. myhermes.de/...#H1234…  or  17track #nums=…
  const hash = url.hash.replace(/^#/, '');
  if (hash) {
    const fromParams = new URLSearchParams(hash);
    for (const key of URL_PARAM_KEYS) {
      const n = plausible(fromParams.get(key));
      if (n) return n;
    }
    const n = plausible(hash);
    if (n) return n;
  }
  // Path segment, e.g. tracking.dpd.de/status/de_DE/parcel/01234567890123
  const segments = url.pathname.split('/').filter(Boolean).reverse();
  for (const seg of segments) {
    const n = plausible(seg);
    if (n && matchCarriers(n).length > 0) return n;
  }
  return null;
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/* ------------------------------ Checksums ------------------------------ */

/** UPS 1Z check digit (last character). */
export function upsChecksum(n: string): boolean {
  const body = n.slice(2, 17);
  const check = n.charAt(17);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    const v = /\d/.test(ch) ? Number(ch) : (ch.charCodeAt(0) - 63) % 10;
    sum += i % 2 === 1 ? v * 2 : v;
  }
  const digit = (10 - (sum % 10)) % 10;
  return String(digit) === check;
}

/** UPU S10 (e.g. RR123456785DE) check digit. */
export function s10Checksum(n: string): boolean {
  const digits = n.slice(2, 10);
  const check = Number(n.charAt(10));
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(digits.charAt(i)) * (weights[i] ?? 0);
  let c = 11 - (sum % 11);
  if (c === 10) c = 0;
  if (c === 11) c = 5;
  return c === check;
}

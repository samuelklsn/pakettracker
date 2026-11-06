import type { CarrierId } from '../core/types';

export interface CarrierInfo {
  id: CarrierId;
  name: string;
  /** Monogram used in the UI (no trademarked logos are bundled) */
  short: string;
  /** Brand-inspired accent colour for badges */
  color: string;
  textColor: string;
  /** Official public tracking page. `null` → no deeplink possible. */
  trackingUrl: (trackingNumber: string) => string | null;
  hosts: readonly string[];
}

const enc = encodeURIComponent;

export const CARRIERS: Record<CarrierId, CarrierInfo> = {
  dhl: {
    id: 'dhl',
    name: 'DHL',
    short: 'DHL',
    color: '#FFCC00',
    textColor: '#D40511',
    trackingUrl: (n) =>
      /^\d{10}$/.test(n)
        ? `https://www.dhl.com/de-de/home/tracking/tracking-express.html?submit=1&tracking-id=${enc(n)}`
        : `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${enc(n)}`,
    hosts: ['dhl.de', 'dhl.com', 'deutschepost.de'],
  },
  ups: {
    id: 'ups',
    name: 'UPS',
    short: 'UPS',
    color: '#351C15',
    textColor: '#FFB500',
    trackingUrl: (n) => `https://www.ups.com/track?loc=de_DE&tracknum=${enc(n)}`,
    hosts: ['ups.com'],
  },
  dpd: {
    id: 'dpd',
    name: 'DPD',
    short: 'DPD',
    color: '#DC0032',
    textColor: '#FFFFFF',
    trackingUrl: (n) => `https://tracking.dpd.de/status/de_DE/parcel/${enc(n)}`,
    hosts: ['dpd.de', 'dpd.com', 'dpdgroup.com'],
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    short: 'H',
    color: '#0091CD',
    textColor: '#FFFFFF',
    trackingUrl: (n) => `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${enc(n)}`,
    hosts: ['myhermes.de', 'hermesworld.com', 'hermes-europe.co.uk'],
  },
  other: {
    id: 'other',
    name: 'Sonstiger',
    short: '?',
    color: '#3F3F46',
    textColor: '#FAFAFA',
    trackingUrl: () => null,
    hosts: [],
  },
};

export const CARRIER_LIST: readonly CarrierInfo[] = Object.values(CARRIERS);

export function carrierForHost(hostname: string): CarrierId | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const c of CARRIER_LIST) {
    if (c.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return c.id;
  }
  return null;
}

/** Returns a safe https deeplink or null. Never returns javascript:/data: URLs. */
export function deeplinkFor(carrier: CarrierId, trackingNumber: string): string | null {
  const url = CARRIERS[carrier].trackingUrl(trackingNumber.trim());
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

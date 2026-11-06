import { TrackingProviderError } from '../core/errors';
import { uid } from '../core/id';
import type { Shipment, ShipmentStatus, TrackingEvent } from '../core/types';
import { deeplinkFor } from './carriers';

/**
 * TrackingService (API layer)
 *
 * Provider pattern:
 *  1. RemoteProxyProvider – only active when `VITE_TRACKING_API_URL` is set at build time.
 *     Talks to a self-hosted proxy that holds carrier API keys (keys must NEVER ship to the browser).
 *  2. LocalProvider – always available. Builds the timeline from the encrypted, manually
 *     maintained events and offers official carrier deeplinks. No data leaves the device.
 *
 * If the remote provider fails, the service transparently falls back to the local provider.
 */

export const STATUS_ORDER: readonly ShipmentStatus[] = ['pre_transit', 'in_transit', 'out_for_delivery', 'delivered'];

export const STATUS_META: Record<ShipmentStatus, { label: string; short: string; tone: string }> = {
  pre_transit: { label: 'Sendung angekündigt', short: 'Angekündigt', tone: 'amber' },
  in_transit: { label: 'Unterwegs', short: 'Unterwegs', tone: 'sky' },
  out_for_delivery: { label: 'In Zustellung', short: 'In Zustellung', tone: 'violet' },
  delivered: { label: 'Zugestellt', short: 'Zugestellt', tone: 'emerald' },
  exception: { label: 'Problem bei der Zustellung', short: 'Problem', tone: 'rose' },
};

export interface TrackingResult {
  status: ShipmentStatus;
  /** newest first */
  events: TrackingEvent[];
  source: 'remote' | 'local';
  deeplink: string | null;
  fetchedAt: string;
  estimatedDelivery?: string;
  /** set when remote failed and we fell back */
  warning?: string;
}

export interface TrackingProvider {
  readonly id: string;
  track(shipment: Shipment, signal?: AbortSignal): Promise<TrackingResult>;
}

/* ------------------------------ Local provider ------------------------------ */

export class LocalProvider implements TrackingProvider {
  readonly id = 'local';

  async track(shipment: Shipment): Promise<TrackingResult> {
    const events = buildTimeline(shipment);
    return {
      status: deriveStatus(shipment),
      events,
      source: 'local',
      deeplink: deeplinkFor(shipment.carrier, shipment.trackingNumber),
      fetchedAt: new Date().toISOString(),
      estimatedDelivery: shipment.remote?.estimatedDelivery,
    };
  }
}

/* ------------------------------ Remote provider ----------------------------- */

interface RemoteResponse {
  status: ShipmentStatus;
  estimatedDelivery?: string;
  events: { status: ShipmentStatus; at: string; title: string; description?: string; location?: string }[];
}

export class RemoteProxyProvider implements TrackingProvider {
  readonly id = 'remote';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 12_000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async track(shipment: Shipment, signal?: AbortSignal): Promise<TrackingResult> {
    const url = new URL('track', this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set('carrier', shipment.carrier);
    url.searchParams.set('number', shipment.trackingNumber);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true });

    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch (err) {
      throw new TrackingProviderError('Tracking-API nicht erreichbar', { cause: err });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new TrackingProviderError(`Tracking-API antwortete mit HTTP ${res.status}`);

    const body = parseRemote(await res.json().catch(() => null));
    const events: TrackingEvent[] = body.events.map((e) => ({ ...e, id: uid(), origin: 'remote' as const }));
    return {
      status: body.status,
      events: sortDesc(events),
      source: 'remote',
      deeplink: deeplinkFor(shipment.carrier, shipment.trackingNumber),
      fetchedAt: new Date().toISOString(),
      estimatedDelivery: body.estimatedDelivery,
    };
  }
}

function parseRemote(raw: unknown): RemoteResponse {
  const statuses: readonly string[] = [...STATUS_ORDER, 'exception'];
  if (typeof raw !== 'object' || raw === null) throw new TrackingProviderError('Ungültige API-Antwort');
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'string' || !statuses.includes(r.status) || !Array.isArray(r.events)) {
    throw new TrackingProviderError('Ungültige API-Antwort');
  }
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return {
    status: r.status as ShipmentStatus,
    estimatedDelivery: text(r.estimatedDelivery, 64),
    events: r.events
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .filter((e) => typeof e.title === 'string' && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)))
      .slice(0, 200)
      .map((e) => ({
        status: (statuses.includes(e.status as string) ? e.status : 'in_transit') as ShipmentStatus,
        at: e.at as string,
        title: (e.title as string).slice(0, 200),
        description: text(e.description, 1000),
        location: text(e.location, 200),
      })),
  };
}

/* ------------------------------ Facade ------------------------------ */

export class TrackingService {
  private readonly local = new LocalProvider();
  private readonly remote: TrackingProvider | null;

  constructor(remoteBaseUrl: string | undefined = import.meta.env.VITE_TRACKING_API_URL) {
    this.remote = remoteBaseUrl ? new RemoteProxyProvider(remoteBaseUrl) : null;
  }

  get hasRemote(): boolean {
    return this.remote !== null;
  }

  /** Builds a result purely from local (manual + cached remote) data – no network. */
  async fromCache(shipment: Shipment): Promise<TrackingResult> {
    const result = await this.local.track(shipment);
    if (shipment.remote) {
      result.source = 'remote';
      result.fetchedAt = shipment.remote.fetchedAt;
    }
    return result;
  }

  async track(shipment: Shipment, signal?: AbortSignal): Promise<TrackingResult> {
    if (this.remote) {
      try {
        return await this.remote.track(shipment, signal);
      } catch (err) {
        const result = await this.local.track(shipment);
        result.warning = err instanceof Error ? err.message : 'Tracking-API fehlgeschlagen';
        return result;
      }
    }
    return this.local.track(shipment);
  }
}

/* ------------------------------ Helpers ------------------------------ */

function sortDesc(events: TrackingEvent[]): TrackingEvent[] {
  // stable for equal timestamps: later-added events count as newer
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(b.e.at) - Date.parse(a.e.at) || b.i - a.i)
    .map(({ e }) => e);
}

/**
 * Merged timeline, newest first. The synthetic "created" event is always the
 * oldest entry, even if the user back-dates manual events before it.
 */
export function buildTimeline(s: Shipment): TrackingEvent[] {
  const created: TrackingEvent = {
    id: `${s.id}-created`,
    status: 'pre_transit',
    at: s.createdAt,
    title: 'Sendung im Tresor angelegt',
    description: 'Lokal & verschlüsselt gespeichert',
    origin: 'system',
  };
  const remote = s.remote?.events ?? [];
  return [...sortDesc([...remote, ...s.events]), created];
}

/** Effective status: the newest real (manual or remote) event wins. */
export function deriveStatus(s: Shipment): ShipmentStatus {
  const newest = sortDesc([...(s.remote?.events ?? []), ...s.events])[0];
  return newest?.status ?? s.remote?.status ?? 'pre_transit';
}

export function statusProgress(status: ShipmentStatus): number {
  if (status === 'exception') return -1;
  return STATUS_ORDER.indexOf(status);
}

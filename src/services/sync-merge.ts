import { MAX_TOMBSTONES, type MailSuggestion, type Shipment, type Tombstone, type TrackingEvent, type VaultData } from '../core/types';

/**
 * Deterministic, conflict-free merge of two vault states (pure function).
 *
 * Properties (unit-tested):
 *  - commutative for the user-visible result: merge(a, b) ≅ merge(b, a)
 *  - idempotent: merge(a, a) ≅ a
 *  - deletions win over older edits (tombstones), newer edits win over older deletions
 *  - timeline events are never lost (union by event id)
 */

const MAX_PROCESSED_IDS = 2000;
const MAX_DISMISSED = 1000;

const newer = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

function unionEvents(a: TrackingEvent[], b: TrackingEvent[]): TrackingEvent[] {
  const map = new Map<string, TrackingEvent>();
  for (const e of [...a, ...b]) if (!map.has(e.id)) map.set(e.id, e);
  return [...map.values()].sort((x, y) => x.at.localeCompare(y.at) || x.id.localeCompare(y.id));
}

/** Combines two versions of the same shipment: newest fields win, events are unioned. */
function mergeShipment(a: Shipment, b: Shipment): Shipment {
  const [winner, loser] =
    a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id <= b.id) ? [a, b] : [b, a];
  const remote =
    winner.remote && loser.remote
      ? winner.remote.fetchedAt >= loser.remote.fetchedAt ? winner.remote : loser.remote
      : (winner.remote ?? loser.remote);
  return {
    ...winner,
    // a shipment that exists twice (same number added on two devices) keeps the older identity
    id: a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id <= b.id) ? a.id : b.id,
    createdAt: a.createdAt < b.createdAt ? a.createdAt : b.createdAt,
    events: unionEvents(winner.events, loser.events),
    remote,
  };
}

function unionTombstones(a: Tombstone[], b: Tombstone[]): Tombstone[] {
  const map = new Map<string, string>();
  for (const t of [...a, ...b]) map.set(t.id, map.has(t.id) ? newer(map.get(t.id)!, t.at) : t.at);
  return [...map.entries()]
    .map(([id, at]) => ({ id, at }))
    .sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id))
    .slice(0, MAX_TOMBSTONES);
}

function unionStrings(a: string[], b: string[], max: number): string[] {
  return [...new Set([...a, ...b])].slice(0, max);
}

export function mergeVaults(a: VaultData, b: VaultData): VaultData {
  const deleted = unionTombstones(a.deleted, b.deleted);
  const tomb = new Map(deleted.map((t) => [t.id, t.at]));

  // 1) merge by id
  const byId = new Map<string, Shipment>();
  for (const s of [...a.shipments, ...b.shipments]) {
    const prev = byId.get(s.id);
    byId.set(s.id, prev ? mergeShipment(prev, s) : s);
  }
  // 2) apply deletions (an edit newer than the deletion revives the shipment)
  let shipments = [...byId.values()].filter((s) => {
    const at = tomb.get(s.id);
    return !at || s.updatedAt > at;
  });
  // 3) collapse duplicates by tracking number (same parcel added on two devices)
  const byNumber = new Map<string, Shipment>();
  for (const s of shipments) {
    const key = `${s.carrier}:${s.trackingNumber}`;
    const prev = byNumber.get(key);
    byNumber.set(key, prev ? mergeShipment(prev, s) : s);
  }
  shipments = [...byNumber.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.id.localeCompare(y.id));

  // Settings & inbox scalars: the more recently modified side wins
  const [fresh, stale] = a.updatedAt >= b.updatedAt ? [a, b] : [b, a];

  const dismissed = unionStrings(fresh.inbox.dismissed, stale.inbox.dismissed, MAX_DISMISSED);
  const known = new Set(shipments.map((s) => s.trackingNumber));
  const blocked = new Set(dismissed);
  const suggestions = new Map<string, MailSuggestion>();
  for (const s of [...fresh.inbox.suggestions, ...stale.inbox.suggestions]) {
    if (known.has(s.trackingNumber) || blocked.has(s.trackingNumber) || suggestions.has(s.trackingNumber)) continue;
    suggestions.set(s.trackingNumber, s);
  }

  const lastScans = [a.inbox.lastScanAt, b.inbox.lastScanAt].filter((x): x is string => !!x).sort();

  return {
    schema: 1,
    shipments,
    settings: { ...fresh.settings },
    inbox: {
      ...fresh.inbox,
      account: fresh.inbox.account ?? stale.inbox.account,
      lastScanAt: lastScans[lastScans.length - 1],
      processedIds: unionStrings(fresh.inbox.processedIds, stale.inbox.processedIds, MAX_PROCESSED_IDS),
      dismissed,
      suggestions: [...suggestions.values()],
    },
    deleted,
    updatedAt: fresh.updatedAt,
  };
}

/**
 * Canonical fingerprint to detect whether a merge actually changed anything
 * (independent of key order and of the order of set-like arrays).
 */
export function fingerprint(d: VaultData): string {
  const byId = <T extends { id: string }>(list: T[]) => [...list].sort((x, y) => x.id.localeCompare(y.id));
  const canonical = {
    shipments: byId(d.shipments.map((s) => ({ ...s, events: byId(s.events), remote: s.remote ? { ...s.remote, events: byId(s.remote.events) } : undefined }))),
    settings: d.settings,
    inbox: {
      ...d.inbox,
      processedIds: [...d.inbox.processedIds].sort(),
      dismissed: [...d.inbox.dismissed].sort(),
      suggestions: [...d.inbox.suggestions].sort((x, y) => x.trackingNumber.localeCompare(y.trackingNumber)),
    },
    deleted: byId(d.deleted),
  };
  return stableStringify(canonical);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

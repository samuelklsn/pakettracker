import { uid } from '../core/id';
import type { MailSuggestion, Shipment, TrackingEvent } from '../core/types';
import {
  EXTRACT_VERSION,
  type MailMessage,
  buildGmailQuery,
  extractFromMail,
  extractOrderInfo,
  inferStatus,
  labelFromSubject,
  senderAddress,
  shipmentLabel,
} from './mail-extract.service';
import { STATUS_META } from './tracking.service';
import type { VaultService } from './vault.service';

/**
 * InboxService – orchestrates a mailbox scan:
 * query → fetch unseen mails → extract → dedupe → auto-add / suggest / update timeline → persist (encrypted).
 */

export interface MailSource {
  listMessageIds(query: string, max?: number): Promise<string[]>;
  getMessage(id: string): Promise<MailMessage>;
}

export interface ScanResult {
  scanned: number;
  added: Shipment[];
  suggested: number;
  updated: number;
  failed: number;
}

const MAX_MESSAGES_PER_SCAN = 50;
const CONCURRENCY = 4;
const OVERLAP_SECONDS = 2 * 86_400;

export async function scanInbox(vault: VaultService, source: MailSource): Promise<ScanResult> {
  const inbox = vault.data.inbox;
  // Better extraction logic → re-read the last 30 days once to enrich existing shipments (no duplicates).
  const upgrade = inbox.extractVersion !== EXTRACT_VERSION;
  const since = inbox.lastScanAt && !upgrade ? Date.parse(inbox.lastScanAt) / 1000 - OVERLAP_SECONDS : undefined;
  const ids = await source.listMessageIds(buildGmailQuery(since), MAX_MESSAGES_PER_SCAN);
  const processed = new Set(upgrade ? [] : inbox.processedIds);
  const fresh = ids.filter((id) => !processed.has(id));

  // fetch with limited concurrency; individual failures don't abort the scan
  const mails: MailMessage[] = [];
  let failed = 0;
  const queue = [...fresh];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          mails.push(await source.getMessage(id));
        } catch {
          failed++;
        }
      }
    }),
  );
  mails.sort((a, b) => a.date.localeCompare(b.date)); // oldest first → newest status wins

  const result: ScanResult = { scanned: mails.length, added: [], suggested: 0, updated: 0, failed };
  const now = new Date().toISOString();

  await vault.update((d) => {
    const byNumber = new Map(d.shipments.map((s) => [s.trackingNumber, s]));
    const dismissed = new Set(d.inbox.dismissed);
    const suggested = new Set(d.inbox.suggestions.map((s) => s.trackingNumber));

    for (const mail of mails) {
      const status = inferStatus(mail.subject);
      const hits = extractFromMail(mail);
      const info = hits.length ? extractOrderInfo(mail) : { items: [] };
      for (const hit of hits) {
        const existing = byNumber.get(hit.trackingNumber);
        if (existing) {
          // Known shipment → add the status from this mail and fill in missing order details
          const evented = !!status && addMailEvent(existing, mail, status);
          const enriched = enrich(existing, info, mail, d.inbox.account);
          if (evented || enriched) {
            existing.updatedAt = now;
            result.updated++;
          }
          continue;
        }
        if (dismissed.has(hit.trackingNumber) || suggested.has(hit.trackingNumber)) continue;

        if (hit.auto) {
          const shipment: Shipment = {
            id: uid(),
            trackingNumber: hit.trackingNumber,
            carrier: hit.carrier,
            label: shipmentLabel(info, mail.subject, hit.carrier),
            labelAuto: true,
            email: senderAddress(mail.from),
            sourceUrl: hit.sourceUrl,
            notes: `Automatisch aus Gmail übernommen (${hit.reason}).`,
            shop: info.shop,
            items: info.items.length ? info.items : undefined,
            orderNumber: info.orderNumber,
            mail: { messageId: mail.id, subject: mail.subject.slice(0, 200), account: d.inbox.account },
            events: [],
            archived: false,
            source: 'gmail',
            createdAt: now,
            updatedAt: now,
          };
          addMailEvent(shipment, mail, status ?? 'pre_transit');
          d.shipments.unshift(shipment);
          byNumber.set(shipment.trackingNumber, shipment);
          result.added.push(shipment);
        } else {
          const suggestion: MailSuggestion = {
            id: uid(),
            trackingNumber: hit.trackingNumber,
            carrier: hit.carrier,
            confidence: hit.confidence,
            reason: hit.reason,
            label: shipmentLabel(info, mail.subject, hit.carrier),
            email: senderAddress(mail.from),
            sourceUrl: hit.sourceUrl,
            messageId: mail.id,
            receivedAt: mail.date,
            shop: info.shop,
            items: info.items.length ? info.items : undefined,
            orderNumber: info.orderNumber,
          };
          d.inbox.suggestions.unshift(suggestion);
          suggested.add(hit.trackingNumber);
          result.suggested++;
        }
      }
    }

    // Only mark successfully fetched mails as processed → failed ones are retried next time.
    const done = mails.map((m) => m.id);
    d.inbox.processedIds = [...done, ...d.inbox.processedIds.filter((id) => !done.includes(id))];
    d.inbox.lastScanAt = failed === 0 ? now : (d.inbox.lastScanAt ?? undefined);
    d.inbox.extractVersion = EXTRACT_VERSION;
  });

  return result;
}

/**
 * Fills in missing order details of an existing shipment. Replaces the label only if it was
 * generated automatically (never overwrites a name the user chose). Returns true if changed.
 */
function enrich(s: Shipment, info: ReturnType<typeof extractOrderInfo>, mail: MailMessage, account?: string): boolean {
  let changed = false;
  if (!s.shop && info.shop) {
    s.shop = info.shop;
    changed = true;
  }
  if (!s.items?.length && info.items.length) {
    s.items = info.items;
    changed = true;
  }
  if (!s.orderNumber && info.orderNumber) {
    s.orderNumber = info.orderNumber;
    changed = true;
  }
  if (!s.mail) {
    s.mail = { messageId: mail.id, subject: mail.subject.slice(0, 200), account };
    changed = true;
  }
  // older versions used the plain subject as label → treat that as auto-generated too
  const auto = s.labelAuto || (s.source === 'gmail' && s.label === labelFromSubject(mail.subject, s.carrier));
  const better = shipmentLabel({ shop: s.shop, items: s.items ?? [], orderNumber: s.orderNumber }, mail.subject, s.carrier);
  if (auto && better !== s.label && (s.items?.length || s.shop)) {
    s.label = better;
    s.labelAuto = true;
    changed = true;
  }
  return changed;
}

function addMailEvent(shipment: Shipment, mail: MailMessage, status: TrackingEvent['status']): boolean {
  const id = `mail-${mail.id}`;
  if (shipment.events.some((e) => e.id === id)) return false;
  shipment.events.push({
    id,
    status,
    at: mail.date,
    title: STATUS_META[status].label,
    description: mail.subject ? `E-Mail: „${mail.subject.slice(0, 140)}“` : 'Aus E-Mail übernommen',
    origin: 'mail',
  });
  return true;
}

/** Turns a suggestion into a shipment. */
export async function acceptSuggestion(vault: VaultService, suggestionId: string): Promise<Shipment | null> {
  let created = null as Shipment | null;
  await vault.update((d) => {
    const idx = d.inbox.suggestions.findIndex((s) => s.id === suggestionId);
    if (idx < 0) return;
    const s = d.inbox.suggestions[idx]!;
    d.inbox.suggestions.splice(idx, 1);
    if (d.shipments.some((x) => x.trackingNumber === s.trackingNumber)) return;
    const now = new Date().toISOString();
    created = {
      id: uid(),
      trackingNumber: s.trackingNumber,
      carrier: s.carrier,
      label: s.label,
      labelAuto: true,
      shop: s.shop,
      items: s.items,
      orderNumber: s.orderNumber,
      mail: { messageId: s.messageId, account: d.inbox.account },
      email: s.email,
      sourceUrl: s.sourceUrl,
      notes: `Aus Gmail übernommen (${s.reason}).`,
      events: [
        {
          id: `mail-${s.messageId}`,
          status: 'pre_transit',
          at: s.receivedAt,
          title: STATUS_META.pre_transit.label,
          description: 'Versand-E-Mail erhalten',
          origin: 'mail',
        },
      ],
      archived: false,
      source: 'gmail',
      createdAt: now,
      updatedAt: now,
    };
    d.shipments.unshift(created);
  });
  return created;
}

/** Rejects a suggestion; the number will never be suggested again. */
export async function dismissSuggestion(vault: VaultService, suggestionId: string): Promise<void> {
  await vault.update((d) => {
    const idx = d.inbox.suggestions.findIndex((s) => s.id === suggestionId);
    if (idx < 0) return;
    const [s] = d.inbox.suggestions.splice(idx, 1);
    if (s) d.inbox.dismissed = [s.trackingNumber, ...d.inbox.dismissed.filter((n) => n !== s.trackingNumber)];
  });
}

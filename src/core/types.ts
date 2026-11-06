/**
 * Domain model. Everything in `VaultData` is persisted ONLY in encrypted form.
 */

export type CarrierId = 'dhl' | 'ups' | 'dpd' | 'hermes' | 'other';

/** Normalised shipment lifecycle, ordered from first to last stage. */
export type ShipmentStatus =
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception';

export interface TrackingEvent {
  id: string;
  status: ShipmentStatus;
  /** ISO-8601 timestamp */
  at: string;
  title: string;
  description?: string;
  location?: string;
  /** `manual` = entered by the user, `remote` = tracking API, `mail` = derived from an e-mail */
  origin: 'manual' | 'remote' | 'system' | 'mail';
}

export interface Shipment {
  id: string;
  trackingNumber: string;
  carrier: CarrierId;
  label: string;
  email?: string;
  sourceUrl?: string;
  notes?: string;
  /** Manually maintained timeline (fallback when no API is connected) */
  events: TrackingEvent[];
  /** Last result returned by a remote tracking provider (cached, encrypted) */
  remote?: {
    fetchedAt: string;
    status: ShipmentStatus;
    events: TrackingEvent[];
    estimatedDelivery?: string;
  };
  archived: boolean;
  /** How the shipment was created */
  source?: 'manual' | 'gmail';
  /** Shop / sender, e.g. "Amazon.de" */
  shop?: string;
  /** Ordered items extracted from the mail */
  items?: string[];
  orderNumber?: string;
  /** Reference to the notification mail (opens it in Gmail) */
  mail?: { messageId: string; subject?: string; account?: string };
  /** true while the label was generated automatically (may be improved by later scans) */
  labelAuto?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Order details extracted from a notification mail. */
export interface OrderInfo {
  shop?: string;
  items: string[];
  orderNumber?: string;
}

/** A tracking number found in an e-mail that needs user confirmation. */
export interface MailSuggestion {
  id: string;
  trackingNumber: string;
  carrier: CarrierId;
  /** 0..1 */
  confidence: number;
  reason: string;
  label: string;
  email?: string;
  sourceUrl?: string;
  messageId: string;
  receivedAt: string;
  shop?: string;
  items?: string[];
  orderNumber?: string;
}

/** Mailbox integration state – stored encrypted inside the vault. */
export interface InboxState {
  provider: 'gmail';
  enabled: boolean;
  /** Connected account (e-mail address) – used as login hint */
  account?: string;
  /** Auto-scan interval while the app is open. 0 = manual only. */
  autoScanMinutes: number;
  lastScanAt?: string;
  /** Gmail message IDs that were already analysed (newest first, capped) */
  processedIds: string[];
  /** Tracking numbers the user rejected – never suggested again */
  dismissed: string[];
  suggestions: MailSuggestion[];
  /** Version of the extraction logic used for processedIds (a bump triggers a one-time re-scan) */
  extractVersion?: number;
}

export interface VaultSettings {
  /** Auto-lock after N minutes of inactivity. 0 disables auto-lock. */
  autoLockMinutes: number;
}

/** Maximum number of deletion tombstones kept in a vault. */
export const MAX_TOMBSTONES = 2000;

/** Marks a deleted shipment so the deletion survives a sync merge. */
export interface Tombstone {
  id: string;
  /** ISO timestamp of the deletion */
  at: string;
}

export interface VaultData {
  schema: 1;
  shipments: Shipment[];
  settings: VaultSettings;
  inbox: InboxState;
  /** Deleted shipment IDs (capped) – needed for multi-device sync */
  deleted: Tombstone[];
  /** Last modification of this data set (ISO) – decides settings conflicts when syncing */
  updatedAt: string;
}

export const DEFAULT_SETTINGS: VaultSettings = { autoLockMinutes: 10 };

export function createDefaultInbox(): InboxState {
  return { provider: 'gmail', enabled: false, autoScanMinutes: 15, processedIds: [], dismissed: [], suggestions: [] };
}

export function createEmptyVault(): VaultData {
  return {
    schema: 1,
    shipments: [],
    settings: { ...DEFAULT_SETTINGS },
    inbox: createDefaultInbox(),
    deleted: [],
    updatedAt: new Date().toISOString(),
  };
}

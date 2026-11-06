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
  /** `manual` = entered by the user, `remote` = delivered by the tracking API */
  origin: 'manual' | 'remote' | 'system';
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
  createdAt: string;
  updatedAt: string;
}

export interface VaultSettings {
  /** Auto-lock after N minutes of inactivity. 0 disables auto-lock. */
  autoLockMinutes: number;
}

export interface VaultData {
  schema: 1;
  shipments: Shipment[];
  settings: VaultSettings;
}

export const DEFAULT_SETTINGS: VaultSettings = { autoLockMinutes: 10 };

export function createEmptyVault(): VaultData {
  return { schema: 1, shipments: [], settings: { ...DEFAULT_SETTINGS } };
}

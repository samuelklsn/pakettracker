import { describe, expect, it } from 'vitest';
import type { Shipment } from '../src/core/types';
import { buildTimeline, deriveStatus } from '../src/services/tracking.service';

const base: Shipment = {
  id: 's1',
  trackingNumber: '00340434161234567890',
  carrier: 'dhl',
  label: 'Test',
  events: [],
  archived: false,
  createdAt: '2026-11-06T10:00:30.000Z',
  updatedAt: '2026-11-06T10:00:30.000Z',
};

describe('Tracking timeline', () => {
  it('defaults to pre_transit without events', () => {
    expect(deriveStatus(base)).toBe('pre_transit');
    expect(buildTimeline(base)).toHaveLength(1);
  });

  it('uses the newest real event – even if back-dated before creation', () => {
    const s: Shipment = {
      ...base,
      events: [
        { id: 'a', status: 'in_transit', at: '2026-11-05T08:00:00.000Z', title: 'Unterwegs', origin: 'manual' },
        { id: 'b', status: 'out_for_delivery', at: '2026-11-06T10:00:00.000Z', title: 'In Zustellung', origin: 'manual' },
      ],
    };
    expect(deriveStatus(s)).toBe('out_for_delivery');
    const timeline = buildTimeline(s);
    expect(timeline.map((e) => e.id)).toEqual(['b', 'a', 's1-created']);
  });

  it('treats later-added events with equal timestamps as newer', () => {
    const at = '2026-11-06T11:00:00.000Z';
    const s: Shipment = {
      ...base,
      events: [
        { id: 'a', status: 'out_for_delivery', at, title: 'x', origin: 'manual' },
        { id: 'b', status: 'delivered', at, title: 'y', origin: 'manual' },
      ],
    };
    expect(deriveStatus(s)).toBe('delivered');
  });
});

import type { CarrierId, ShipmentStatus } from '../../core/types';
import { CARRIERS } from '../../services/carriers';
import { STATUS_META } from '../../services/tracking.service';
import { cx, h } from '../dom';

export function carrierBadge(carrier: CarrierId, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const c = CARRIERS[carrier];
  const dims = { sm: 'size-7 text-[9px] rounded-lg', md: 'size-10 text-[11px] rounded-xl', lg: 'size-12 text-xs rounded-2xl' }[size];
  const el = h(
    'span',
    {
      class: cx('inline-flex shrink-0 items-center justify-center font-extrabold tracking-tight ring-1 ring-black/10 ring-inset', dims),
      attrs: { title: c.name, 'aria-label': c.name },
    },
    c.short,
  );
  // Colours applied via CSSOM (CSP-safe, no inline style attributes in markup)
  el.style.backgroundColor = c.color;
  el.style.color = c.textColor;
  return el;
}

export function statusBadge(status: ShipmentStatus, pulse = false): HTMLElement {
  const meta = STATUS_META[status];
  return h(
    'span',
    { class: cx('chip', `tone-${meta.tone}`) },
    h('span', { class: cx('size-1.5 rounded-full', `dot-${meta.tone}`, pulse && 'animate-pulse') }),
    meta.short,
  );
}

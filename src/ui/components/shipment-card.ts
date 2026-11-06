import type { Shipment } from '../../core/types';
import { CARRIERS } from '../../services/carriers';
import { STATUS_META, STATUS_ORDER, buildTimeline, deriveStatus, statusProgress } from '../../services/tracking.service';
import { cx, h } from '../dom';
import { formatRelative, groupTrackingNumber } from '../format';
import { icon } from '../icons';
import { carrierBadge, statusBadge } from './carrier-badge';

export function shipmentCard(s: Shipment, onOpen: (s: Shipment) => void): HTMLElement {
  const status = deriveStatus(s);
  const progress = statusProgress(status);
  const latest = buildTimeline(s)[0];
  const tone = STATUS_META[status].tone;

  return h(
    'button',
    {
      type: 'button',
      class: cx(
        'glass group w-full min-w-0 rounded-2xl p-4 text-left transition duration-200 animate-pop-in',
        'hover:-translate-y-0.5 hover:border-line-strong hover:bg-elevated focus-visible:-translate-y-0.5',
        s.archived && 'opacity-60',
      ),
      attrs: { 'aria-label': `${s.label}, ${CARRIERS[s.carrier].name}, ${STATUS_META[status].label}` },
      onClick: () => onOpen(s),
    },
    h(
      'div',
      { class: 'flex items-start gap-3' },
      carrierBadge(s.carrier),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('p', { class: 'truncate text-sm font-semibold text-fg' }, s.label),
        (s.shop && !s.label.includes(s.shop)) || (s.items?.length ?? 0) > 1
          ? h(
              'p',
              { class: 'mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted' },
              s.shop && !s.label.includes(s.shop)
                ? h('span', { class: 'inline-flex min-w-0 items-center gap-1 font-medium text-fg/80' }, icon('box', 'size-3 shrink-0'), h('span', { class: 'truncate' }, s.shop))
                : null,
              s.shop && !s.label.includes(s.shop) && (s.items?.length ?? 0) > 1 ? h('span', { class: 'text-subtle' }, '·') : null,
              (s.items?.length ?? 0) > 1 ? h('span', { class: 'shrink-0' }, `${s.items!.length} Artikel`) : null,
            )
          : null,
        h('p', { class: 'mt-0.5 truncate font-mono text-xs text-subtle' }, groupTrackingNumber(s.trackingNumber)),
      ),
      statusBadge(status, status === 'out_for_delivery'),
    ),
    h(
      'div',
      { class: 'mt-4 flex gap-1.5', attrs: { 'aria-hidden': 'true' } },
      ...STATUS_ORDER.map((_, i) =>
        h('span', {
          class: cx(
            'h-1.5 flex-1 rounded-full transition-colors',
            status === 'exception' ? (i === 0 ? 'dot-rose' : 'bg-fg/10') : i <= progress ? `dot-${tone}` : 'bg-fg/10',
          ),
        }),
      ),
    ),
    h(
      'div',
      { class: 'mt-3 flex items-center justify-between gap-3 text-xs text-subtle' },
      h('span', { class: 'truncate' }, latest ? `${latest.title} · ${formatRelative(latest.at)}` : ''),
      h(
        'span',
        { class: 'flex shrink-0 items-center gap-1.5' },
        s.notes ? icon('note', 'size-3.5') : null,
        s.email ? icon('mail', 'size-3.5') : null,
        h('span', { class: 'transition group-hover:translate-x-0.5 group-hover:text-fg' }, icon('chevronRight', 'size-4')),
      ),
    ),
  );
}

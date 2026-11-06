import type { ShipmentStatus, TrackingEvent } from '../../core/types';
import { STATUS_META, STATUS_ORDER, statusProgress } from '../../services/tracking.service';
import { cx, h } from '../dom';
import { formatDay, formatDateTime } from '../format';
import { icon, type IconName } from '../icons';

const STAGE_ICONS: Record<ShipmentStatus, IconName> = {
  pre_transit: 'packageOpen',
  in_transit: 'truck',
  out_for_delivery: 'pin',
  delivered: 'packageCheck',
  exception: 'warning',
};

/** Horizontal 4-stage progress stepper (Apple-style). */
export function progressStepper(status: ShipmentStatus): HTMLElement {
  const current = statusProgress(status);
  const exception = status === 'exception';
  return h(
    'ol',
    { class: 'grid grid-cols-4 gap-2', attrs: { 'aria-label': 'Sendungsfortschritt' } },
    ...STATUS_ORDER.map((stage, i) => {
      const done = !exception && i <= current;
      const active = !exception && i === current;
      const tone = STATUS_META[stage].tone;
      return h(
        'li',
        { class: 'flex flex-col gap-2', attrs: { 'aria-current': active ? 'step' : undefined } },
        h('div', {
          class: cx(
            'h-1.5 rounded-full transition-colors duration-500',
            done ? `dot-${tone}` : exception && i === 0 ? 'dot-rose' : 'bg-fg/10',
          ),
        }),
        h(
          'div',
          { class: cx('flex items-center gap-1.5 text-[11px] font-medium', done ? 'text-fg' : 'text-subtle') },
          icon(STAGE_ICONS[stage], 'size-3.5'),
          h('span', { class: cx('truncate', !active && 'hidden sm:inline') }, STATUS_META[stage].short),
        ),
      );
    }),
  );
}

/** Vertical timeline grouped by day, newest first. */
export function timeline(events: TrackingEvent[]): HTMLElement {
  const groups = new Map<string, TrackingEvent[]>();
  for (const e of events) {
    const day = new Date(e.at).toDateString();
    const list = groups.get(day) ?? [];
    list.push(e);
    groups.set(day, list);
  }

  let index = 0;
  const root = h('div', { class: 'space-y-6' });
  for (const list of groups.values()) {
    const first = list[0]!;
    root.append(
      h(
        'section',
        null,
        h('h4', { class: 'mb-3 text-xs font-semibold tracking-wider text-subtle uppercase' }, formatDay(first.at)),
        h(
          'ol',
          { class: 'relative' },
          ...list.map((e) => {
            const isLatest = index === 0;
            const isLast = index === events.length - 1;
            index++;
            return timelineItem(e, isLatest, isLast);
          }),
        ),
      ),
    );
  }
  return root;
}

function timelineItem(e: TrackingEvent, latest: boolean, last: boolean): HTMLElement {
  const meta = STATUS_META[e.status];
  return h(
    'li',
    { class: 'relative flex gap-4 pb-6 last:pb-0' },
    // connector line
    !last ? h('span', { class: 'absolute top-7 bottom-0 left-3 w-px -translate-x-1/2 bg-line-strong', attrs: { 'aria-hidden': 'true' } }) : null,
    h(
      'span',
      {
        class: cx(
          'relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border',
          latest ? cx(`tone-${meta.tone}`, 'animate-pulse-ring') : 'border-line-strong bg-elevated text-subtle',
        ),
      },
      latest ? icon(STAGE_ICONS[e.status], 'size-3.5', 2) : h('span', { class: 'size-1.5 rounded-full bg-current' }),
    ),
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h(
        'div',
        { class: 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5' },
        h('p', { class: cx('text-sm font-medium', latest ? 'text-fg' : 'text-fg/85') }, e.title),
        h('time', { class: 'text-xs text-subtle tabular-nums', attrs: { datetime: e.at } }, formatDateTime(e.at)),
      ),
      e.description ? h('p', { class: 'mt-0.5 text-sm text-muted' }, e.description) : null,
      h(
        'div',
        { class: 'mt-1.5 flex flex-wrap items-center gap-2 text-xs text-subtle' },
        e.location ? h('span', { class: 'inline-flex items-center gap-1' }, icon('pin', 'size-3'), e.location) : null,
        e.origin === 'manual' ? h('span', { class: 'inline-flex items-center gap-1' }, icon('pencil', 'size-3'), 'Manuell') : null,
        e.origin === 'remote' ? h('span', { class: 'inline-flex items-center gap-1' }, icon('refresh', 'size-3'), 'Live') : null,
      ),
    ),
  );
}

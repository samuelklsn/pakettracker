import { h } from '../dom';

export function shipmentCardSkeleton(): HTMLElement {
  return h(
    'div',
    { class: 'glass rounded-2xl p-4', attrs: { 'aria-hidden': 'true' } },
    h(
      'div',
      { class: 'flex items-center gap-3' },
      h('div', { class: 'skeleton size-10 rounded-xl' }),
      h('div', { class: 'flex-1 space-y-2' }, h('div', { class: 'skeleton h-3.5 w-2/5' }), h('div', { class: 'skeleton h-3 w-3/5' })),
      h('div', { class: 'skeleton h-6 w-20 rounded-full' }),
    ),
    h('div', { class: 'mt-4 flex gap-1.5' }, ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton h-1.5 flex-1 rounded-full' }))),
    h('div', { class: 'mt-3 skeleton h-3 w-1/3' }),
  );
}

export function listSkeleton(count = 3): HTMLElement {
  return h(
    'div',
    { class: 'grid gap-3 sm:grid-cols-2', attrs: { role: 'status', 'aria-label': 'Sendungen werden geladen' } },
    ...Array.from({ length: count }, shipmentCardSkeleton),
  );
}

export function timelineSkeleton(rows = 4): HTMLElement {
  return h(
    'div',
    { class: 'space-y-6 py-2', attrs: { role: 'status', 'aria-label': 'Tracking-Daten werden geladen' } },
    ...Array.from({ length: rows }, (_, i) =>
      h(
        'div',
        { class: 'flex gap-4' },
        h('div', { class: 'skeleton mt-0.5 size-6 shrink-0 rounded-full' }),
        h(
          'div',
          { class: 'flex-1 space-y-2' },
          h('div', { class: `skeleton h-3.5 ${i % 2 ? 'w-1/2' : 'w-2/3'}` }),
          h('div', { class: 'skeleton h-3 w-1/3' }),
        ),
      ),
    ),
  );
}

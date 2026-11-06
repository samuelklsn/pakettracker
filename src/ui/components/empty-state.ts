import { h } from '../dom';
import { icon, type IconName } from '../icons';

export function emptyState(opts: {
  icon: IconName;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  hints?: string[];
}): HTMLElement {
  return h(
    'div',
    { class: 'glass flex flex-col items-center rounded-3xl border-dashed px-6 py-14 text-center animate-fade-in' },
    h(
      'div',
      { class: 'relative mb-5' },
      h('div', { class: 'absolute inset-0 rounded-3xl bg-accent/20 blur-2xl' }),
      h(
        'div',
        { class: 'relative flex size-16 items-center justify-center rounded-2xl border border-line-strong bg-elevated text-accent' },
        icon(opts.icon, 'size-7', 1.5),
      ),
    ),
    h('h3', { class: 'text-base font-semibold text-fg' }, opts.title),
    h('p', { class: 'mt-1.5 max-w-sm text-sm text-muted' }, opts.description),
    opts.hints?.length
      ? h(
          'div',
          { class: 'mt-5 flex flex-wrap justify-center gap-2' },
          ...opts.hints.map((t) => h('span', { class: 'chip font-mono text-[11px] text-muted' }, t)),
        )
      : null,
    opts.action ? h('button', { class: 'btn-secondary mt-6', onClick: opts.action.onClick }, icon('plus'), opts.action.label) : null,
  );
}

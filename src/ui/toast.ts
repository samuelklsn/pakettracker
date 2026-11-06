import { h } from './dom';
import { icon, type IconName } from './icons';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

const META: Record<ToastKind, { icon: IconName; cls: string; role: 'status' | 'alert' }> = {
  success: { icon: 'check', cls: 'text-emerald-400', role: 'status' },
  error: { icon: 'error', cls: 'text-rose-400', role: 'alert' },
  warning: { icon: 'warning', cls: 'text-amber-400', role: 'alert' },
  info: { icon: 'info', cls: 'text-sky-400', role: 'status' },
};

const MAX_VISIBLE = 4;

export function toast(kind: ToastKind, title: string, description?: string, durationMs = kind === 'error' ? 6000 : 3800): void {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const meta = META[kind];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.remove('animate-toast-in');
    el.classList.add('animate-toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };

  const el = h(
    'div',
    {
      class: 'glass pointer-events-auto flex w-full max-w-sm animate-toast-in items-start gap-3 rounded-2xl bg-elevated p-4',
      attrs: { role: meta.role },
      onMouseenter: () => clearTimeout(timer),
      onMouseleave: () => (timer = setTimeout(dismiss, 1800)),
    },
    h('span', { class: `mt-0.5 ${meta.cls}` }, icon(meta.icon, 'size-5')),
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h('p', { class: 'text-sm font-medium text-fg' }, title),
      description ? h('p', { class: 'mt-0.5 text-sm text-muted' }, description) : null,
    ),
    h('button', { class: 'icon-btn -m-2 size-8', attrs: { 'aria-label': 'Schließen' }, onClick: dismiss }, icon('x')),
  );

  root.appendChild(el);
  while (root.children.length > MAX_VISIBLE) root.firstElementChild?.remove();
  timer = setTimeout(dismiss, durationMs);
}

export const notify = {
  success: (t: string, d?: string) => toast('success', t, d),
  error: (t: string, d?: string) => toast('error', t, d),
  info: (t: string, d?: string) => toast('info', t, d),
  warning: (t: string, d?: string) => toast('warning', t, d),
};

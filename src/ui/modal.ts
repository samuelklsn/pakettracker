import { cx, h } from './dom';
import { icon } from './icons';

export interface ModalHandle {
  close: () => void;
  panel: HTMLElement;
  body: HTMLElement;
}

export interface ModalOptions {
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  /** render as right-hand side drawer on ≥ md screens */
  variant?: 'dialog' | 'drawer';
  onClose?: () => void;
}

/** Stack of open modals – only the topmost one reacts to keyboard input. */
const stack: HTMLElement[] = [];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible modal: focus trap, ESC to close, restores focus, scroll lock. */
export function openModal(opts: ModalOptions, render: (body: HTMLElement, close: () => void) => void): ModalHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const titleId = `m-${Math.random().toString(36).slice(2)}`;
  const drawer = opts.variant === 'drawer';
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[opts.size ?? 'md'];

  const body = h('div', { class: 'min-h-0 flex-1 overflow-y-auto px-6 pb-6' });
  const panel = h(
    'div',
    {
      class: cx(
        'glass relative flex w-full flex-col bg-elevated outline-none',
        drawer
          ? 'mt-auto max-h-[92dvh] animate-pop-in rounded-t-3xl md:mt-0 md:ml-auto md:h-dvh md:max-h-none md:max-w-xl md:animate-slide-in md:rounded-none md:rounded-l-3xl'
          : cx('max-h-[90dvh] animate-pop-in rounded-3xl', width),
      ),
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    },
    h(
      'header',
      { class: 'flex items-start gap-4 px-6 pt-6 pb-4' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('h2', { id: titleId, class: 'text-lg font-semibold tracking-tight text-fg' }, opts.title),
        opts.description ? h('p', { class: 'mt-1 text-sm text-muted' }, opts.description) : null,
      ),
      h('button', { class: 'icon-btn -mt-1 -mr-2', attrs: { 'aria-label': 'Schließen' }, onClick: () => close() }, icon('x', 'size-5')),
    ),
    body,
  );

  const overlay = h(
    'div',
    {
      class: cx(
        'fixed inset-0 z-50 flex animate-fade-in bg-black/60 backdrop-blur-sm',
        drawer ? 'items-end md:items-stretch' : 'items-center justify-center p-4',
      ),
      onMousedown: (e: MouseEvent) => {
        if (e.target === overlay) close();
      },
    },
    panel,
  );

  const onKey = (e: KeyboardEvent) => {
    if (stack[stack.length - 1] !== overlay) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        items[0]!.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    const idx = stack.indexOf(overlay);
    if (idx >= 0) stack.splice(idx, 1);
    if (stack.length === 0) document.body.style.overflow = '';
    // restore focus; if the trigger was re-rendered meanwhile, fall back to the underlying modal
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    else stack[stack.length - 1]?.querySelector<HTMLElement>('[role="dialog"]')?.focus();
    opts.onClose?.();
  }

  document.addEventListener('keydown', onKey);
  render(body, close);
  document.body.appendChild(overlay);
  stack.push(overlay);
  document.body.style.overflow = 'hidden';
  queueMicrotask(() => {
    const autofocus = panel.querySelector<HTMLElement>('[autofocus]') ?? panel;
    autofocus.focus();
  });

  return { close, panel, body };
}

/** Promise-based confirmation dialog. */
export function confirmDialog(opts: {
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openModal({ title: opts.title, description: opts.description, size: 'sm', onClose: () => resolve(result) }, (body, close) => {
      body.append(
        h(
          'div',
          { class: 'flex justify-end gap-2 pt-2' },
          h('button', { class: 'btn-ghost', onClick: close }, 'Abbrechen'),
          h(
            'button',
            {
              class: opts.danger ? 'btn-danger' : 'btn-primary',
              attrs: { autofocus: true },
              onClick: () => {
                result = true;
                close();
              },
            },
            opts.confirmLabel,
          ),
        ),
      );
    });
  });
}

/** Closes every open modal (used when the vault gets locked). */
export function closeAllModals(): void {
  for (const overlay of [...stack].reverse()) {
    overlay.querySelector<HTMLButtonElement>('header button[aria-label="Schließen"]')?.click();
  }
}

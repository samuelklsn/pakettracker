import { cx, h } from '../dom';
import { icon } from '../icons';

export interface PasswordFieldOptions {
  placeholder: string;
  autocomplete: 'current-password' | 'new-password';
  autofocus?: boolean;
  strength?: boolean;
  label?: string;
}

/** Heuristic strength score 0–4 (no external dictionary, nothing leaves the device). */
export function passwordScore(pw: string): number {
  if (!pw) return 0;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  const unique = new Set(pw).size;
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (classes >= 3) score++;
  if (pw.length >= 18 || (classes === 4 && pw.length >= 12)) score++;
  if (unique < pw.length / 3 || /^(.)\1+$/.test(pw)) score = Math.min(score, 1);
  return Math.min(4, score);
}

const LABELS = ['Zu kurz', 'Schwach', 'Okay', 'Gut', 'Sehr stark'];
const COLORS = ['bg-rose-500', 'bg-rose-500', 'bg-amber-400', 'bg-emerald-400', 'bg-emerald-400'];

export function passwordField(opts: PasswordFieldOptions): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    class: 'field pr-11 font-mono tracking-wide',
    type: 'password',
    required: true,
    attrs: {
      placeholder: opts.placeholder,
      autocomplete: opts.autocomplete,
      autofocus: opts.autofocus,
      spellcheck: 'false',
      autocapitalize: 'off',
      'aria-label': opts.label ?? opts.placeholder,
      maxlength: 1024,
    },
  });
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn absolute top-1/2 right-0.5 size-10 -translate-y-1/2',
      attrs: { 'aria-label': 'Passwort anzeigen', 'aria-pressed': 'false' },
      onClick: () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', String(show));
        toggle.setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
        toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
        input.focus();
      },
    },
    icon('eye'),
  );

  const wrap = h('div', { class: 'space-y-2' }, h('div', { class: 'relative' }, input, toggle));

  if (opts.strength) {
    const bars = Array.from({ length: 4 }, () => h('span', { class: 'h-1 flex-1 rounded-full bg-fg/10 transition-colors' }));
    const text = h('span', { class: 'w-20 text-right text-[11px] text-subtle' });
    const meter = h('div', { class: 'flex items-center gap-2', attrs: { 'aria-live': 'polite' } }, h('div', { class: 'flex flex-1 gap-1' }, ...bars), text);
    const update = () => {
      const score = passwordScore(input.value);
      bars.forEach((b, i) => (b.className = cx('h-1 flex-1 rounded-full transition-colors', i < score ? COLORS[score] : 'bg-fg/10')));
      text.textContent = input.value ? (LABELS[score] ?? '') : '';
    };
    input.addEventListener('input', update);
    wrap.append(meter);
  }
  return { el: wrap, input };
}

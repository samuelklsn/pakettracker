import type { CarrierId } from '../../core/types';
import { CARRIERS } from '../../services/carriers';
import { type DetectionResult, detect } from '../../services/detection.service';
import { cx, h } from '../dom';
import { icon, type IconName } from '../icons';
import { carrierBadge } from './carrier-badge';

export interface SmartInputOptions {
  onSubmit: (detection: DetectionResult, carrier: CarrierId | null) => void;
  /** live text for filtering the list */
  onQuery: (query: string, detection: DetectionResult) => void;
  /** returns the label of an existing shipment with this number, if any */
  findExisting: (trackingNumber: string) => string | null;
}

const KIND_META: Record<DetectionResult['kind'], { icon: IconName; label: string; tone: string }> = {
  empty: { icon: 'search', label: '', tone: 'text-subtle' },
  email: { icon: 'mail', label: 'E-Mail-Adresse erkannt', tone: 'text-sky-400' },
  url: { icon: 'link', label: 'Tracking-Link erkannt', tone: 'text-violet-400' },
  tracking: { icon: 'hash', label: 'Sendungsnummer erkannt', tone: 'text-emerald-400' },
  unknown: { icon: 'search', label: 'Kein bekanntes Format', tone: 'text-subtle' },
};

export function smartInput(opts: SmartInputOptions): { el: HTMLElement; focus: () => void; reset: () => void } {
  let current: DetectionResult = detect('');
  let selected: CarrierId | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const leading = h('span', { class: 'pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 transition-colors' });
  const input = h('input', {
    class:
      'h-14 w-full rounded-2xl border border-line-strong bg-field pr-16 pl-12 sm:pr-40 text-base text-fg placeholder:text-subtle shadow-inner outline-none transition focus:border-accent/60 focus:ring-4 focus:ring-accent/15 sm:text-[15px]',
    type: 'text',
    attrs: {
      placeholder: 'Sendungsnummer, Tracking-Link oder E-Mail einfügen …',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-label': 'Smart Input: Sendungsnummer, Link oder E-Mail',
      'aria-describedby': 'smart-input-hint',
      enterkeyhint: 'go',
      maxlength: 2048,
    },
  });
  const submit = h(
    'button',
    { class: 'btn-accent absolute top-1/2 right-2 h-10 -translate-y-1/2 rounded-xl px-3 sm:px-4', type: 'submit', attrs: { 'aria-label': 'Hinzufügen' } },
    icon('plus'),
    h('span', { class: 'hidden sm:inline' }, 'Hinzufügen'),
  );
  const shortcut = h('span', { class: 'kbd pointer-events-none absolute top-1/2 right-36 mr-1 hidden -translate-y-1/2 sm:inline' }, '/');
  const hint = h('div', { id: 'smart-input-hint', class: 'min-h-9 px-1 pt-3', attrs: { 'aria-live': 'polite' } });

  const form = h(
    'form',
    {
      class: 'relative',
      attrs: { role: 'search', novalidate: true },
      onSubmit: (e: SubmitEvent) => {
        e.preventDefault();
        evaluate();
        if (current.kind === 'empty') {
          input.focus();
          return;
        }
        opts.onSubmit(current, selected ?? current.candidates[0]?.carrier ?? null);
      },
    },
    h('div', { class: 'relative' }, leading, input, shortcut, submit),
    hint,
  );

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(evaluate, 60);
  });
  input.addEventListener('paste', () => setTimeout(evaluate, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      reset();
    }
  });

  function evaluate() {
    const next = detect(input.value);
    if (next.trackingNumber !== current.trackingNumber || next.kind !== current.kind) selected = null;
    current = next;
    renderHint();
    opts.onQuery(input.value.trim(), current);
  }

  function renderHint() {
    const meta = KIND_META[current.kind];
    leading.className = cx('pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 transition-colors', meta.tone);
    leading.replaceChildren(icon(meta.icon, 'size-5'));
    shortcut.classList.toggle('sm:inline', current.kind === 'empty');

    if (current.kind === 'empty') {
      hint.replaceChildren(
        h(
          'p',
          { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle' },
          h('span', { class: 'inline-flex items-center gap-1' }, icon('sparkles', 'size-3.5 text-accent'), 'Automatische Erkennung für'),
          ...(['dhl', 'ups', 'dpd', 'hermes'] as const).map((c) => h('span', { class: 'font-medium text-muted' }, CARRIERS[c].name)),
          h('span', null, '· Links · E-Mails'),
        ),
      );
      return;
    }

    const row = h('div', { class: 'flex flex-wrap items-center gap-2 animate-fade-in' });
    row.append(h('span', { class: cx('inline-flex items-center gap-1.5 text-xs font-medium', meta.tone) }, icon(meta.icon, 'size-3.5'), meta.label));

    if (current.kind === 'email') {
      row.append(h('span', { class: 'text-xs text-muted' }, '→ Wird als Kontakt-E-Mail einer neuen Sendung hinterlegt'));
    }
    if (current.kind === 'unknown') {
      row.append(
        h(
          'span',
          { class: 'text-xs text-muted' },
          current.trackingNumber ? '→ Filtert deine Liste · Enter fügt die Nummer mit manueller Carrier-Wahl hinzu' : '→ Durchsucht deine Sendungen',
        ),
      );
    }
    if (current.trackingNumber && current.kind !== 'unknown') {
      row.append(h('code', { class: 'chip font-mono text-[11px] text-fg' }, current.trackingNumber));
    }

    if (current.candidates.length) {
      const chosen = selected ?? current.candidates[0]!.carrier;
      const group = h('div', { class: 'flex flex-wrap items-center gap-1.5', attrs: { role: 'radiogroup', 'aria-label': 'Carrier auswählen' } });
      current.candidates.slice(0, 4).forEach((c) => {
        const active = c.carrier === chosen;
        group.append(
          h(
            'button',
            {
              type: 'button',
              class: cx(
                'chip gap-2 py-0.5 pr-2.5 pl-0.5 transition',
                active ? 'border-accent/50 bg-accent/10 text-fg' : 'text-muted hover:border-line-strong hover:text-fg',
              ),
              attrs: { role: 'radio', 'aria-checked': String(active), title: c.reason },
              onClick: () => {
                selected = c.carrier;
                renderHint();
                input.focus();
              },
            },
            carrierBadge(c.carrier, 'sm'),
            CARRIERS[c.carrier].name,
            h('span', { class: 'font-mono text-[10px] text-subtle tabular-nums' }, `${Math.round(c.confidence * 100)}%`),
          ),
        );
      });
      row.append(group);
    }

    const existing = current.trackingNumber ? opts.findExisting(current.trackingNumber) : null;
    if (existing) {
      row.append(
        h('span', { class: 'chip tone-amber' }, icon('info', 'size-3.5'), `Bereits im Tresor: ${existing}`),
      );
    }
    hint.replaceChildren(row);
  }

  function reset() {
    input.value = '';
    evaluate();
  }

  renderHint();

  return {
    el: form,
    focus: () => input.focus(),
    reset,
  };
}

import type { InboxState, MailSuggestion } from '../../core/types';
import { CARRIERS } from '../../services/carriers';
import { cx, h } from '../dom';
import { formatRelative, groupTrackingNumber } from '../format';
import { icon } from '../icons';
import { carrierBadge } from './carrier-badge';

export interface InboxPanelProps {
  inbox: InboxState;
  tokenValid: boolean;
  scanning: boolean;
  onConnect: () => void;
  onScan: () => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onAcceptAll: () => void;
}

/** Dashboard panel: Gmail connection status + suggestions waiting for confirmation. */
export function inboxPanel(p: InboxPanelProps): HTMLElement {
  if (!p.inbox.enabled) return connectCta(p);

  const { inbox } = p;
  const status = p.scanning
    ? 'Durchsuche Postfach …'
    : inbox.lastScanAt
      ? `Zuletzt gescannt ${formatRelative(inbox.lastScanAt)}`
      : 'Noch nicht gescannt';

  const action = p.scanning
    ? h('button', { class: 'btn-secondary h-9 rounded-lg px-3', type: 'button', disabled: true }, icon('loader', 'size-4 animate-spin'), 'Scanne …')
    : p.tokenValid
      ? h('button', { class: 'btn-secondary h-9 rounded-lg px-3', type: 'button', onClick: p.onScan }, icon('refresh'), 'Jetzt scannen')
      : h('button', { class: 'btn-accent h-9 rounded-lg px-3', type: 'button', onClick: p.onConnect }, icon('mail'), 'Verbinden & scannen');

  return h(
    'section',
    { class: 'glass animate-fade-in rounded-2xl', attrs: { 'aria-label': 'Postfach' } },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-3 p-4' },
      h(
        'span',
        { class: cx('relative flex size-9 items-center justify-center rounded-xl border border-line-strong bg-elevated', p.tokenValid ? 'text-emerald-400' : 'text-subtle') },
        icon('mail'),
        p.tokenValid ? h('span', { class: 'absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-bg bg-emerald-400' }) : null,
      ),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('p', { class: 'truncate text-sm font-medium text-fg' }, `Gmail${inbox.account ? ` · ${inbox.account}` : ''}`),
        h(
          'p',
          { class: 'truncate text-xs text-subtle' },
          p.tokenValid
            ? `${status}${inbox.autoScanMinutes ? ` · Auto-Scan alle ${inbox.autoScanMinutes} min` : ''}`
            : `${status} · Verbindung abgelaufen – zum Scannen erneut verbinden`,
        ),
      ),
      action,
    ),
    inbox.suggestions.length ? suggestionList(p, inbox.suggestions) : null,
  );
}

function connectCta(p: InboxPanelProps): HTMLElement {
  return h(
    'section',
    { class: 'glass flex flex-wrap items-center gap-3 rounded-2xl p-4 animate-fade-in' },
    h('span', { class: 'flex size-9 items-center justify-center rounded-xl border border-line-strong bg-elevated text-accent' }, icon('sparkles')),
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h('p', { class: 'text-sm font-medium text-fg' }, 'Gmail verbinden'),
      h('p', { class: 'text-xs text-subtle' }, 'Sendungsnummern automatisch aus Versand-E-Mails übernehmen – nur Lesezugriff, direkt im Browser.'),
    ),
    h('button', { class: 'btn-secondary h-9 rounded-lg px-3', type: 'button', onClick: p.onConnect }, icon('mail'), 'Verbinden'),
  );
}

function suggestionList(p: InboxPanelProps, list: MailSuggestion[]): HTMLElement {
  return h(
    'div',
    { class: 'border-t border-line' },
    h(
      'div',
      { class: 'flex items-center justify-between gap-3 px-4 pt-3 pb-1' },
      h('p', { class: 'text-xs font-semibold tracking-wider text-subtle uppercase' }, `Vorschläge aus dem Postfach (${list.length})`),
      list.length > 1 ? h('button', { class: 'text-xs font-medium text-accent hover:underline', type: 'button', onClick: p.onAcceptAll }, 'Alle übernehmen') : null,
    ),
    h(
      'ul',
      { class: 'divide-y divide-line' },
      ...list.slice(0, 20).map((s) =>
        h(
          'li',
          { class: 'flex items-center gap-3 px-4 py-3' },
          carrierBadge(s.carrier, 'sm'),
          h(
            'div',
            { class: 'min-w-0 flex-1' },
            h('p', { class: 'truncate text-sm text-fg' }, s.label),
            h(
              'p',
              { class: 'flex flex-wrap items-center gap-x-2 text-xs text-subtle' },
              s.shop ? h('span', { class: 'font-medium text-muted' }, s.shop) : null,
              h('span', { class: 'font-mono text-muted' }, groupTrackingNumber(s.trackingNumber)),
              h('span', null, `${CARRIERS[s.carrier].name} · ${Math.round(s.confidence * 100)}%`),
              h('span', { class: 'hidden truncate sm:inline', attrs: { title: s.reason } }, `· ${formatRelative(s.receivedAt)}`),
            ),
          ),
          h(
            'button',
            { class: 'icon-btn size-9 text-emerald-400 hover:bg-emerald-400/10 hover:text-emerald-300', type: 'button', attrs: { 'aria-label': `${s.trackingNumber} übernehmen`, title: 'Übernehmen' }, onClick: () => p.onAccept(s.id) },
            icon('check', 'size-[18px]'),
          ),
          h(
            'button',
            { class: 'icon-btn size-9 hover:bg-rose-500/10 hover:text-rose-400', type: 'button', attrs: { 'aria-label': `${s.trackingNumber} verwerfen`, title: 'Verwerfen' }, onClick: () => p.onDismiss(s.id) },
            icon('x', 'size-[18px]'),
          ),
        ),
      ),
    ),
  );
}

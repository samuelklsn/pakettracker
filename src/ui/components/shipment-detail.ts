import { uid } from '../../core/id';
import type { Shipment, ShipmentStatus } from '../../core/types';
import { CARRIERS, deeplinkFor } from '../../services/carriers';
import { STATUS_META, type TrackingResult } from '../../services/tracking.service';
import { cx, h } from '../dom';
import { formatDateTime, formatRelative, groupTrackingNumber, toLocalInputValue } from '../format';
import { icon } from '../icons';
import { confirmDialog, openModal } from '../modal';
import { notify } from '../toast';
import { carrierBadge, statusBadge } from './carrier-badge';
import { timelineSkeleton } from './skeleton';
import { progressStepper, timeline } from './timeline';

export interface DetailContext {
  getShipment: (id: string) => Shipment | undefined;
  updateShipment: (id: string, mutate: (s: Shipment) => void) => Promise<void>;
  deleteShipment: (id: string) => Promise<void>;
  editShipment: (s: Shipment) => void;
  track: (s: Shipment, force?: boolean) => Promise<TrackingResult>;
  hasRemote: boolean;
  /** subscribe to vault changes; returns unsubscribe */
  subscribe: (fn: () => void) => () => void;
}

const MANUAL_STATUSES: ShipmentStatus[] = ['pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'exception'];
const MIN_SKELETON_MS = 420;

export function openShipmentDetail(ctx: DetailContext, id: string): void {
  let unsubscribe: () => void = () => undefined;

  openModal(
    { title: 'Sendungsdetails', variant: 'drawer', onClose: () => unsubscribe() },
    (body, close) => {
      let lastResult: TrackingResult | null = null;
      let loadSeq = 0;

      const render = (force = false) => {
        const s = ctx.getShipment(id);
        if (!s) {
          close();
          return;
        }
        const timelineHost = h('div');
        body.replaceChildren(view(s, timelineHost, close, () => load(s, timelineHost, true)));
        // reuse last result for instant re-render after local edits, refetch otherwise
        if (lastResult && !force) {
          void load(s, timelineHost, false, true);
        } else {
          void load(s, timelineHost, force);
        }
      };

      async function load(s: Shipment, host: HTMLElement, force: boolean, instant = false) {
        const seq = ++loadSeq;
        if (!instant) host.replaceChildren(timelineSkeleton());
        const started = performance.now();
        try {
          const result = await ctx.track(s, force);
          if (!instant) {
            const wait = MIN_SKELETON_MS - (performance.now() - started);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          }
          if (seq !== loadSeq) return;
          lastResult = result;
          host.replaceChildren(trackingSection(result));
          if (result.warning && force) notify.warning('Live-Tracking nicht verfügbar', result.warning);
          else if (force && result.source === 'remote') notify.success('Tracking aktualisiert');
        } catch (err) {
          if (seq !== loadSeq) return;
          host.replaceChildren(
            h('p', { class: 'text-sm text-rose-400' }, err instanceof Error ? err.message : 'Tracking fehlgeschlagen'),
          );
        }
      }

      function view(s: Shipment, timelineHost: HTMLElement, closeDrawer: () => void, refresh: () => void): HTMLElement {
        const carrier = CARRIERS[s.carrier];
        const deeplink = deeplinkFor(s.carrier, s.trackingNumber);

        return h(
          'div',
          { class: 'space-y-6' },
          // ---------- Header ----------
          h(
            'div',
            { class: 'flex items-center gap-4' },
            carrierBadge(s.carrier, 'lg'),
            h(
              'div',
              { class: 'min-w-0 flex-1' },
              h('p', { class: 'truncate text-lg font-semibold tracking-tight text-fg' }, s.label),
              h(
                'button',
                {
                  type: 'button',
                  class: 'group mt-0.5 inline-flex max-w-full items-center gap-1.5 font-mono text-sm text-muted hover:text-fg',
                  attrs: { title: 'Sendungsnummer kopieren' },
                  onClick: () => copy(s.trackingNumber),
                },
                h('span', { class: 'truncate' }, groupTrackingNumber(s.trackingNumber)),
                icon('copy', 'size-3.5 opacity-60 group-hover:opacity-100'),
              ),
            ),
          ),

          // ---------- Status hero ----------
          h('div', { class: 'glass space-y-4 rounded-2xl p-4', dataset: { statusHero: '' } }, statusHeroPlaceholder()),

          // ---------- Actions ----------
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            deeplink
              ? h(
                  'a',
                  {
                    class: 'btn-accent flex-1',
                    href: deeplink,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    attrs: { referrerpolicy: 'no-referrer' },
                  },
                  icon('external'),
                  `Bei ${carrier.name} verfolgen`,
                )
              : h(
                  'a',
                  {
                    class: 'btn-secondary flex-1',
                    href: `https://t.17track.net/de#nums=${encodeURIComponent(s.trackingNumber)}`,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    attrs: { title: 'Universeller Tracker (Drittanbieter)' },
                  },
                  icon('external'),
                  'Universell suchen',
                ),
            ctx.hasRemote
              ? h('button', { class: 'btn-secondary', type: 'button', onClick: refresh }, icon('refresh'), 'Aktualisieren')
              : null,
            h('button', { class: 'btn-secondary', type: 'button', onClick: () => manualUpdate(s) }, icon('pencil'), 'Status'),
          ),

          !ctx.hasRemote
            ? h(
                'div',
                { class: 'flex gap-3 rounded-2xl border border-sky-400/20 bg-sky-400/5 p-3.5 text-sm text-muted' },
                h('span', { class: 'text-sky-400' }, icon('shield', 'size-5')),
                h(
                  'p',
                  null,
                  h('span', { class: 'font-medium text-fg' }, 'Privat-Modus: '),
                  'Es ist keine Tracking-API verbunden – deine Sendungsnummer verlässt das Gerät nur, wenn du den Carrier-Link öffnest. Pflege den Status manuell, um die Timeline aktuell zu halten.',
                ),
              )
            : null,

          // ---------- Timeline ----------
          h('section', null, h('h3', { class: 'mb-4 text-sm font-semibold text-fg' }, 'Verlauf'), timelineHost),

          // ---------- Details ----------
          h(
            'section',
            { class: 'glass divide-y divide-line rounded-2xl' },
            detailRow('mail', 'E-Mail', s.email ? h('a', { class: 'text-fg underline-offset-2 hover:underline', href: `mailto:${s.email}` }, s.email) : null),
            detailRow('note', 'Notizen', s.notes ? h('p', { class: 'whitespace-pre-wrap text-fg' }, s.notes) : null),
            detailRow(
              'link',
              'Quelle',
              s.sourceUrl
                ? h('a', { class: 'block truncate text-fg underline-offset-2 hover:underline', href: s.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, s.sourceUrl)
                : null,
            ),
            detailRow('calendar', 'Angelegt', h('span', { class: 'text-fg' }, formatDateTime(s.createdAt))),
          ),

          // ---------- Footer ----------
          h(
            'div',
            { class: 'flex flex-wrap gap-2 border-t border-line pt-5' },
            h('button', { class: 'btn-secondary', type: 'button', onClick: () => ctx.editShipment(s) }, icon('pencil'), 'Bearbeiten'),
            h(
              'button',
              {
                class: 'btn-secondary',
                type: 'button',
                onClick: async () => {
                  await ctx.updateShipment(s.id, (x) => (x.archived = !x.archived));
                  notify.success(s.archived ? 'Sendung wiederhergestellt' : 'Sendung archiviert');
                },
              },
              icon('box'),
              s.archived ? 'Wiederherstellen' : 'Archivieren',
            ),
            h(
              'button',
              {
                class: 'btn-ghost ml-auto text-rose-400 hover:bg-rose-500/10 hover:text-rose-400',
                type: 'button',
                onClick: async () => {
                  const ok = await confirmDialog({
                    title: 'Sendung löschen?',
                    description: `„${s.label}“ wird endgültig aus deinem Tresor entfernt.`,
                    confirmLabel: 'Löschen',
                    danger: true,
                  });
                  if (!ok) return;
                  await ctx.deleteShipment(s.id);
                  notify.success('Sendung gelöscht');
                  closeDrawer();
                },
              },
              icon('trash'),
              'Löschen',
            ),
          ),
        );
      }

      function trackingSection(result: TrackingResult): HTMLElement {
        // Fill the status hero with fresh data
        const hero = body.querySelector<HTMLElement>('[data-status-hero]');
        if (hero) {
          const meta = STATUS_META[result.status];
          hero.replaceChildren(
            h(
              'div',
              { class: 'flex items-start justify-between gap-3' },
              h(
                'div',
                null,
                h('p', { class: 'text-xs font-medium tracking-wide text-subtle uppercase' }, 'Aktueller Status'),
                h('p', { class: 'mt-1 text-xl font-semibold tracking-tight text-fg' }, meta.label),
                h(
                  'p',
                  { class: 'mt-1 text-xs text-muted' },
                  result.estimatedDelivery
                    ? `Voraussichtlich: ${result.estimatedDelivery}`
                    : result.source === 'remote'
                      ? `Live-Daten · ${formatRelative(result.fetchedAt)}`
                      : 'Lokale Daten',
                ),
              ),
              statusBadge(result.status, result.status === 'out_for_delivery'),
            ),
            progressStepper(result.status),
          );
        }
        return timeline(result.events);
      }

      function manualUpdate(s: Shipment) {
        openModal({ title: 'Status aktualisieren', description: 'Fügt einen manuellen Eintrag zur Timeline hinzu.', size: 'sm' }, (b, closeModal) => {
          let status: ShipmentStatus = 'in_transit';
          const group = h('div', { class: 'grid grid-cols-1 gap-2', attrs: { role: 'radiogroup' } });
          const renderGroup = () =>
            group.replaceChildren(
              ...MANUAL_STATUSES.map((st) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: cx(
                      'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition',
                      st === status ? `tone-${STATUS_META[st].tone}` : 'border-line text-muted hover:border-line-strong hover:text-fg',
                    ),
                    attrs: { role: 'radio', 'aria-checked': String(st === status) },
                    onClick: () => {
                      status = st;
                      renderGroup();
                    },
                  },
                  h('span', { class: cx('size-2 rounded-full', `dot-${STATUS_META[st].tone}`) }),
                  STATUS_META[st].label,
                ),
              ),
            );
          renderGroup();

          const location = h('input', { class: 'field', attrs: { placeholder: 'Ort (optional)', maxlength: 200 } });
          const note = h('input', { class: 'field', attrs: { placeholder: 'Notiz (optional)', maxlength: 1000 } });
          const defaultAt = toLocalInputValue(new Date());
          const at = h('input', { class: 'field', type: 'datetime-local', value: defaultAt });

          b.append(
            h(
              'form',
              {
                class: 'space-y-4',
                onSubmit: async (e: SubmitEvent) => {
                  e.preventDefault();
                  // untouched default → use the precise current time (input only has minute precision)
                  const when = at.value && at.value !== defaultAt ? new Date(at.value) : new Date();
                  await ctx.updateShipment(s.id, (x) => {
                    x.events.push({
                      id: uid(),
                      status,
                      at: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
                      title: STATUS_META[status].label,
                      description: note.value.trim() || undefined,
                      location: location.value.trim() || undefined,
                      origin: 'manual',
                    });
                  });
                  notify.success('Status gespeichert', STATUS_META[status].label);
                  closeModal();
                },
              },
              group,
              h('label', { class: 'block' }, h('span', { class: 'label' }, 'Zeitpunkt'), at),
              location,
              note,
              h('div', { class: 'flex justify-end gap-2' }, h('button', { class: 'btn-ghost', type: 'button', onClick: closeModal }, 'Abbrechen'), h('button', { class: 'btn-primary', type: 'submit' }, 'Speichern')),
            ),
          );
        });
      }

      unsubscribe = ctx.subscribe(() => render());
      render();
    },
  );
}

function statusHeroPlaceholder(): HTMLElement[] {
  return [
    h('div', { class: 'space-y-2' }, h('div', { class: 'skeleton h-3 w-24' }), h('div', { class: 'skeleton h-6 w-40' })),
    h('div', { class: 'grid grid-cols-4 gap-2' }, ...Array.from({ length: 4 }, () => h('div', { class: 'skeleton h-1.5 rounded-full' }))),
  ];
}

function detailRow(iconName: Parameters<typeof icon>[0], label: string, value: HTMLElement | null): HTMLElement {
  return h(
    'div',
    { class: 'flex gap-3 px-4 py-3 text-sm' },
    h('span', { class: 'mt-0.5 text-subtle' }, icon(iconName)),
    h('span', { class: 'w-20 shrink-0 text-muted' }, label),
    h('div', { class: 'min-w-0 flex-1' }, value ?? h('span', { class: 'text-subtle' }, '—')),
  );
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success('Kopiert', text);
  } catch {
    notify.error('Kopieren nicht möglich');
  }
}

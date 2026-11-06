import type { CarrierId, Shipment } from '../../core/types';
import { CARRIER_LIST } from '../../services/carriers';
import { matchCarriers, normalizeTrackingNumber } from '../../services/detection.service';
import { h } from '../dom';
import { icon } from '../icons';
import { openModal } from '../modal';

export interface ShipmentFormValues {
  trackingNumber: string;
  carrier: CarrierId;
  label: string;
  email?: string;
  sourceUrl?: string;
  notes?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add / edit dialog. Resolves with values on save, or null when cancelled. */
export function shipmentForm(
  initial: Partial<ShipmentFormValues>,
  mode: 'create' | 'edit',
  onSave: (values: ShipmentFormValues) => Promise<void>,
): void {
  openModal(
    {
      title: mode === 'create' ? 'Neue Sendung' : 'Sendung bearbeiten',
      description: 'Alle Felder werden mit AES-256-GCM verschlüsselt gespeichert.',
      size: 'md',
    },
    (body, close) => {
      const number = h('input', {
        class: 'field font-mono uppercase',
        name: 'trackingNumber',
        value: initial.trackingNumber ?? '',
        required: true,
        attrs: { autocomplete: 'off', spellcheck: 'false', maxlength: 120, autofocus: !initial.trackingNumber },
      });
      const carrier = h(
        'select',
        { class: 'field', name: 'carrier' },
        ...CARRIER_LIST.map((c) => h('option', { value: c.id, selected: c.id === (initial.carrier ?? 'other') }, c.name)),
      );
      const label = h('input', {
        class: 'field',
        name: 'label',
        value: initial.label ?? '',
        attrs: { placeholder: 'z. B. Neue Kopfhörer', maxlength: 120, autofocus: !!initial.trackingNumber },
      });
      const email = h('input', {
        class: 'field',
        type: 'email',
        name: 'email',
        value: initial.email ?? '',
        attrs: { placeholder: 'Benachrichtigungs- oder Shop-E-Mail', maxlength: 254, autocomplete: 'off' },
      });
      const notes = h('textarea', {
        class: 'field',
        name: 'notes',
        value: initial.notes ?? '',
        attrs: { placeholder: 'Bestellnummer, Inhalt, Abholort …', maxlength: 5000, rows: 3 },
      });
      const error = h('p', { class: 'hidden text-sm text-rose-400', attrs: { role: 'alert' } });

      // live re-detection when the number is typed manually
      number.addEventListener('change', () => {
        const best = matchCarriers(normalizeTrackingNumber(number.value))[0];
        if (best && carrier.value === 'other') carrier.value = best.carrier;
      });

      const saveBtn = h('button', { class: 'btn-primary', type: 'submit' }, icon('lock', 'size-4'), 'Verschlüsselt speichern');

      const form = h(
        'form',
        {
          class: 'space-y-4',
          attrs: { novalidate: true },
          onSubmit: async (e: SubmitEvent) => {
            e.preventDefault();
            const n = normalizeTrackingNumber(number.value);
            if (!/^[A-Z0-9]{4,120}$/.test(n)) return showError('Bitte eine gültige Sendungsnummer eingeben (nur Buchstaben & Ziffern).');
            const mail = email.value.trim();
            if (mail && !EMAIL_RE.test(mail)) return showError('Die E-Mail-Adresse ist ungültig.');
            saveBtn.disabled = true;
            try {
              await onSave({
                trackingNumber: n,
                carrier: carrier.value as CarrierId,
                label: label.value.trim() || n,
                email: mail || undefined,
                sourceUrl: initial.sourceUrl,
                notes: notes.value.trim() || undefined,
              });
              close();
            } catch (err) {
              showError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
            } finally {
              saveBtn.disabled = false;
            }
          },
        },
        h(
          'div',
          { class: 'grid gap-4 sm:grid-cols-[1fr_10rem]' },
          h('label', null, h('span', { class: 'label' }, 'Sendungsnummer'), number),
          h('label', null, h('span', { class: 'label' }, 'Carrier'), carrier),
        ),
        h('label', { class: 'block' }, h('span', { class: 'label' }, 'Bezeichnung'), label),
        h('label', { class: 'block' }, h('span', { class: 'label' }, 'E-Mail (optional)'), email),
        h('label', { class: 'block' }, h('span', { class: 'label' }, 'Notizen (optional)'), notes),
        initial.sourceUrl
          ? h(
              'p',
              { class: 'flex items-center gap-2 truncate text-xs text-subtle' },
              icon('link', 'size-3.5'),
              h('span', { class: 'truncate' }, `Quelle: ${initial.sourceUrl}`),
            )
          : null,
        error,
        h('div', { class: 'flex justify-end gap-2 pt-2' }, h('button', { class: 'btn-ghost', type: 'button', onClick: close }, 'Abbrechen'), saveBtn),
      );

      function showError(msg: string) {
        error.textContent = msg;
        error.classList.remove('hidden');
      }

      body.append(form);
    },
  );
}

export function formValuesFrom(s: Shipment): ShipmentFormValues {
  return {
    trackingNumber: s.trackingNumber,
    carrier: s.carrier,
    label: s.label,
    email: s.email,
    sourceUrl: s.sourceUrl,
    notes: s.notes,
  };
}

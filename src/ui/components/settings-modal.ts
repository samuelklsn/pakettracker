import { errorMessage } from '../../core/errors';
import { KDF_ITERATIONS } from '../../services/crypto.service';
import { type ImportMode, MIN_PASSWORD_LENGTH, type VaultService } from '../../services/vault.service';
import { cx, h } from '../dom';
import { icon, type IconName } from '../icons';
import { confirmDialog, openModal } from '../modal';
import { notify } from '../toast';
import { passwordField } from './password-field';

export interface SettingsContext {
  vault: VaultService;
  onDataChanged: () => void;
  onDestroyed: () => void;
}

export function openSettings(ctx: SettingsContext): void {
  openModal({ title: 'Einstellungen', description: 'Backup, Sicherheit & Tresor-Verwaltung', size: 'lg' }, (body, close) => {
    body.append(
      h(
        'div',
        { class: 'space-y-4' },
        backupSection(ctx),
        securitySection(ctx),
        dangerSection(ctx, close),
        h(
          'p',
          { class: 'flex items-center gap-2 pt-2 text-xs text-subtle' },
          icon('shield', 'size-3.5'),
          `AES-256-GCM · PBKDF2-SHA-256 · ${KDF_ITERATIONS.toLocaleString('de-DE')} Iterationen · Zero-Knowledge`,
        ),
      ),
    );
  });
}

function section(iconName: IconName, title: string, description: string, ...content: (HTMLElement | null)[]): HTMLElement {
  return h(
    'section',
    { class: 'glass rounded-2xl p-5' },
    h(
      'div',
      { class: 'mb-4 flex gap-3' },
      h('span', { class: 'flex size-9 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-elevated text-accent' }, icon(iconName)),
      h('div', null, h('h3', { class: 'text-sm font-semibold text-fg' }, title), h('p', { class: 'mt-0.5 text-sm text-muted' }, description)),
    ),
    ...content,
  );
}

/* ------------------------------- Backup ------------------------------- */

function backupSection(ctx: SettingsContext): HTMLElement {
  const fileInput = h('input', { type: 'file', class: 'hidden', attrs: { accept: 'application/json,.json' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return notify.error('Datei zu groß', 'Backups sind maximal 5 MB groß.');
    importFlow(ctx, await file.text(), file.name);
  });

  return section(
    'download',
    'Verschlüsseltes Backup',
    'Das Backup enthält ausschließlich Ciphertext. Ohne Master-Passwort ist es wertlos – auch für uns.',
    h(
      'div',
      { class: 'flex flex-wrap gap-2' },
      h(
        'button',
        {
          class: 'btn-primary',
          type: 'button',
          onClick: () => {
            try {
              const backup = ctx.vault.exportBackup();
              const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = h('a', { href: url, attrs: { download: `pakettracker-backup-${new Date().toISOString().slice(0, 10)}.json` } });
              document.body.append(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              notify.success('Backup exportiert', `${ctx.vault.data.shipments.length} Sendungen verschlüsselt gesichert.`);
            } catch (err) {
              notify.error('Export fehlgeschlagen', errorMessage(err));
            }
          },
        },
        icon('download'),
        'Backup exportieren',
      ),
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => fileInput.click() }, icon('upload'), 'Backup importieren'),
      fileInput,
    ),
  );
}

function importFlow(ctx: SettingsContext, text: string, fileName: string): void {
  openModal(
    { title: 'Backup importieren', description: `Datei: ${fileName}`, size: 'sm' },
    (body, close) => {
      let mode: ImportMode = 'merge';
      const pw = passwordField({ placeholder: 'Passwort des Backups', autofocus: true, autocomplete: 'current-password' });
      const error = h('p', { class: 'hidden text-sm text-rose-400', attrs: { role: 'alert' } });
      const submit = h('button', { class: 'btn-primary', type: 'submit' }, icon('unlock'), 'Entschlüsseln & importieren');

      const modes = h('div', { class: 'grid grid-cols-2 gap-2', attrs: { role: 'radiogroup', 'aria-label': 'Import-Modus' } });
      const renderModes = () =>
        modes.replaceChildren(
          ...(
            [
              ['merge', 'Zusammenführen', 'Neue & neuere Sendungen übernehmen'],
              ['replace', 'Ersetzen', 'Aktuellen Inhalt überschreiben'],
            ] as const
          ).map(([value, title, desc]) =>
            h(
              'button',
              {
                type: 'button',
                class: cx(
                  'rounded-xl border p-3 text-left transition',
                  mode === value ? 'border-accent/60 bg-accent/10' : 'border-line hover:border-line-strong',
                ),
                attrs: { role: 'radio', 'aria-checked': String(mode === value) },
                onClick: () => {
                  mode = value;
                  renderModes();
                },
              },
              h('p', { class: 'text-sm font-medium text-fg' }, title),
              h('p', { class: 'mt-0.5 text-xs text-muted' }, desc),
            ),
          ),
        );
      renderModes();

      body.append(
        h(
          'form',
          {
            class: 'space-y-4',
            onSubmit: async (e: SubmitEvent) => {
              e.preventDefault();
              error.classList.add('hidden');
              if (mode === 'replace') {
                const ok = await confirmDialog({
                  title: 'Tresorinhalt ersetzen?',
                  description: 'Alle aktuellen Sendungen werden durch den Backup-Inhalt ersetzt.',
                  confirmLabel: 'Ersetzen',
                  danger: true,
                });
                if (!ok) return;
              }
              submit.disabled = true;
              submit.replaceChildren(icon('loader', 'size-4 animate-spin'), 'Entschlüssele …');
              try {
                const n = await ctx.vault.importBackup(text, pw.input.value, mode);
                ctx.onDataChanged();
                notify.success('Backup importiert', `${n} Sendung${n === 1 ? '' : 'en'} übernommen. Dein Master-Passwort bleibt unverändert.`);
                close();
              } catch (err) {
                error.textContent = errorMessage(err);
                error.classList.remove('hidden');
                pw.input.select();
              } finally {
                submit.disabled = false;
                submit.replaceChildren(icon('unlock'), 'Entschlüsseln & importieren');
              }
            },
          },
          h(
            'p',
            { class: 'text-sm text-muted' },
            'Die Daten werden mit dem Backup-Passwort entschlüsselt und anschließend mit deinem aktuellen Schlüssel neu verschlüsselt.',
          ),
          modes,
          pw.el,
          error,
          h('div', { class: 'flex justify-end gap-2' }, h('button', { class: 'btn-ghost', type: 'button', onClick: close }, 'Abbrechen'), submit),
        ),
      );
    },
  );
}

/* ------------------------------- Security ------------------------------- */

function securitySection(ctx: SettingsContext): HTMLElement {
  const autoLock = h(
    'select',
    {
      id: 'autolock',
      class: 'field w-auto min-w-40',
      onChange: async () => {
        const minutes = Number(autoLock.value);
        await ctx.vault.update((d) => (d.settings.autoLockMinutes = minutes));
        ctx.onDataChanged();
        notify.success('Auto-Lock aktualisiert', minutes ? `Sperre nach ${minutes} Minuten Inaktivität` : 'Auto-Lock deaktiviert');
      },
    },
    ...[1, 5, 10, 30, 60, 0].map((m) =>
      h('option', { value: String(m), selected: ctx.vault.data.settings.autoLockMinutes === m }, m ? `${m} Minuten` : 'Nie'),
    ),
  );

  return section(
    'key',
    'Sicherheit',
    'Der Schlüssel existiert nur im Arbeitsspeicher und wird beim Sperren verworfen.',
    h(
      'div',
      { class: 'flex flex-wrap items-center justify-between gap-3' },
      h('label', { class: 'text-sm text-muted', attrs: { for: 'autolock' } }, 'Automatisch sperren nach'),
      autoLock,
    ),
    h(
      'div',
      { class: 'mt-4 flex justify-end border-t border-line pt-4' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => changePasswordFlow(ctx) }, icon('key'), 'Master-Passwort ändern'),
    ),
  );
}

function changePasswordFlow(ctx: SettingsContext): void {
  openModal({ title: 'Master-Passwort ändern', description: 'Der Tresor wird mit neuem Salt & Schlüssel neu verschlüsselt.', size: 'sm' }, (body, close) => {
    const current = passwordField({ placeholder: 'Aktuelles Passwort', autofocus: true, autocomplete: 'current-password' });
    const next = passwordField({ placeholder: `Neues Passwort (min. ${MIN_PASSWORD_LENGTH} Zeichen)`, autocomplete: 'new-password', strength: true });
    const confirm = passwordField({ placeholder: 'Neues Passwort bestätigen', autocomplete: 'new-password' });
    const error = h('p', { class: 'hidden text-sm text-rose-400', attrs: { role: 'alert' } });
    const submit = h('button', { class: 'btn-primary', type: 'submit' }, 'Passwort ändern');

    body.append(
      h(
        'form',
        {
          class: 'space-y-3',
          onSubmit: async (e: SubmitEvent) => {
            e.preventDefault();
            const fail = (m: string) => {
              error.textContent = m;
              error.classList.remove('hidden');
            };
            if (next.input.value !== confirm.input.value) return fail('Die neuen Passwörter stimmen nicht überein.');
            submit.disabled = true;
            submit.replaceChildren(icon('loader', 'size-4 animate-spin'), 'Verschlüssele neu …');
            try {
              await ctx.vault.changePassword(current.input.value, next.input.value);
              notify.success('Master-Passwort geändert', 'Erstelle am besten gleich ein neues Backup.');
              close();
            } catch (err) {
              fail(errorMessage(err));
            } finally {
              submit.disabled = false;
              submit.replaceChildren('Passwort ändern');
            }
          },
        },
        current.el,
        next.el,
        confirm.el,
        error,
        h('div', { class: 'flex justify-end gap-2 pt-1' }, h('button', { class: 'btn-ghost', type: 'button', onClick: close }, 'Abbrechen'), submit),
      ),
    );
  });
}

/* ------------------------------- Danger zone ------------------------------- */

function dangerSection(ctx: SettingsContext, closeSettings: () => void): HTMLElement {
  return h(
    'section',
    { class: 'rounded-2xl border border-rose-500/25 bg-rose-500/5 p-5' },
    h(
      'div',
      { class: 'flex flex-wrap items-center justify-between gap-4' },
      h(
        'div',
        null,
        h('h3', { class: 'flex items-center gap-2 text-sm font-semibold text-rose-400' }, icon('shieldAlert'), 'Tresor löschen'),
        h('p', { class: 'mt-0.5 text-sm text-muted' }, 'Entfernt alle verschlüsselten Daten unwiderruflich von diesem Gerät.'),
      ),
      h(
        'button',
        {
          class: 'btn-danger',
          type: 'button',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Wirklich alles löschen?',
              description: 'Ohne Backup sind deine Sendungen danach unwiederbringlich verloren.',
              confirmLabel: 'Endgültig löschen',
              danger: true,
            });
            if (!ok) return;
            ctx.vault.destroy();
            closeSettings();
            ctx.onDestroyed();
            notify.info('Tresor gelöscht');
          },
        },
        icon('trash'),
        'Löschen',
      ),
    ),
  );
}

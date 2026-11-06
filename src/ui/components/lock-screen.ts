import { InvalidVaultFormatError, errorMessage } from '../../core/errors';
import { KDF_ITERATIONS } from '../../services/crypto.service';
import { MIN_PASSWORD_LENGTH, WrongPasswordError } from '../../services/vault.service';
import { h } from '../dom';
import { icon } from '../icons';
import { confirmDialog } from '../modal';
import { passwordField } from './password-field';

export interface LockScreenOptions {
  mode: 'setup' | 'unlock';
  onCreate: (password: string) => Promise<void>;
  onUnlock: (password: string) => Promise<void>;
  onReset: () => void;
  /** Setup mode only: load an existing vault from the cloud (new device). */
  onLoadFromCloud?: () => Promise<void>;
}

/** Client-side throttling after repeated failures (UX hardening against shoulder-surf guessing). */
let failedAttempts = 0;
let lockedUntil = 0;

export function lockScreen(opts: LockScreenOptions): HTMLElement {
  const setup = opts.mode === 'setup';
  const pw = passwordField({
    placeholder: setup ? `Master-Passwort (min. ${MIN_PASSWORD_LENGTH} Zeichen)` : 'Master-Passwort',
    autocomplete: setup ? 'new-password' : 'current-password',
    autofocus: true,
    strength: setup,
  });
  const confirm = setup ? passwordField({ placeholder: 'Passwort bestätigen', autocomplete: 'new-password' }) : null;
  const error = h('div', { class: 'hidden items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-300', attrs: { role: 'alert' } });
  const submitLabel = setup ? 'Tresor erstellen' : 'Entsperren';
  const submit = h('button', { class: 'btn-primary h-11 w-full', type: 'submit' }, icon(setup ? 'shield' : 'unlock'), submitLabel);

  const card = h(
    'div',
    { class: 'glass w-full max-w-md animate-pop-in rounded-3xl p-7 sm:p-8' },
    h(
      'div',
      { class: 'mb-7 flex flex-col items-center text-center' },
      h(
        'div',
        { class: 'relative mb-5' },
        h('div', { class: 'absolute inset-0 rounded-2xl bg-accent/30 blur-xl' }),
        h(
          'div',
          { class: 'relative flex size-14 items-center justify-center rounded-2xl border border-line-strong bg-elevated text-accent' },
          icon(setup ? 'shield' : 'lock', 'size-6', 1.75),
        ),
      ),
      h('h1', { class: 'text-xl font-semibold tracking-tight text-fg' }, setup ? 'Tresor einrichten' : 'Willkommen zurück'),
      h(
        'p',
        { class: 'mt-2 text-sm text-muted' },
        setup
          ? 'Wähle ein Master-Passwort. Daraus wird lokal dein Schlüssel abgeleitet – es wird nirgends gespeichert und kann nicht wiederhergestellt werden.'
          : 'Gib dein Master-Passwort ein, um deine verschlüsselten Sendungen zu entschlüsseln.',
      ),
    ),
    h(
      'form',
      {
        class: 'space-y-3',
        attrs: { novalidate: true },
        onSubmit: async (e: SubmitEvent) => {
          e.preventDefault();
          hideError();
          const now = Date.now();
          if (now < lockedUntil) {
            showError(`Zu viele Fehlversuche. Bitte ${Math.ceil((lockedUntil - now) / 1000)} s warten.`);
            return;
          }
          const value = pw.input.value;
          if (setup) {
            if (value.length < MIN_PASSWORD_LENGTH) return showError(`Mindestens ${MIN_PASSWORD_LENGTH} Zeichen erforderlich.`);
            if (value !== confirm?.input.value) return showError('Die Passwörter stimmen nicht überein.');
          } else if (!value) {
            return showError('Bitte Master-Passwort eingeben.');
          }

          setBusy(true);
          try {
            if (setup) await opts.onCreate(value);
            else await opts.onUnlock(value);
            failedAttempts = 0;
          } catch (err) {
            setBusy(false);
            if (err instanceof WrongPasswordError) {
              failedAttempts++;
              if (failedAttempts >= 3) lockedUntil = Date.now() + Math.min(30, 2 ** (failedAttempts - 3)) * 1000;
              showError(err.message);
              card.classList.remove('animate-shake');
              void card.offsetWidth; // restart animation
              card.classList.add('animate-shake');
              pw.input.select();
            } else if (err instanceof InvalidVaultFormatError) {
              showError(`Tresor beschädigt oder unlesbar: ${err.message}. Importiere ggf. ein Backup nach einem Reset.`);
            } else {
              showError(errorMessage(err));
            }
          }
        },
      },
      pw.el,
      confirm?.el ?? null,
      error,
      submit,
    ),
    setup && opts.onLoadFromCloud ? cloudOption(opts.onLoadFromCloud) : null,
    h(
      'div',
      { class: 'mt-6 flex items-center justify-between gap-3 border-t border-line pt-5 text-xs text-subtle' },
      h('span', { class: 'inline-flex items-center gap-1.5' }, icon('shield', 'size-3.5 text-emerald-400'), `AES-256-GCM · PBKDF2 ${Math.round(KDF_ITERATIONS / 1000)}k`),
      !setup
        ? h(
            'button',
            {
              type: 'button',
              class: 'underline-offset-2 hover:text-rose-400 hover:underline',
              onClick: async () => {
                const ok = await confirmDialog({
                  title: 'Passwort vergessen?',
                  description:
                    'Zero-Knowledge bedeutet: Niemand kann dein Passwort zurücksetzen. Du kannst nur den Tresor löschen und neu beginnen (danach ggf. Backup importieren).',
                  confirmLabel: 'Tresor löschen',
                  danger: true,
                });
                if (ok) opts.onReset();
              },
            },
            'Passwort vergessen?',
          )
        : h('span', null, 'Lokal · Offline-fähig'),
    ),
  );

  function cloudOption(load: () => Promise<void>): HTMLElement {
    const btn = h('button', { class: 'btn-secondary h-11 w-full', type: 'button' }, icon('cloudDownload'), 'Tresor aus Google Drive laden');
    btn.addEventListener('click', async () => {
      hideError();
      btn.disabled = true;
      btn.replaceChildren(icon('loader', 'size-4 animate-spin'), 'Lade verschlüsselten Tresor …');
      try {
        await load();
      } catch (err) {
        showError(errorMessage(err));
        btn.disabled = false;
        btn.replaceChildren(icon('cloudDownload'), 'Tresor aus Google Drive laden');
      }
    });
    return h(
      'div',
      { class: 'mt-5 space-y-3' },
      h(
        'div',
        { class: 'flex items-center gap-3 text-xs text-subtle' },
        h('span', { class: 'h-px flex-1 bg-line' }),
        'Schon auf einem anderen Gerät eingerichtet?',
        h('span', { class: 'h-px flex-1 bg-line' }),
      ),
      btn,
    );
  }

  function setBusy(busy: boolean) {
    submit.disabled = busy;
    pw.input.disabled = busy;
    if (confirm) confirm.input.disabled = busy;
    submit.replaceChildren(
      ...(busy
        ? [icon('loader', 'size-4 animate-spin'), setup ? 'Schlüssel wird abgeleitet …' : 'Entschlüssele …']
        : [icon(setup ? 'shield' : 'unlock'), submitLabel]),
    );
    if (!busy) pw.input.focus();
  }
  function showError(msg: string) {
    error.replaceChildren(icon('alert', 'mt-0.5 size-4'), h('span', null, msg));
    error.classList.remove('hidden');
    error.classList.add('flex');
  }
  function hideError() {
    error.classList.add('hidden');
    error.classList.remove('flex');
  }

  return h(
    'main',
    { class: 'flex min-h-dvh flex-col items-center justify-center px-4 py-10' },
    h(
      'div',
      { class: 'mb-8 flex items-center gap-2.5 text-fg' },
      h('span', { class: 'flex size-8 items-center justify-center rounded-lg bg-fg text-bg' }, icon('package', 'size-4.5', 2)),
      h('span', { class: 'text-base font-semibold tracking-tight' }, 'Pakettracker'),
    ),
    card,
    h('p', { class: 'mt-6 max-w-md text-center text-xs text-subtle' }, 'Deine Daten verlassen dieses Gerät nur verschlüsselt – auch bei der Synchronisierung. Kein Konto bei uns, kein Tracking.'),
  );
}

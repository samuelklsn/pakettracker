import { AppError, errorMessage } from './core/errors';
import { DriveService } from './services/drive.service';
import type { RemoteVault } from './services/drive.service';
import { GmailService } from './services/gmail.service';
import { GoogleAuthError, GoogleAuthService, SCOPES } from './services/google-auth.service';
import { acceptSuggestion, dismissSuggestion, resetScanHistory, scanInbox } from './services/inbox.service';
import { SyncService, isSyncEnabled, setSyncEnabled } from './services/sync.service';
import type { VaultService } from './services/vault.service';
import { inboxPanel } from './ui/components/inbox-panel';
import { passwordField } from './ui/components/password-field';
import type { MailSettings, SyncSettings } from './ui/components/settings-modal';
import { cx, h } from './ui/dom';
import { formatRelative } from './ui/format';
import { icon, type IconName } from './ui/icons';
import { confirmDialog, openModal } from './ui/modal';
import { notify, toast } from './ui/toast';

/**
 * CloudController – everything that talks to Google on behalf of the unlocked vault:
 * one shared login, Gmail import and end-to-end encrypted Drive sync, plus their timers and UI bits.
 */

export interface CloudHost {
  readonly vault: VaultService;
  /** re-render dashboard + open detail views */
  changed(): void;
}

type SyncState = 'off' | 'idle' | 'syncing' | 'ok' | 'error' | 'expired' | 'needs-password';

const TICK_MS = 60_000;
const SYNC_DEBOUNCE_MS = 1_500;
const SYNC_PULL_MS = 60_000;
const LOCK_FLUSH_TIMEOUT_MS = 4_000;

export class CloudController {
  private readonly host: CloudHost;
  private readonly auth = new GoogleAuthService();
  private readonly gmail = new GmailService(this.auth);
  private readonly drive = new DriveService(this.auth);
  private readonly sync: SyncService;

  private scanning = false;
  private syncState: SyncState = 'off';
  private syncError: string | undefined;
  private lastSyncAt: number | undefined;
  private pendingRemote: RemoteVault | undefined;
  private passwordPromptShown = false;
  private dirty = false;
  private tick: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private unsubscribePersist: (() => void) | undefined;

  private inboxHost: HTMLElement | null = null;
  private pill: HTMLButtonElement | null = null;

  constructor(host: CloudHost) {
    this.host = host;
    this.sync = new SyncService(host.vault, this.drive);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.vault.isUnlocked && isSyncEnabled()) void this.syncNow({ silent: true });
    });
  }

  get configured(): boolean {
    return this.auth.configured;
  }

  private get vault(): VaultService {
    return this.host.vault;
  }

  /* ------------------------------ Session ------------------------------ */

  /** Called right after unlock – still inside the user's click, so a Google popup is usually allowed. */
  onUnlocked(): void {
    if (!this.configured) return;
    this.syncState = isSyncEnabled() ? 'idle' : 'off';
    this.unsubscribePersist = this.vault.onPersisted(() => this.scheduleSync());
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    const scopes = this.wantedScopes();
    if (scopes.length) void this.connectAll({ silent: true });
    this.refresh();
  }

  /** Pushes pending changes before the key is dropped. */
  async beforeLock(): Promise<void> {
    if (!this.dirty || !isSyncEnabled() || !this.drive.hasValidToken) return;
    clearTimeout(this.debounce);
    await Promise.race([this.syncNow({ silent: true }), new Promise((r) => setTimeout(r, LOCK_FLUSH_TIMEOUT_MS))]);
  }

  endSession(): void {
    clearInterval(this.tick);
    clearTimeout(this.debounce);
    this.unsubscribePersist?.();
    this.unsubscribePersist = undefined;
    this.auth.forget();
    this.scanning = false;
    this.syncState = 'off';
    this.pendingRemote = undefined;
    this.passwordPromptShown = false;
    this.dirty = false;
    this.inboxHost = null;
    this.pill = null;
  }

  private wantedScopes(): string[] {
    const scopes: string[] = [];
    if (isSyncEnabled()) scopes.push(SCOPES.drive);
    if (this.vault.isUnlocked && this.vault.data.inbox.enabled) scopes.push(SCOPES.gmail);
    return scopes;
  }

  /** (Re)connects every enabled Google feature with ONE popup, then syncs and scans. */
  private async connectAll(opts: { silent?: boolean } = {}): Promise<void> {
    const scopes = this.wantedScopes();
    if (!scopes.length) return;
    try {
      await this.auth.ensure(scopes);
    } catch (err) {
      if (isSyncEnabled()) this.syncState = 'expired';
      this.refresh();
      if (!opts.silent) notify.error('Google-Verbindung fehlgeschlagen', errorMessage(err));
      return;
    }
    if (isSyncEnabled()) await this.syncNow({ silent: true });
    if (this.vault.isUnlocked && this.vault.data.inbox.enabled) await this.runScan({ silent: !!opts.silent });
  }

  private onTick(): void {
    if (!this.vault.isUnlocked) return;
    // Drive: pull changes from other devices
    if (isSyncEnabled()) {
      if (!this.drive.hasValidToken) {
        if (this.syncState !== 'expired') {
          this.syncState = 'expired';
          this.renderPill();
        }
      } else if (!this.lastSyncAt || Date.now() - this.lastSyncAt >= SYNC_PULL_MS) {
        void this.syncNow({ silent: true });
      }
    }
    // Gmail: auto-scan
    const inbox = this.vault.data.inbox;
    if (inbox.enabled && inbox.autoScanMinutes) {
      if (!this.gmail.hasValidToken) this.renderInbox();
      else {
        const last = inbox.lastScanAt ? Date.parse(inbox.lastScanAt) : 0;
        if (Date.now() - last >= inbox.autoScanMinutes * 60_000) void this.runScan({ silent: true });
      }
    }
  }

  private refresh(): void {
    this.renderPill();
    this.renderInbox();
  }

  /* ------------------------------ Sync ------------------------------ */

  private scheduleSync(): void {
    if (!isSyncEnabled()) return;
    this.dirty = true;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow({ silent: true }), SYNC_DEBOUNCE_MS);
  }

  async syncNow(opts: { silent?: boolean } = {}): Promise<void> {
    if (!this.vault.isUnlocked || !isSyncEnabled()) return;
    if (this.syncState === 'needs-password') {
      if (!opts.silent) this.openPasswordDialog();
      return;
    }
    if (!this.drive.hasValidToken) {
      this.syncState = 'expired';
      this.renderPill();
      return;
    }
    this.syncState = 'syncing';
    this.renderPill();
    try {
      this.dirty = false;
      const r = await this.sync.sync();
      if (!this.vault.isUnlocked) return;
      if (r.outcome === 'needs-password') {
        this.syncState = 'needs-password';
        this.pendingRemote = r.remote;
        if (!this.passwordPromptShown) {
          this.passwordPromptShown = true;
          this.openPasswordDialog();
        }
        return;
      }
      this.syncState = 'ok';
      this.syncError = undefined;
      this.lastSyncAt = Date.now();
      if (r.outcome === 'downloaded' || r.outcome === 'merged') {
        this.host.changed();
        if (!opts.silent) notify.success('Synchronisiert', 'Änderungen von anderen Geräten übernommen.');
      } else if (!opts.silent) {
        notify.success('Synchronisiert', 'Alle Geräte sind auf demselben Stand.');
      }
    } catch (err) {
      if (!this.vault.isUnlocked) return;
      this.dirty = true;
      if (err instanceof GoogleAuthError) this.syncState = 'expired';
      else {
        this.syncState = 'error';
        this.syncError = errorMessage(err);
      }
      if (!opts.silent) notify.error('Synchronisierung fehlgeschlagen', errorMessage(err));
    } finally {
      this.renderPill();
    }
  }

  private openPasswordDialog(): void {
    const remote = this.pendingRemote;
    if (!remote) return;
    openModal(
      {
        title: 'Cloud-Tresor ist anders verschlüsselt',
        description:
          'Wahrscheinlich wurde das Master-Passwort auf einem anderen Gerät geändert. Gib das Passwort des Cloud-Tresors ein, um beide Stände zusammenzuführen.',
        size: 'sm',
      },
      (body, close) => {
        const pw = passwordField({ placeholder: 'Passwort des Cloud-Tresors', autocomplete: 'current-password', autofocus: true });
        const error = h('p', { class: 'hidden text-sm text-rose-400', attrs: { role: 'alert' } });
        const submit = h('button', { class: 'btn-primary', type: 'submit' }, icon('unlock'), 'Zusammenführen');
        const overwrite = h(
          'button',
          {
            class: 'btn-ghost text-rose-400 hover:bg-rose-500/10 hover:text-rose-400',
            type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Cloud-Kopie überschreiben?',
                description: 'Der Stand in Google Drive wird durch den Stand dieses Geräts ersetzt. Änderungen, die nur in der Cloud liegen, gehen verloren.',
                confirmLabel: 'Überschreiben',
                danger: true,
              });
              if (!ok) return;
              try {
                await this.sync.uploadLocal();
                this.resolvePasswordState();
                notify.success('Cloud-Kopie überschrieben', 'Andere Geräte fragen jetzt nach dem Passwort dieses Geräts.');
                close();
              } catch (err) {
                notify.error('Überschreiben fehlgeschlagen', errorMessage(err));
              }
            },
          },
          'Cloud überschreiben',
        );
        body.append(
          h(
            'form',
            {
              class: 'space-y-4',
              onSubmit: async (e: SubmitEvent) => {
                e.preventDefault();
                submit.disabled = true;
                error.classList.add('hidden');
                try {
                  await this.sync.adoptRemote(remote, pw.input.value);
                  this.resolvePasswordState();
                  this.host.changed();
                  notify.success('Zusammengeführt', 'Dieses Gerät verwendet jetzt das Passwort des Cloud-Tresors.');
                  close();
                } catch (err) {
                  error.textContent = errorMessage(err);
                  error.classList.remove('hidden');
                  pw.input.select();
                } finally {
                  submit.disabled = false;
                }
              },
            },
            pw.el,
            error,
            h('div', { class: 'flex flex-wrap justify-end gap-2' }, overwrite, h('button', { class: 'btn-ghost', type: 'button', onClick: close }, 'Später'), submit),
          ),
        );
      },
    );
  }

  private resolvePasswordState(): void {
    this.pendingRemote = undefined;
    this.syncState = 'ok';
    this.lastSyncAt = Date.now();
    this.renderPill();
  }

  /** Lock screen: installs the vault from Google Drive on a new device. */
  async loadFromCloud(): Promise<void> {
    await this.drive.connect();
    const remote = await this.drive.download();
    if (!remote) {
      throw new AppError(
        'In deinem Google Drive liegt noch kein Pakettracker-Tresor. Aktiviere die Synchronisierung zuerst auf deinem anderen Gerät (Einstellungen → Geräte-Synchronisierung).',
      );
    }
    this.vault.installEnvelope(remote.envelope);
    setSyncEnabled(true);
  }

  syncSettings(): SyncSettings {
    return {
      configured: this.configured,
      enabled: isSyncEnabled(),
      account: this.auth.account,
      status: this.syncStatusText(),
      enable: async () => {
        await this.drive.connect();
        this.auth.account ??= await this.drive.accountEmail().catch(() => undefined);
        setSyncEnabled(true);
        this.syncState = 'idle';
        await this.syncNow({ silent: true });
        if ((this.syncState as SyncState) === 'ok') notify.success('Synchronisierung aktiv', 'Melde dich auf deinen anderen Geräten mit „Tresor aus Google Drive laden“ an.');
      },
      syncNow: () => this.syncNow(),
      disable: async (deleteRemote: boolean) => {
        if (deleteRemote) {
          await this.drive.connect();
          await this.drive.deleteRemote();
        }
        setSyncEnabled(false);
        this.syncState = 'off';
        if (!this.vault.data.inbox.enabled) await this.auth.revoke();
        this.renderPill();
        notify.info('Synchronisierung beendet', deleteRemote ? 'Die Cloud-Kopie wurde gelöscht.' : 'Die Daten auf diesem Gerät bleiben erhalten.');
      },
    };
  }

  private syncStatusText(): string {
    switch (this.syncState) {
      case 'syncing':
        return 'Synchronisiere …';
      case 'ok':
        return this.lastSyncAt ? `Synchronisiert ${formatRelative(new Date(this.lastSyncAt).toISOString())}` : 'Synchronisiert';
      case 'expired':
        return 'Pausiert – Google-Verbindung abgelaufen';
      case 'error':
        return `Fehler: ${this.syncError ?? 'unbekannt'}`;
      case 'needs-password':
        return 'Passwort des Cloud-Tresors benötigt';
      case 'idle':
        return 'Bereit';
      default:
        return 'Aus';
    }
  }

  /** Header status chip (hidden while sync is off). */
  syncPill(): HTMLElement {
    this.pill = h('button', { type: 'button' });
    this.renderPill();
    return this.pill;
  }

  private renderPill(): void {
    const pill = this.pill;
    if (!pill) return;
    if (!this.configured || !isSyncEnabled() || this.syncState === 'off') {
      pill.className = 'hidden';
      return;
    }
    const meta: Record<Exclude<SyncState, 'off'>, { icon: IconName; label: string; cls: string; spin?: boolean }> = {
      idle: { icon: 'cloud', label: 'Sync', cls: 'text-muted' },
      syncing: { icon: 'refresh', label: 'Synchronisiere …', cls: 'text-sky-400', spin: true },
      ok: { icon: 'cloudCheck', label: 'Synchronisiert', cls: 'border-emerald-400/20 bg-emerald-400/5 text-emerald-400' },
      expired: { icon: 'cloudOff', label: 'Sync pausiert', cls: 'border-amber-400/25 bg-amber-400/10 text-amber-400' },
      error: { icon: 'cloudAlert', label: 'Sync-Fehler', cls: 'border-rose-400/25 bg-rose-400/10 text-rose-400' },
      'needs-password': { icon: 'cloudAlert', label: 'Passwort nötig', cls: 'border-amber-400/25 bg-amber-400/10 text-amber-400' },
    };
    const m = meta[this.syncState];
    pill.className = cx('chip transition hover:border-line-strong', m.cls);
    pill.title = this.syncStatusText();
    pill.setAttribute('aria-label', `Synchronisierung: ${this.syncStatusText()}`);
    pill.onclick = () => {
      if (this.syncState === 'expired') void this.connectAll();
      else if (this.syncState === 'needs-password') this.openPasswordDialog();
      else void this.syncNow();
    };
    pill.replaceChildren(icon(m.icon, cx('size-3.5', m.spin && 'animate-spin')), h('span', { class: 'hidden sm:inline' }, m.label));
  }

  /* ------------------------------ Gmail ------------------------------ */

  /** Requests Gmail access (user gesture), enables the integration and scans. */
  async connectGmail(): Promise<void> {
    try {
      await this.auth.ensure([SCOPES.gmail, ...(isSyncEnabled() ? [SCOPES.drive] : [])]);
      if (!this.vault.isUnlocked) return;
      if (!this.vault.data.inbox.enabled || !this.vault.data.inbox.account) {
        const account = await this.gmail.profileEmail();
        this.auth.account ??= account || undefined;
        await this.vault.update((d) => {
          d.inbox.enabled = true;
          d.inbox.account = account || d.inbox.account;
        });
        notify.success('Gmail verbunden', account || undefined);
      }
      this.host.changed();
      if (isSyncEnabled() && this.syncState === 'expired') await this.syncNow({ silent: true });
      await this.runScan();
    } catch (err) {
      if (this.vault.isUnlocked) this.renderInbox();
      notify.error('Gmail-Verbindung fehlgeschlagen', errorMessage(err));
    }
  }

  async runScan(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.scanning || !this.vault.isUnlocked) return;
    if (!this.gmail.hasValidToken) {
      this.renderInbox();
      return;
    }
    this.scanning = true;
    this.renderInbox();
    try {
      const r = await scanInbox(this.vault, this.gmail);
      if (!this.vault.isUnlocked) return;
      const parts: string[] = [];
      if (r.added.length) parts.push(`${r.added.length} neu hinzugefügt`);
      if (r.suggested) parts.push(`${r.suggested} Vorschl${r.suggested === 1 ? 'ag' : 'äge'}`);
      if (r.updated) parts.push(`${r.updated} Status-Update${r.updated === 1 ? '' : 's'}`);
      if (parts.length) notify.success('Postfach gescannt', parts.join(' · '));
      else if (!opts.silent) {
        if (r.found === 0) {
          notify.info('Keine Versand-Mails gefunden', 'Seit dem letzten Scan (bzw. in den letzten 30 Tagen) kam keine Mail von Paketdiensten oder Shops.');
        } else if (r.scanned === 0) {
          toast(
            'info',
            `${r.found} Versand-Mail${r.found === 1 ? '' : 's'} gefunden – alle schon verarbeitet`,
            'Gelöschte Pakete werden absichtlich nicht erneut importiert. Zum Neu-Einlesen: Einstellungen → Postfach → „Neu einlesen“.',
            9000,
          );
        } else {
          notify.info('Postfach gescannt', `${r.scanned} Mail${r.scanned === 1 ? '' : 's'} geprüft – keine neuen Sendungsnummern.`);
        }
      }
      if (r.failed && !opts.silent) notify.warning(`${r.failed} Mail(s) konnten nicht geladen werden`, 'Sie werden beim nächsten Scan erneut versucht.');
    } catch (err) {
      if (!this.vault.isUnlocked) return;
      if (!opts.silent || !(err instanceof GoogleAuthError)) notify.error('Postfach-Scan fehlgeschlagen', errorMessage(err));
    } finally {
      this.scanning = false;
      if (this.vault.isUnlocked) this.host.changed();
    }
  }

  mailSettings(): MailSettings {
    return {
      configured: this.configured,
      connect: () => this.connectGmail(),
      disconnect: async () => {
        await this.vault.update((d) => (d.inbox.enabled = false));
        // keep the grant if Drive sync still needs the Google login
        if (!isSyncEnabled()) await this.auth.revoke();
        this.host.changed();
        notify.info('Gmail getrennt', isSyncEnabled() ? 'Das Postfach wird nicht mehr gelesen.' : 'Der Zugriff wurde bei Google widerrufen.');
      },
      resetHistory: async () => {
        await resetScanHistory(this.vault);
        this.host.changed();
        if (this.gmail.hasValidToken) await this.runScan();
        else await this.connectGmail(); // the click is a user gesture → popup allowed
      },
    };
  }

  mountInbox(host: HTMLElement): void {
    this.inboxHost = host;
    this.renderInbox();
  }

  renderInbox(): void {
    const host = this.inboxHost;
    if (!host || !this.vault.isUnlocked) return;
    if (!this.configured) {
      host.replaceChildren();
      return;
    }
    const guard = (fn: () => Promise<void>) => () => void fn().catch((err) => notify.error('Aktion fehlgeschlagen', errorMessage(err)));
    host.replaceChildren(
      inboxPanel({
        inbox: this.vault.data.inbox,
        tokenValid: this.gmail.hasValidToken,
        scanning: this.scanning,
        onConnect: () => void this.connectGmail(),
        onScan: () => void this.runScan(),
        onAccept: (id) =>
          guard(async () => {
            const s = await acceptSuggestion(this.vault, id);
            this.host.changed();
            if (s) notify.success('Sendung übernommen', s.label);
          })(),
        onDismiss: (id) =>
          guard(async () => {
            await dismissSuggestion(this.vault, id);
            this.host.changed();
          })(),
        onAcceptAll: guard(async () => {
          const ids = this.vault.data.inbox.suggestions.map((s) => s.id);
          for (const id of ids) await acceptSuggestion(this.vault, id);
          this.host.changed();
          notify.success('Vorschläge übernommen', `${ids.length} Sendungen hinzugefügt`);
        }),
      }),
    );
  }
}

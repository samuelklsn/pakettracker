import { errorMessage } from './core/errors';
import { uid } from './core/id';
import type { CarrierId, Shipment, ShipmentStatus } from './core/types';
import { AutoLockService } from './services/autolock.service';
import { CARRIERS } from './services/carriers';
import type { DetectionResult } from './services/detection.service';
import { StorageService } from './services/storage.service';
import { TrackingService, type TrackingResult, deriveStatus } from './services/tracking.service';
import { VaultService } from './services/vault.service';
import { emptyState } from './ui/components/empty-state';
import { lockScreen } from './ui/components/lock-screen';
import { openSettings } from './ui/components/settings-modal';
import { shipmentCard } from './ui/components/shipment-card';
import { openShipmentDetail } from './ui/components/shipment-detail';
import { type ShipmentFormValues, formValuesFrom, shipmentForm } from './ui/components/shipment-form';
import { listSkeleton } from './ui/components/skeleton';
import { smartInput } from './ui/components/smart-input';
import { cx, h } from './ui/dom';
import { icon, type IconName } from './ui/icons';
import { closeAllModals } from './ui/modal';
import { notify } from './ui/toast';
import { getTheme, toggleTheme } from './ui/theme';

type Filter = 'active' | 'delivered' | 'archived' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'Aktiv' },
  { id: 'delivered', label: 'Zugestellt' },
  { id: 'all', label: 'Alle' },
  { id: 'archived', label: 'Archiv' },
];

const SORT_PRIORITY: Record<ShipmentStatus, number> = {
  out_for_delivery: 0,
  exception: 1,
  in_transit: 2,
  pre_transit: 3,
  delivered: 4,
};

const REMOTE_STALE_MS = 10 * 60_000;
const INITIAL_SKELETON_MS = 380;

/**
 * Application controller: wires services to views. Contains no crypto or storage logic itself.
 */
export class App {
  private readonly storage = new StorageService();
  private readonly vault = new VaultService(this.storage);
  private readonly tracking = new TrackingService();
  private readonly autoLock = new AutoLockService(() => this.lock('Automatisch gesperrt nach Inaktivität'));
  private readonly listeners = new Set<() => void>();

  private filter: Filter = 'active';
  private query = '';
  private queryEmail: string | null = null;
  private loading = false;

  // dashboard element refs
  private listHost: HTMLElement | null = null;
  private statsHost: HTMLElement | null = null;
  private tabsHost: HTMLElement | null = null;
  private vaultPill: HTMLElement | null = null;

  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.storage.onExternalChange(() => void this.onExternalChange());
    document.addEventListener('keydown', (e) => this.onGlobalKey(e));
  }

  start(): void {
    this.render();
  }

  /* --------------------------------- Routing --------------------------------- */

  private render(): void {
    this.listHost = this.statsHost = this.tabsHost = this.vaultPill = null;
    if (!this.vault.isUnlocked) {
      document.title = 'Gesperrt · Pakettracker';
      this.root.replaceChildren(
        lockScreen({
          mode: this.vault.hasVault() ? 'unlock' : 'setup',
          onCreate: async (pw) => {
            await this.vault.create(pw);
            notify.success('Tresor erstellt', 'Dein Schlüssel existiert nur in diesem Browser-Tab.');
            this.afterUnlock();
          },
          onUnlock: async (pw) => {
            await this.vault.unlock(pw);
            this.afterUnlock();
          },
          onReset: () => {
            this.vault.destroy();
            notify.info('Tresor gelöscht', 'Du kannst jetzt einen neuen Tresor anlegen.');
            this.render();
          },
        }),
      );
      return;
    }
    document.title = 'Pakettracker';
    this.root.replaceChildren(this.dashboard());
    void this.initialLoad();
  }

  private afterUnlock(): void {
    this.autoLock.start(this.vault.data.settings.autoLockMinutes);
    this.filter = 'active';
    this.query = '';
    this.queryEmail = null;
    this.render();
  }

  private lock(reason?: string): void {
    if (!this.vault.isUnlocked) return;
    this.vault.lock();
    this.autoLock.stop();
    this.listeners.clear();
    closeAllModals();
    this.render();
    notify.info('Tresor gesperrt', reason ?? 'Der Schlüssel wurde aus dem Speicher entfernt.');
  }

  private async onExternalChange(): Promise<void> {
    if (!this.vault.isUnlocked) {
      this.render(); // e.g. vault created/deleted in another tab
      return;
    }
    const result = await this.vault.reloadFromStorage();
    if (result === 'locked') {
      this.autoLock.stop();
      this.listeners.clear();
      closeAllModals();
      this.render();
      notify.warning('Tresor gesperrt', 'Der Tresor wurde in einem anderen Tab geändert.');
    } else {
      this.changed();
    }
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (!this.vault.isUnlocked) return;
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('form[role="search"] input')?.focus();
    }
    if (e.key.toLowerCase() === 'l' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      this.lock();
    }
  }

  /* --------------------------------- State --------------------------------- */

  private subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed(): void {
    this.renderStats();
    this.renderTabs();
    this.renderList();
    this.updateVaultPill();
    for (const fn of [...this.listeners]) fn();
  }

  private find(id: string): Shipment | undefined {
    return this.vault.data.shipments.find((s) => s.id === id);
  }

  private async mutate(fn: (shipments: Shipment[]) => void): Promise<void> {
    try {
      await this.vault.update((d) => fn(d.shipments));
      this.autoLock.start(this.vault.data.settings.autoLockMinutes);
      this.changed();
    } catch (err) {
      notify.error('Speichern fehlgeschlagen', errorMessage(err));
      throw err;
    }
  }

  private async addShipment(values: ShipmentFormValues): Promise<void> {
    const now = new Date().toISOString();
    const shipment: Shipment = { id: uid(), ...values, events: [], archived: false, createdAt: now, updatedAt: now };
    await this.mutate((list) => list.unshift(shipment));
    notify.success('Sendung hinzugefügt', `${values.label} · ${CARRIERS[values.carrier].name}`);
    this.filter = 'active';
    this.changed();
  }

  private async updateShipment(id: string, fn: (s: Shipment) => void): Promise<void> {
    await this.mutate((list) => {
      const s = list.find((x) => x.id === id);
      if (!s) return;
      fn(s);
      s.updatedAt = new Date().toISOString();
    });
  }

  private async track(s: Shipment, force = false): Promise<TrackingResult> {
    let warning: string | undefined;
    const stale = !s.remote || Date.now() - Date.parse(s.remote.fetchedAt) > REMOTE_STALE_MS;
    if (this.tracking.hasRemote && (force || stale)) {
      const result = await this.tracking.track(s);
      if (result.source === 'remote') {
        await this.vault.update((d) => {
          const target = d.shipments.find((x) => x.id === s.id);
          if (target) {
            target.remote = {
              fetchedAt: result.fetchedAt,
              status: result.status,
              events: result.events,
              estimatedDelivery: result.estimatedDelivery,
            };
          }
        });
        this.renderList();
        this.renderStats();
      } else {
        warning = result.warning;
      }
    }
    const fresh = this.find(s.id) ?? s;
    return { ...(await this.tracking.fromCache(fresh)), warning };
  }

  /** Initial dashboard data load – shows skeletons while remote tracking refreshes. */
  private async initialLoad(): Promise<void> {
    this.loading = true;
    this.renderList();
    const started = performance.now();
    if (this.tracking.hasRemote) {
      const active = this.vault.data.shipments.filter((s) => !s.archived && deriveStatus(s) !== 'delivered');
      // limited concurrency to be gentle with the proxy
      const queue = [...active];
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let s = queue.shift(); s; s = queue.shift()) await this.track(s).catch(() => undefined);
        }),
      );
    }
    const wait = INITIAL_SKELETON_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.loading = false;
    if (this.vault.isUnlocked) this.renderList();
  }

  /* --------------------------------- Actions --------------------------------- */

  private onSmartSubmit = (d: DetectionResult, carrier: CarrierId | null): void => {
    if (d.kind === 'email') {
      shipmentForm({ email: d.email }, 'create', (v) => this.addShipment(v));
      notify.info('E-Mail übernommen', 'Ergänze jetzt die Sendungsnummer.');
      return;
    }
    if (d.kind === 'url' && !d.trackingNumber) {
      shipmentForm({ sourceUrl: d.url, carrier: carrier ?? 'other' }, 'create', (v) => this.addShipment(v));
      notify.warning('Keine Sendungsnummer im Link gefunden', 'Bitte manuell eintragen.');
      return;
    }
    if (d.kind === 'unknown' && !d.trackingNumber) {
      notify.info('Kein Tracking-Format erkannt', 'Die Eingabe wird als Suche verwendet.');
      return;
    }
    const n = d.trackingNumber!;
    const existing = this.vault.data.shipments.find((s) => s.trackingNumber === n);
    if (existing) {
      this.openDetail(existing.id);
      return;
    }
    shipmentForm(
      { trackingNumber: n, carrier: carrier ?? 'other', sourceUrl: d.kind === 'url' ? d.url : undefined },
      'create',
      async (v) => {
        await this.addShipment(v);
        this.smart?.reset();
      },
    );
  };

  private smart: ReturnType<typeof smartInput> | null = null;

  private openDetail(id: string): void {
    openShipmentDetail(
      {
        getShipment: (x) => (this.vault.isUnlocked ? this.find(x) : undefined),
        updateShipment: (x, fn) => this.updateShipment(x, fn),
        deleteShipment: (x) => this.mutate((list) => list.splice(list.findIndex((s) => s.id === x), 1)),
        editShipment: (s) =>
          shipmentForm(formValuesFrom(s), 'edit', async (v) => {
            await this.updateShipment(s.id, (x) => Object.assign(x, v));
            notify.success('Änderungen gespeichert');
          }),
        track: (s, force) => this.track(s, force),
        hasRemote: this.tracking.hasRemote,
        subscribe: this.subscribe,
      },
      id,
    );
  }

  /* --------------------------------- Views --------------------------------- */

  private dashboard(): HTMLElement {
    this.smart = smartInput({
      onSubmit: this.onSmartSubmit,
      onQuery: (q, d) => {
        this.query = q;
        this.queryEmail = d.kind === 'email' ? (d.email ?? null) : null;
        this.renderList();
      },
      findExisting: (n) => this.vault.data.shipments.find((s) => s.trackingNumber === n)?.label ?? null,
    });

    this.vaultPill = h('span', { class: 'chip hidden border-emerald-400/20 bg-emerald-400/5 text-emerald-400 sm:inline-flex' });
    this.statsHost = h('div', { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' });
    this.tabsHost = h('div', { class: 'flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1', attrs: { role: 'tablist' } });
    this.listHost = h('div', { attrs: { role: 'tabpanel' } });

    const themeBtn = h('button', {
      class: 'icon-btn',
      type: 'button',
      attrs: { 'aria-label': 'Farbschema wechseln', title: 'Hell / Dunkel' },
      onClick: () => {
        const t = toggleTheme();
        themeBtn.replaceChildren(icon(t === 'dark' ? 'sun' : 'moon', 'size-[18px]'));
      },
    });
    themeBtn.append(icon(getTheme() === 'dark' ? 'sun' : 'moon', 'size-[18px]'));

    const view = h(
      'div',
      { class: 'min-h-dvh' },
      h(
        'header',
        { class: 'sticky top-0 z-40 border-b border-line bg-bg/70 backdrop-blur-xl' },
        h(
          'div',
          { class: 'mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6' },
          h(
            'div',
            { class: 'flex items-center gap-2.5' },
            h('span', { class: 'flex size-8 items-center justify-center rounded-lg bg-fg text-bg' }, icon('package', 'size-4.5', 2)),
            h('span', { class: 'text-[15px] font-semibold tracking-tight' }, 'Pakettracker'),
          ),
          this.vaultPill,
          h(
            'div',
            { class: 'ml-auto flex items-center gap-1' },
            themeBtn,
            h(
              'button',
              {
                class: 'icon-btn',
                type: 'button',
                attrs: { 'aria-label': 'Einstellungen', title: 'Einstellungen' },
                onClick: () =>
                  openSettings({
                    vault: this.vault,
                    onDataChanged: () => {
                      this.autoLock.start(this.vault.data.settings.autoLockMinutes);
                      this.changed();
                    },
                    onDestroyed: () => {
                      this.autoLock.stop();
                      this.render();
                    },
                  }),
              },
              icon('settings', 'size-[18px]'),
            ),
            h(
              'button',
              { class: 'btn-secondary ml-1 h-9 rounded-lg px-3', type: 'button', attrs: { title: 'Sperren (Strg+Shift+L)' }, onClick: () => this.lock() },
              icon('lock', 'size-4'),
              h('span', { class: 'hidden sm:inline' }, 'Sperren'),
            ),
          ),
        ),
      ),
      h(
        'main',
        { class: 'mx-auto max-w-5xl space-y-8 px-4 pt-10 pb-24 sm:px-6' },
        h(
          'section',
          { class: 'space-y-5' },
          h(
            'div',
            null,
            h('h1', { class: 'text-2xl font-semibold tracking-tight text-fg sm:text-3xl' }, 'Deine Sendungen'),
            h('p', { class: 'mt-1.5 text-sm text-muted' }, 'Einfügen, erkennen, verfolgen – Ende-zu-Ende verschlüsselt auf deinem Gerät.'),
          ),
          this.smart.el,
        ),
        this.statsHost,
        h(
          'section',
          { class: 'space-y-4' },
          h('div', { class: 'flex items-center justify-between gap-3' }, this.tabsHost),
          this.listHost,
        ),
      ),
      h(
        'footer',
        { class: 'mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 pb-10 text-xs text-subtle sm:px-6' },
        h('span', { class: 'inline-flex items-center gap-1.5' }, icon('shield', 'size-3.5'), 'Zero-Knowledge · Daten verlassen dein Gerät nur verschlüsselt'),
        h('span', null, h('span', { class: 'kbd' }, '/'), ' Suchen · ', h('span', { class: 'kbd' }, 'Strg ⇧ L'), ' Sperren'),
      ),
    );

    this.renderStats();
    this.renderTabs();
    this.updateVaultPill();
    return view;
  }

  private updateVaultPill(): void {
    if (!this.vaultPill) return;
    const n = this.vault.data.shipments.length;
    this.vaultPill.replaceChildren(icon('lock', 'size-3'), `Entschlüsselt · ${n} Sendung${n === 1 ? '' : 'en'}`);
  }

  private renderStats(): void {
    if (!this.statsHost) return;
    const list = this.vault.data.shipments.filter((s) => !s.archived);
    const count = (st: ShipmentStatus[]) => list.filter((s) => st.includes(deriveStatus(s))).length;
    const tile = (label: string, value: number, iconName: IconName, cls: string) =>
      h(
        'div',
        { class: 'glass rounded-2xl p-4' },
        h('div', { class: 'flex items-center justify-between' }, h('span', { class: 'text-xs font-medium text-muted' }, label), h('span', { class: cls }, icon(iconName))),
        h('p', { class: 'mt-2 text-2xl font-semibold tracking-tight text-fg tabular-nums' }, value),
      );
    this.statsHost.replaceChildren(
      tile('Aktiv', count(['pre_transit', 'in_transit', 'out_for_delivery', 'exception']), 'package', 'text-accent'),
      tile('Unterwegs', count(['in_transit']), 'truck', 'text-sky-400'),
      tile('In Zustellung', count(['out_for_delivery']), 'pin', 'text-violet-400'),
      tile('Zugestellt', count(['delivered']), 'packageCheck', 'text-emerald-400'),
    );
  }

  private renderTabs(): void {
    if (!this.tabsHost) return;
    const counts: Record<Filter, number> = { active: 0, delivered: 0, archived: 0, all: 0 };
    for (const s of this.vault.data.shipments) {
      if (s.archived) {
        counts.archived++;
        continue;
      }
      counts.all++;
      if (deriveStatus(s) === 'delivered') counts.delivered++;
      else counts.active++;
    }
    this.tabsHost.replaceChildren(
      ...FILTERS.map((f) =>
        h(
          'button',
          {
            type: 'button',
            class: cx(
              'inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition',
              this.filter === f.id ? 'bg-elevated text-fg shadow-sm ring-1 ring-line-strong' : 'text-muted hover:text-fg',
            ),
            attrs: { role: 'tab', 'aria-selected': String(this.filter === f.id) },
            onClick: () => {
              this.filter = f.id;
              this.renderTabs();
              this.renderList();
            },
          },
          f.label,
          h('span', { class: 'rounded-md bg-fg/5 px-1.5 text-[11px] text-subtle tabular-nums' }, counts[f.id]),
        ),
      ),
    );
  }

  private visibleShipments(): Shipment[] {
    const q = this.query.toLowerCase();
    const compact = q.replace(/[\s-]+/g, '');
    return this.vault.data.shipments
      .filter((s) => {
        const status = deriveStatus(s);
        switch (this.filter) {
          case 'active':
            if (s.archived || status === 'delivered') return false;
            break;
          case 'delivered':
            if (s.archived || status !== 'delivered') return false;
            break;
          case 'archived':
            if (!s.archived) return false;
            break;
          case 'all':
            if (s.archived) return false;
        }
        if (!q) return true;
        if (this.queryEmail) return s.email?.toLowerCase() === this.queryEmail;
        return (
          s.label.toLowerCase().includes(q) ||
          s.trackingNumber.toLowerCase().includes(compact) ||
          (s.email?.toLowerCase().includes(q) ?? false) ||
          (s.notes?.toLowerCase().includes(q) ?? false) ||
          CARRIERS[s.carrier].name.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => SORT_PRIORITY[deriveStatus(a)] - SORT_PRIORITY[deriveStatus(b)] || b.updatedAt.localeCompare(a.updatedAt));
  }

  private renderList(): void {
    if (!this.listHost) return;
    if (this.loading) {
      this.listHost.replaceChildren(listSkeleton(Math.min(4, Math.max(2, this.vault.data.shipments.length))));
      return;
    }
    const total = this.vault.data.shipments.length;
    const items = this.visibleShipments();

    if (total === 0) {
      this.listHost.replaceChildren(
        emptyState({
          icon: 'inbox',
          title: 'Noch keine Sendungen',
          description: 'Füge oben eine Sendungsnummer oder einen Tracking-Link ein – der Carrier wird automatisch erkannt.',
          hints: ['1Z999AA10123456784', '00340434161234567890', 'tracking.dpd.de/…'],
          action: { label: 'Erste Sendung hinzufügen', onClick: () => this.smart?.focus() },
        }),
      );
      return;
    }
    if (items.length === 0) {
      this.listHost.replaceChildren(
        this.query
          ? emptyState({ icon: 'search', title: 'Keine Treffer', description: `Keine Sendung passt zu „${this.query}“ in diesem Filter.` })
          : emptyState({
              icon: this.filter === 'archived' ? 'box' : 'packageCheck',
              title: this.filter === 'archived' ? 'Archiv ist leer' : this.filter === 'delivered' ? 'Noch nichts zugestellt' : 'Alles erledigt',
              description:
                this.filter === 'active' ? 'Keine aktiven Sendungen – alle Pakete sind angekommen. 🎉' : 'Hier erscheinen Sendungen, sobald sie diesem Filter entsprechen.',
            }),
      );
      return;
    }
    this.listHost.replaceChildren(
      h('div', { class: 'grid gap-3 sm:grid-cols-2' }, ...items.map((s) => shipmentCard(s, (x) => this.openDetail(x.id)))),
    );
  }
}

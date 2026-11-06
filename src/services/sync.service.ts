import type { DriveService, RemoteVault } from './drive.service';
import { fingerprint, mergeVaults } from './sync-merge';
import type { VaultService } from './vault.service';

/**
 * SyncService – end-to-end encrypted multi-device sync.
 *
 *   download remote envelope → decrypt with session key → merge (CRDT-like) → save local → upload
 *
 * Only ciphertext ever leaves the device. If the remote envelope was encrypted with a different
 * key (password changed on another device / different vault) the caller is asked for that password.
 */

export type SyncOutcome = 'uploaded' | 'downloaded' | 'merged' | 'unchanged' | 'needs-password';

export interface SyncResult {
  outcome: SyncOutcome;
  /** set for `needs-password` */
  remote?: RemoteVault;
}

const DEVICE_FLAG = 'pakettracker.sync';

/** Whether sync is enabled on THIS device (device-local, not part of the synced data). */
export function isSyncEnabled(): boolean {
  try {
    return localStorage.getItem(DEVICE_FLAG) === 'gdrive';
  } catch {
    return false;
  }
}

export function setSyncEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(DEVICE_FLAG, 'gdrive');
    else localStorage.removeItem(DEVICE_FLAG);
  } catch {
    /* ignore */
  }
}

const same = (a: Parameters<typeof fingerprint>[0], b: Parameters<typeof fingerprint>[0]) => fingerprint(a) === fingerprint(b);

export class SyncService {
  private readonly vault: VaultService;
  private readonly drive: DriveService;
  private running: Promise<SyncResult> | null = null;

  constructor(vault: VaultService, drive: DriveService) {
    this.vault = vault;
    this.drive = drive;
  }

  /** Runs one sync cycle. Concurrent calls share the running cycle. */
  sync(): Promise<SyncResult> {
    this.running ??= this.cycle().finally(() => (this.running = null));
    return this.running;
  }

  private async cycle(): Promise<SyncResult> {
    const remote = await this.drive.download();
    if (!remote) {
      await this.uploadLocal();
      return { outcome: 'uploaded' };
    }
    const opened = await this.vault.openWithSessionKey(remote.envelope);
    if (!opened) return { outcome: 'needs-password', remote };

    const localChanged = await this.vault.mergeIn(opened.data, mergeVaults, same);
    // encrypted with an old key (password changed here) → the cloud copy must be re-keyed
    const remoteChanged = !opened.currentKey || !same(this.vault.data, opened.data);
    if (remoteChanged) await this.uploadLocal();
    return {
      outcome: localChanged && remoteChanged ? 'merged' : localChanged ? 'downloaded' : remoteChanged ? 'uploaded' : 'unchanged',
    };
  }

  /** Resolves `needs-password`: merges the remote vault using ITS password and adopts its key. */
  async adoptRemote(remote: RemoteVault, password: string): Promise<void> {
    await this.vault.adoptEnvelope(remote.envelope, password, mergeVaults);
    await this.uploadLocal();
  }

  /** Overwrites the cloud copy with this device's vault. */
  async uploadLocal(): Promise<void> {
    const env = this.vault.envelope();
    if (!env) throw new Error('Kein lokaler Tresor');
    await this.drive.upload(env);
  }
}

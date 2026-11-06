import { type GoogleAuthService, GoogleApiError, SCOPES } from './google-auth.service';
import { type VaultEnvelope, parseEnvelope } from './storage.service';

/**
 * DriveService – stores the ENCRYPTED vault envelope in the user's Google Drive
 * `appDataFolder`: a hidden, app-private folder. The app can't see any other Drive file and
 * the file contains only ciphertext (AES-256-GCM) – Google can't read it.
 */

const FILE_NAME = 'pakettracker-vault.json';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export interface RemoteVault {
  fileId: string;
  envelope: VaultEnvelope;
}

export class DriveService {
  private readonly auth: GoogleAuthService;
  private fileId: string | null = null;

  constructor(auth: GoogleAuthService) {
    this.auth = auth;
  }

  get configured(): boolean {
    return this.auth.configured;
  }

  get hasValidToken(): boolean {
    return this.auth.hasToken(SCOPES.drive);
  }

  /** Opens the Google popup if needed – call from a user gesture. */
  connect(): Promise<void> {
    return this.auth.ensure([SCOPES.drive]);
  }

  async accountEmail(): Promise<string | undefined> {
    const about = await this.auth.getJson<{ user?: { emailAddress?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      SCOPES.drive,
    );
    return about.user?.emailAddress;
  }

  private async findFileId(): Promise<string | null> {
    if (this.fileId) return this.fileId;
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${FILE_NAME}' and trashed = false`,
      fields: 'files(id,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '10',
    });
    const res = await this.auth.getJson<{ files?: { id: string }[] }>(`${FILES}?${q}`, SCOPES.drive);
    this.fileId = res.files?.[0]?.id ?? null;
    return this.fileId;
  }

  /** Downloads and validates the remote envelope (still encrypted). null = nothing stored yet. */
  async download(): Promise<RemoteVault | null> {
    const id = await this.findFileId();
    if (!id) return null;
    let res: Response;
    try {
      res = await this.auth.fetch(`${FILES}/${encodeURIComponent(id)}?alt=media`, {}, SCOPES.drive);
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) {
        this.fileId = null; // deleted from another device
        return null;
      }
      throw err;
    }
    const text = await res.text();
    if (text.length > 5 * 1024 * 1024) throw new GoogleApiError('Cloud-Tresor ist zu groß');
    return { fileId: id, envelope: parseEnvelope(JSON.parse(text)) };
  }

  /** Creates or overwrites the remote envelope. */
  async upload(envelope: VaultEnvelope): Promise<void> {
    const body = JSON.stringify(parseEnvelope(envelope));
    const id = await this.findFileId();
    if (id) {
      try {
        await this.auth.fetch(
          `${UPLOAD}/${encodeURIComponent(id)}?uploadType=media&fields=id`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
          SCOPES.drive,
        );
        return;
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
        this.fileId = null; // file vanished → create a new one
      }
    }
    const boundary = `pakettracker-${crypto.randomUUID()}`;
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await this.auth.fetch(
      `${UPLOAD}?uploadType=multipart&fields=id`,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart },
      SCOPES.drive,
    );
    this.fileId = ((await res.json()) as { id: string }).id;
  }

  /** Deletes the cloud copy (local data stays untouched). */
  async deleteRemote(): Promise<void> {
    const id = await this.findFileId();
    if (!id) return;
    await this.auth.fetch(`${FILES}/${encodeURIComponent(id)}`, { method: 'DELETE' }, SCOPES.drive);
    this.fileId = null;
  }
}

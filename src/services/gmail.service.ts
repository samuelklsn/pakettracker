import { AppError } from '../core/errors';
import { type MailMessage, extractLinks, htmlToText } from './mail-extract.service';

/**
 * GmailService – read-only mailbox access directly from the browser.
 *
 *  - OAuth 2.0 token flow via Google Identity Services (GIS), scope `gmail.readonly` only.
 *  - The GIS script is loaded lazily, only when the user uses the mailbox feature.
 *  - The access token lives in memory only (≈ 1 h) and is never persisted.
 *  - Mails travel Google → this browser tab. No other server is involved.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 200_000;

export class GmailAuthError extends AppError {}
export class GmailApiError extends AppError {}

/* ---------- Minimal typings for the parts of GIS we use ---------- */
interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string; login_hint?: string }): void;
}
interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type: string; message?: string }) => void;
    login_hint?: string;
  }): TokenClient;
  hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

/* ---------- Gmail REST payload typings ---------- */
interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailRawMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

let gisPromise: Promise<GoogleOAuth2> | null = null;

function loadGis(): Promise<GoogleOAuth2> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts.oauth2);
  gisPromise ??= new Promise<GoogleOAuth2>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.onload = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new GmailAuthError('Google-Anmeldung konnte nicht initialisiert werden.'));
    };
    script.onerror = () => {
      gisPromise = null;
      script.remove();
      reject(new GmailAuthError('Google-Anmeldung konnte nicht geladen werden (Netzwerk oder Content-Blocker?).'));
    };
    document.head.append(script);
  });
  return gisPromise;
}

export class GmailService {
  private readonly clientId: string | undefined;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(clientId: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID) {
    this.clientId = clientId?.trim() || undefined;
  }

  /** true when a Google OAuth client ID was configured at build time */
  get configured(): boolean {
    return !!this.clientId;
  }

  get hasValidToken(): boolean {
    return !!this.token && Date.now() < this.token.expiresAt - 60_000;
  }

  /** Preloads the GIS script so a later click can open the popup immediately. */
  preload(): void {
    if (this.configured) void loadGis().catch(() => undefined);
  }

  /**
   * Requests an access token. Must be triggered by a user gesture (click),
   * otherwise browsers block the Google popup.
   */
  async connect(loginHint?: string): Promise<void> {
    if (!this.clientId) throw new GmailAuthError('Keine Google-Client-ID konfiguriert (VITE_GOOGLE_CLIENT_ID).');
    const oauth2 = await loadGis();
    const clientId = this.clientId;
    const response = await new Promise<TokenResponse>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPE,
        login_hint: loginHint,
        callback: resolve,
        error_callback: (e) =>
          reject(
            new GmailAuthError(
              e.type === 'popup_failed_to_open'
                ? 'Das Google-Popup wurde blockiert. Bitte Popups für diese Seite erlauben und erneut klicken.'
                : e.type === 'popup_closed'
                  ? 'Anmeldung abgebrochen.'
                  : `Google-Anmeldung fehlgeschlagen (${e.type}).`,
            ),
          ),
      });
      client.requestAccessToken({ prompt: '' });
    });

    if (response.error || !response.access_token) {
      throw new GmailAuthError(
        response.error === 'access_denied'
          ? 'Zugriff verweigert. Ist dein Google-Konto als Testnutzer eingetragen?'
          : `Google-Anmeldung fehlgeschlagen: ${response.error_description ?? response.error ?? 'kein Token'}`,
      );
    }
    if (!oauth2.hasGrantedAllScopes(response, GMAIL_SCOPE)) {
      throw new GmailAuthError('Ohne Lesezugriff auf Gmail kann das Postfach nicht durchsucht werden. Bitte die Berechtigung erteilen.');
    }
    const ttl = Number(response.expires_in) || 3600;
    this.token = { value: response.access_token, expiresAt: Date.now() + ttl * 1000 };
  }

  /** Revokes the grant at Google and forgets the token locally. */
  async disconnect(): Promise<void> {
    const token = this.token?.value;
    this.token = null;
    if (!token || !window.google?.accounts?.oauth2) return;
    await new Promise<void>((resolve) => window.google!.accounts!.oauth2!.revoke(token, resolve));
  }

  /** Drops the in-memory token (e.g. when the vault gets locked). */
  forgetToken(): void {
    this.token = null;
  }

  async profileEmail(): Promise<string> {
    const profile = await this.get<{ emailAddress?: string }>('/profile');
    return profile.emailAddress ?? '';
  }

  async listMessageIds(query: string, max = 50): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 100)), includeSpamTrash: 'false' });
    const res = await this.get<{ messages?: { id: string }[] }>(`/messages?${params}`);
    return (res.messages ?? []).map((m) => m.id).filter((id) => /^[0-9a-zA-Z_-]{1,64}$/.test(id));
  }

  async getMessage(id: string): Promise<MailMessage> {
    const raw = await this.get<GmailRawMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    return parseGmailMessage(raw);
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.hasValidToken) throw new GmailAuthError('Die Gmail-Verbindung ist abgelaufen. Bitte erneut verbinden.');
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { Authorization: `Bearer ${this.token!.value}`, Accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch (err) {
      throw new GmailApiError('Gmail ist nicht erreichbar (Netzwerkfehler).', { cause: err });
    }
    if (res.status === 401) {
      this.token = null;
      throw new GmailAuthError('Die Gmail-Verbindung ist abgelaufen. Bitte erneut verbinden.');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
      const reason = body?.error?.errors?.[0]?.reason;
      if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(body?.error?.message ?? '')) {
        throw new GmailApiError('Die Gmail API ist im Google-Cloud-Projekt dieser Client-ID nicht aktiviert.');
      }
      if (res.status === 403) throw new GmailApiError('Gmail verweigert den Zugriff (fehlende Berechtigung).');
      if (res.status === 429) throw new GmailApiError('Gmail-Limit erreicht. Bitte später erneut versuchen.');
      throw new GmailApiError(`Gmail-Fehler (HTTP ${res.status}).`);
    }
    return (await res.json()) as T;
  }
}

/* ------------------------------ MIME parsing (pure) ------------------------------ */

export function decodeBase64Url(data: string, charset = 'utf-8'): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function charsetOf(part: GmailPart): string {
  return /charset="?([\w-]+)"?/i.exec(header(part, 'Content-Type'))?.[1] ?? 'utf-8';
}

export function parseGmailMessage(raw: GmailRawMessage): MailMessage {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (part: GmailPart | undefined, depth: number) => {
    if (!part || depth > 10) return;
    const type = (part.mimeType ?? '').toLowerCase();
    if (part.body?.data && (type === 'text/plain' || type === 'text/html')) {
      try {
        const content = decodeBase64Url(part.body.data, charsetOf(part)).slice(0, MAX_BODY_CHARS);
        (type === 'text/html' ? html : plain).push(content);
      } catch {
        /* skip undecodable part */
      }
    }
    part.parts?.forEach((p) => walk(p, depth + 1));
  };
  walk(raw.payload, 0);

  const htmlJoined = html.join('\n');
  const text = [plain.join('\n'), htmlJoined ? htmlToText(htmlJoined) : ''].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
  const internal = Number(raw.internalDate);
  const dateHeader = Date.parse(header(raw.payload, 'Date'));
  const date = Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(dateHeader) ? dateHeader : Date.now();

  return {
    id: raw.id,
    from: header(raw.payload, 'From'),
    subject: header(raw.payload, 'Subject'),
    date: new Date(date).toISOString(),
    text,
    links: extractLinks(htmlJoined),
  };
}

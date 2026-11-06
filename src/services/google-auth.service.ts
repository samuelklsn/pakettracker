import { AppError } from '../core/errors';

/**
 * GoogleAuthService – one OAuth 2.0 access token shared by all Google features
 * (Gmail import, Drive sync).
 *
 *  - Token flow via Google Identity Services (GIS); the script is loaded lazily.
 *  - Incremental authorization: each feature asks for its own scope; already granted
 *    scopes are kept (`include_granted_scopes`), so the user sees as few popups as possible.
 *  - The access token lives in memory only (≈ 1 h) and is never persisted.
 */

export const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  drive: 'https://www.googleapis.com/auth/drive.appdata',
} as const;

const GIS_SRC = 'https://accounts.google.com/gsi/client';

export class GoogleAuthError extends AppError {}
export class GoogleApiError extends AppError {
  readonly status: number;
  constructor(message: string, status = 0, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}

/* ---------- Minimal typings for the parts of GIS we use ---------- */
interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}
interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes?: boolean;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type: string; message?: string }) => void;
    login_hint?: string;
  }): TokenClient;
  revoke(token: string, done?: () => void): void;
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
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
      else reject(new GoogleAuthError('Google-Anmeldung konnte nicht initialisiert werden.'));
    };
    script.onerror = () => {
      gisPromise = null;
      script.remove();
      reject(new GoogleAuthError('Google-Anmeldung konnte nicht geladen werden (Netzwerk oder Content-Blocker?).'));
    };
    document.head.append(script);
  });
  return gisPromise;
}

const SCOPE_LABEL: Record<string, string> = {
  [SCOPES.gmail]: 'Gmail (Lesezugriff)',
  [SCOPES.drive]: 'Google Drive (App-Ordner)',
};

export class GoogleAuthService {
  private readonly clientId: string | undefined;
  private token: { value: string; expiresAt: number; scopes: Set<string> } | null = null;
  private pending: Promise<void> | null = null;
  /** e-mail of the signed-in account (used as login hint) */
  account: string | undefined;

  constructor(clientId: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID) {
    this.clientId = clientId?.trim() || undefined;
  }

  get configured(): boolean {
    return !!this.clientId;
  }

  hasToken(...scopes: string[]): boolean {
    const t = this.token;
    return !!t && Date.now() < t.expiresAt - 60_000 && scopes.every((s) => t.scopes.has(s));
  }

  preload(): void {
    if (this.configured) void loadGis().catch(() => undefined);
  }

  /**
   * Makes sure a valid token with all given scopes exists. Opens the Google popup if needed,
   * so it must be triggered by a user gesture (click / submit).
   */
  async ensure(scopes: string[]): Promise<void> {
    if (this.hasToken(...scopes)) return;
    if (this.pending) {
      await this.pending.catch(() => undefined);
      if (this.hasToken(...scopes)) return;
    }
    this.pending = this.request(scopes);
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async request(scopes: string[]): Promise<void> {
    if (!this.clientId) throw new GoogleAuthError('Keine Google-Client-ID konfiguriert (VITE_GOOGLE_CLIENT_ID).');
    const oauth2 = await loadGis();
    const wanted = new Set([...(this.token?.scopes ?? []), ...scopes]);
    const clientId = this.clientId;

    const response = await new Promise<TokenResponse>((resolve, reject) => {
      oauth2
        .initTokenClient({
          client_id: clientId,
          scope: [...wanted].join(' '),
          include_granted_scopes: true,
          login_hint: this.account,
          callback: resolve,
          error_callback: (e) =>
            reject(
              new GoogleAuthError(
                e.type === 'popup_failed_to_open'
                  ? 'Das Google-Popup wurde blockiert. Bitte Popups für diese Seite erlauben und erneut klicken.'
                  : e.type === 'popup_closed'
                    ? 'Google-Anmeldung abgebrochen.'
                    : `Google-Anmeldung fehlgeschlagen (${e.type}).`,
              ),
            ),
        })
        .requestAccessToken({ prompt: '' });
    });

    if (response.error || !response.access_token) {
      throw new GoogleAuthError(
        response.error === 'access_denied'
          ? 'Zugriff verweigert. Ist dein Google-Konto als Testnutzer eingetragen?'
          : `Google-Anmeldung fehlgeschlagen: ${response.error_description ?? response.error ?? 'kein Token'}`,
      );
    }
    const granted = new Set((response.scope ?? '').split(/\s+/).filter(Boolean));
    const missing = scopes.filter((s) => !granted.has(s));
    if (missing.length) {
      throw new GoogleAuthError(
        `Fehlende Berechtigung: ${missing.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}. Bitte im Google-Dialog das Häkchen setzen.`,
      );
    }
    const ttl = Number(response.expires_in) || 3600;
    this.token = { value: response.access_token, expiresAt: Date.now() + ttl * 1000, scopes: granted };
  }

  /** Authorized fetch with consistent error mapping. */
  async fetch(url: string, init: RequestInit = {}, scope?: string): Promise<Response> {
    if (!this.token || !this.hasToken(...(scope ? [scope] : []))) {
      throw new GoogleAuthError('Die Google-Verbindung ist abgelaufen. Bitte erneut verbinden.');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token.value}`);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } catch (err) {
      throw new GoogleApiError('Google ist nicht erreichbar (Netzwerkfehler).', 0, { cause: err });
    }
    if (res.status === 401) {
      this.token = null;
      throw new GoogleAuthError('Die Google-Verbindung ist abgelaufen. Bitte erneut verbinden.');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
      const reason = body?.error?.errors?.[0]?.reason;
      const message = body?.error?.message ?? '';
      if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(message)) {
        const api = url.includes('gmail.googleapis.com') ? 'Gmail API' : 'Google Drive API';
        throw new GoogleApiError(`Die ${api} ist im Google-Cloud-Projekt dieser Client-ID nicht aktiviert.`, res.status);
      }
      if (res.status === 403) throw new GoogleApiError('Google verweigert den Zugriff (fehlende Berechtigung).', 403);
      if (res.status === 429) throw new GoogleApiError('Google-Limit erreicht. Bitte später erneut versuchen.', 429);
      throw new GoogleApiError(`Google-Fehler (HTTP ${res.status}).`, res.status);
    }
    return res;
  }

  async getJson<T>(url: string, scope?: string): Promise<T> {
    const res = await this.fetch(url, { headers: { Accept: 'application/json' } }, scope);
    return (await res.json()) as T;
  }

  /** Revokes all granted access at Google and forgets the token. */
  async revoke(): Promise<void> {
    const token = this.token?.value;
    this.token = null;
    if (!token || !window.google?.accounts?.oauth2) return;
    await new Promise<void>((resolve) => window.google!.accounts!.oauth2!.revoke(token, resolve));
  }

  forget(): void {
    this.token = null;
  }
}

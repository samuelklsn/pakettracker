import { type MailMessage, extractLinks, htmlToText } from './mail-extract.service';
import { type GoogleAuthService, SCOPES } from './google-auth.service';

/**
 * GmailService – read-only mailbox access directly from the browser.
 *
 *  - Uses the shared GoogleAuthService (scope `gmail.readonly` only).
 *  - Mails travel Google → this browser tab. No other server is involved.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 200_000;

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

export class GmailService {
  private readonly auth: GoogleAuthService;

  constructor(auth: GoogleAuthService) {
    this.auth = auth;
  }

  get configured(): boolean {
    return this.auth.configured;
  }

  get hasValidToken(): boolean {
    return this.auth.hasToken(SCOPES.gmail);
  }

  /** Opens the Google popup if needed – call from a user gesture. */
  connect(): Promise<void> {
    return this.auth.ensure([SCOPES.gmail]);
  }

  async profileEmail(): Promise<string> {
    const profile = await this.auth.getJson<{ emailAddress?: string }>(`${API}/profile`, SCOPES.gmail);
    return profile.emailAddress ?? '';
  }

  async listMessageIds(query: string, max = 50): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(max, 100)), includeSpamTrash: 'false' });
    const res = await this.auth.getJson<{ messages?: { id: string }[] }>(`${API}/messages?${params}`, SCOPES.gmail);
    return (res.messages ?? []).map((m) => m.id).filter((id) => /^[0-9a-zA-Z_-]{1,64}$/.test(id));
  }

  async getMessage(id: string): Promise<MailMessage> {
    const raw = await this.auth.getJson<GmailRawMessage>(`${API}/messages/${encodeURIComponent(id)}?format=full`, SCOPES.gmail);
    return parseGmailMessage(raw);
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

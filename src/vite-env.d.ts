/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional base URL of a self-hosted tracking proxy (see README). */
  readonly VITE_TRACKING_API_URL?: string;
  /** Optional Google OAuth client ID (web) for the Gmail integration. Public, not a secret. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

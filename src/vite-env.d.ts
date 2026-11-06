/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional base URL of a self-hosted tracking proxy (see README). */
  readonly VITE_TRACKING_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

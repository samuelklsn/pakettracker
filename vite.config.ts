/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * Injects a strict Content-Security-Policy into the production HTML.
 * Only applied on `vite build` – the dev server needs inline styles/HMR websockets.
 * If an optional tracking proxy is configured, only its exact origin is allowed for fetch().
 */
function contentSecurityPolicy(trackingApiUrl?: string, googleClientId?: string): Plugin {
  let connectSrc = "'self'";
  let scriptSrc = "'self'";
  let styleSrc = "'self'";
  let frameSrc = "'none'";
  if (googleClientId) {
    // Gmail integration: Google Identity Services (token popup) + Gmail REST API only
    scriptSrc += ' https://accounts.google.com/gsi/client';
    styleSrc += ' https://accounts.google.com/gsi/style';
    frameSrc = 'https://accounts.google.com/gsi/';
    connectSrc += ' https://accounts.google.com/gsi/ https://oauth2.googleapis.com/revoke https://gmail.googleapis.com';
  }
  if (trackingApiUrl) {
    try {
      connectSrc += ` ${new URL(trackingApiUrl).origin}`;
    } catch {
      throw new Error(`VITE_TRACKING_API_URL is not a valid URL: ${trackingApiUrl}`);
    }
  }
  const policy = [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `frame-src ${frameSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');

  return {
    name: 'pakettracker:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      // placed directly after <meta charset> so it precedes every script/style tag
      handler: (html) =>
        html.replace(
          /<meta charset="UTF-8" \/>/i,
          (m) => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        ),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    // Relative base → works on GitHub Pages project sites (/<repo>/) without extra config.
    base: './',
    plugins: [tailwindcss(), contentSecurityPolicy(env.VITE_TRACKING_API_URL, env.VITE_GOOGLE_CLIENT_ID)],
    build: {
      target: 'es2022',
      sourcemap: false,
      assetsInlineLimit: 0, // never inline assets as data: URIs into JS/CSS
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});

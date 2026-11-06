import './styles.css';
import { App } from './app';
import { applyTheme, getTheme } from './ui/theme';
import { notify } from './ui/toast';

applyTheme(getTheme());

const root = document.getElementById('app');
if (!root) throw new Error('#app root element missing');

if (!window.isSecureContext || !globalThis.crypto?.subtle) {
  root.textContent =
    'Pakettracker benötigt einen sicheren Kontext (HTTPS oder localhost), damit die Web Crypto API verfügbar ist.';
} else {
  new App(root).start();
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  notify.error('Unerwarteter Fehler', e.reason instanceof Error ? e.reason.message : undefined);
});

/**
 * Theme preference (dark default). This is a non-sensitive UI preference and is
 * therefore the ONLY value stored unencrypted besides the vault envelope.
 */
const KEY = 'pakettracker.theme';
export type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f4f5' : '#09090b');
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore – preference just won't persist */
  }
  applyTheme(next);
  return next;
}

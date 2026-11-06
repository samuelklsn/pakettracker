const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short' });
const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDay(iso: string): string {
  return dateOnly.format(new Date(iso));
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'gerade eben';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return dateTime.format(new Date(iso));
}

/** Groups long tracking numbers into blocks of 4 for readability. */
export function groupTrackingNumber(n: string): string {
  return n.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Converts an ISO string to the value format of <input type="datetime-local">. */
export function toLocalInputValue(date: Date): string {
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

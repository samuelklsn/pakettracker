/**
 * Minimal, XSS-safe DOM builder.
 *
 * SECURITY: user data is ONLY ever inserted via `textContent` / attributes.
 * `innerHTML` is never used anywhere in the app, so decrypted content can't inject markup.
 */

type Child = Node | string | number | false | null | undefined;
type Children = Child | Child[];

type EventMap = { [K in keyof HTMLElementEventMap as `on${Capitalize<K>}`]?: (ev: HTMLElementEventMap[K]) => void };

export type Props = EventMap & {
  class?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | undefined>;
  [key: string]: unknown;
};

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);

function safeUrl(value: string): string {
  try {
    const u = new URL(value, location.href);
    return ['https:', 'http:', 'mailto:', 'blob:'].includes(u.protocol) ? value : '#';
  } catch {
    return '#';
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Children[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'attrs') {
        for (const [a, v] of Object.entries(value as Record<string, unknown>)) {
          if (v === undefined || v === false) continue;
          const str = v === true ? '' : String(v);
          el.setAttribute(a, URL_ATTRS.has(a) ? safeUrl(str) : str);
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (URL_ATTRS.has(key)) {
        el.setAttribute(key, safeUrl(String(value)));
      } else if (key in el) {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Children | Children[]): void {
  const list = Array.isArray(children) ? children.flat(Infinity as 1) : [children];
  for (const c of list as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Element nicht gefunden: ${selector}`);
  return el;
}

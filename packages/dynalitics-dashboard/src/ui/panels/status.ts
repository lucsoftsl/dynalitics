import { append, el, visuallyHidden } from '../dom.js';

export type StatusClass = 'ok' | 'redirect' | 'client' | 'server';

/** 1xx/2xx ok, 3xx redirect, 4xx client error, 5xx server error (DESIGN 15.1). */
export function statusClass(status: number): StatusClass {
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  if (status >= 300) return 'redirect';
  return 'ok';
}

const SPOKEN: Readonly<Record<StatusClass, string>> = {
  ok: 'success',
  redirect: 'redirect',
  client: 'client error',
  server: 'server error',
};

/** The status as a badge. Colour is never the only signal: the code is printed and the class is spoken. */
export function statusBadge(status: number): HTMLElement {
  const cls = statusClass(status);
  const badge = el('span', `dy-status dy-status--${cls}`);
  append(badge, document.createTextNode(String(status)), visuallyHidden(` ${SPOKEN[cls]}`));
  return badge;
}

// 'dynalitics-consent': a consent banner in plain DOM (docs/SPEC.md section 19). Text only, no HTML parsing, no
// network requests; the only thing it stores is one first-party cookie holding the visitor's choice.
import {
  assertCookieName,
  assertMaxAgeDays,
  choiceFromCookieHeader,
  consentCookie,
  DEFAULT_COOKIE_NAME,
  DEFAULT_MAX_AGE_DAYS,
  safePolicyUrl,
  type ConsentChoice,
} from './shared.js';

export type { ConsentChoice } from './shared.js';

export interface ConsentBannerOptions {
  /** Default true. When false nothing is rendered and the cookie is neither read nor written. */
  readonly enabled?: boolean;
  /** Plain text shown to the visitor. Required. */
  readonly message: string;
  readonly title?: string;
  readonly acceptLabel?: string;
  readonly rejectLabel?: string;
  /** A same-site path (`/privacy`) or an http(s) URL; anything else is not rendered. */
  readonly policyUrl?: string;
  readonly policyLabel?: string;
  /** Must equal the server helper's. Default 'dynalitics_consent'. */
  readonly cookieName?: string | undefined;
  /** How long the choice is remembered, 1..395 days. Default 180. */
  readonly maxAgeDays?: number | undefined;
  readonly onChange?: (choice: ConsentChoice) => void;
}

export interface CookieOptions {
  readonly cookieName?: string | undefined;
  readonly maxAgeDays?: number | undefined;
}

export interface ConsentBannerHandle {
  /** The stored choice, or null when the visitor has not chosen (or the banner is disabled). */
  readonly choice: () => ConsentChoice | null;
  /** Shows the banner again whatever was stored: wire it to a "Cookie settings" link. */
  readonly open: () => void;
  /** Removes the banner from the page (the stored choice stays). */
  readonly destroy: () => void;
}

export const CONSENT_EVENT = 'dynalitics:consent';

const isSecurePage = (): boolean => globalThis.location?.protocol === 'https:';

/** The stored choice from `document.cookie`, or null. Safe to call during server rendering (returns null). */
export function readConsent(options: CookieOptions = {}): ConsentChoice | null {
  const name = assertCookieName(options.cookieName ?? DEFAULT_COOKIE_NAME);
  if (typeof document === 'undefined') return null;
  return choiceFromCookieHeader(document.cookie, name);
}

/** Stores a choice, tells listeners (`dynalitics:consent` on window). Use it for your own UI instead of the banner. */
export function writeConsent(choice: ConsentChoice, options: CookieOptions = {}): void {
  if (choice !== 'granted' && choice !== 'denied')
    throw new TypeError("dynalitics-consent: choice must be 'granted' or 'denied'");
  const name = assertCookieName(options.cookieName ?? DEFAULT_COOKIE_NAME);
  const days = assertMaxAgeDays(options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);
  if (typeof document === 'undefined') return;
  document.cookie = consentCookie(name, choice, days * 86_400, isSecurePage());
  globalThis.dispatchEvent?.(new CustomEvent(CONSENT_EVENT, { detail: { choice } }));
}

/** Deletes the stored choice: the visitor is asked again on the next page. */
export function clearConsent(options: CookieOptions = {}): void {
  const name = assertCookieName(options.cookieName ?? DEFAULT_COOKIE_NAME);
  if (typeof document === 'undefined') return;
  document.cookie = consentCookie(name, '', 0, isSecurePage());
}

let ids = 0;

/** Builds the banner element. Every visitor-facing string goes in as text. */
export function buildBanner(
  o: ConsentBannerOptions,
  choose: (c: ConsentChoice) => void,
): HTMLElement {
  const id = `dy-consent-${++ids}`;
  const root = document.createElement('div');
  root.className = 'dy-consent';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-labelledby', o.title ? `${id}-t` : `${id}-m`);
  if (o.title) {
    const h = document.createElement('p');
    h.className = 'dy-consent-title';
    h.id = `${id}-t`;
    h.textContent = o.title;
    root.appendChild(h);
  }
  const msg = document.createElement('p');
  msg.className = 'dy-consent-msg';
  msg.id = `${id}-m`;
  msg.textContent = o.message;
  root.appendChild(msg);
  const url = safePolicyUrl(o.policyUrl);
  if (url) {
    const a = document.createElement('a');
    a.className = 'dy-consent-link';
    a.href = url;
    a.textContent = o.policyLabel ?? 'Privacy policy';
    root.appendChild(a);
  }
  const actions = document.createElement('div');
  actions.className = 'dy-consent-actions';
  // Same element, same class, document order reject-then-accept: neither choice is visually favoured.
  for (const [choice, label] of [
    ['denied', o.rejectLabel ?? 'Reject'],
    ['granted', o.acceptLabel ?? 'Allow'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dy-consent-btn';
    b.dataset['choice'] = choice;
    b.textContent = label;
    b.addEventListener('click', () => choose(choice));
    actions.appendChild(b);
  }
  root.appendChild(actions);
  return root;
}

function validate(o: ConsentBannerOptions): void {
  if (typeof o.message !== 'string' || o.message.trim() === '')
    throw new TypeError('dynalitics-consent: message is required');
  assertCookieName(o.cookieName ?? DEFAULT_COOKIE_NAME);
  assertMaxAgeDays(o.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);
}

/**
 * Shows the banner when the visitor has not chosen yet. Returns a handle to reopen it (withdrawal) or remove it.
 * `container` defaults to `document.body`.
 */
export function mountConsentBanner(
  options: ConsentBannerOptions,
  container?: HTMLElement,
): ConsentBannerHandle {
  validate(options);
  const cookie = { cookieName: options.cookieName, maxAgeDays: options.maxAgeDays };
  const enabled = options.enabled !== false;
  let el: HTMLElement | null = null;

  const destroy = (): void => {
    el?.remove();
    el = null;
  };
  const open = (): void => {
    if (!enabled || el || typeof document === 'undefined') return;
    el = buildBanner(options, (c) => {
      writeConsent(c, cookie);
      destroy();
      options.onChange?.(c);
    });
    (container ?? document.body).appendChild(el);
  };

  if (enabled && readConsent(cookie) === null) open();
  return {
    choice: () => (enabled ? readConsent(cookie) : null),
    open,
    destroy,
  };
}

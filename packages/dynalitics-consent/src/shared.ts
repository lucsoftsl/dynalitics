// Pure helpers shared by the banner and the server helper (docs/SPEC.md section 19). No DOM, no Node APIs.

export type ConsentChoice = 'granted' | 'denied';

export const DEFAULT_COOKIE_NAME = 'dynalitics_consent';
export const DEFAULT_MAX_AGE_DAYS = 180;
export const MAX_AGE_DAYS_LIMIT = 395;

const COOKIE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws on a cookie name that could break the `Cookie` header (it comes from host config, never from a visitor). */
export function assertCookieName(name: string): string {
  if (!COOKIE_NAME.test(name))
    throw new TypeError('dynalitics-consent: cookieName must match ^[A-Za-z0-9_-]{1,64}$');
  return name;
}

export function assertMaxAgeDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > MAX_AGE_DAYS_LIMIT)
    throw new TypeError(
      `dynalitics-consent: maxAgeDays must be an integer 1..${MAX_AGE_DAYS_LIMIT}`,
    );
  return days;
}

/**
 * The stored choice in a `Cookie` header. Fails closed: a missing cookie, an unknown value, or the same cookie twice
 * with different values (e.g. one set on a parent domain) is "no choice" (null).
 */
export function choiceFromCookieHeader(
  header: string | null | undefined,
  name: string = DEFAULT_COOKIE_NAME,
): ConsentChoice | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  const values = new Set<string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) values.add(part.slice(eq + 1).trim());
  }
  if (values.size !== 1) return null;
  const [value] = values;
  return value === 'granted' || value === 'denied' ? value : null;
}

/** The `Set-Cookie`/`document.cookie` string that stores a choice (or deletes it with `maxAgeSeconds = 0`). */
export function consentCookie(
  name: string,
  value: ConsentChoice | '',
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** A link target the banner may render: a same-site path or an http(s) URL. Anything else (javascript:, data:) is null. */
export function safePolicyUrl(url: string | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
  if (/^\/(?!\/)/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

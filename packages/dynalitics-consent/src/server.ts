// 'dynalitics-consent/server': turns the banner's cookie into the boolean `track()` takes (docs/SPEC.md 19.4).
// No DOM and no Node imports, so it runs in Node, edge runtimes, Bun and Deno alike.
import { assertCookieName, choiceFromCookieHeader, DEFAULT_COOKIE_NAME } from './shared.js';

export { choiceFromCookieHeader as parseConsentCookie } from './shared.js';
export type { ConsentChoice } from './shared.js';

/** Anything that carries a Cookie header: a Node IncomingMessage, a Fetch Request, or a plain headers object. */
export type RequestLike =
  | string
  | { readonly headers: { readonly get: (name: string) => string | null } }
  | { readonly headers: Readonly<Record<string, string | readonly string[] | undefined>> };

export interface ConsentFromRequestOptions {
  /** Must equal the banner's `cookieName`. Default 'dynalitics_consent'. */
  readonly cookieName?: string;
}

function cookieHeader(req: RequestLike): string | null {
  if (typeof req === 'string') return req;
  const headers: unknown = (req as { headers?: unknown } | null)?.headers;
  if (typeof headers !== 'object' || headers === null) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value: unknown = (headers as { get: (n: string) => unknown }).get('cookie');
    return typeof value === 'string' ? value : null;
  }
  const raw = (headers as Record<string, unknown>)['cookie'];
  if (typeof raw === 'string') return raw;
  return Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? raw.join('; ') : null;
}

/**
 * `true` only when the visitor chose "allow". No choice, "reject", a malformed header or conflicting cookies are all
 * `false`, which dynalitics stores as "no consent" (page and time only). Never throws for a request.
 */
export function consentFromRequest(
  req: RequestLike,
  options: ConsentFromRequestOptions = {},
): boolean {
  const name = assertCookieName(options.cookieName ?? DEFAULT_COOKIE_NAME);
  try {
    return choiceFromCookieHeader(cookieHeader(req), name) === 'granted';
  } catch {
    return false;
  }
}

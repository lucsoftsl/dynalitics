import type { FetchFn } from '../ui/api.js';
import type { GetRequestInit } from './types.js';

/**
 * Wraps `fetch` so the host can add headers/credentials (docs/DESIGN.md 12.2 `getRequestInit`).
 * Security rules: the method stays GET, a body is never sent, `redirect` stays 'manual' (a redirect
 * means a login page, never data), our abort signal wins, and our `accept` header wins. If the host
 * callback throws or rejects we answer 401 without exposing its error, so the UI says "not authorised".
 */
export function withRequestInit(base: FetchFn, getInit: () => GetRequestInit | undefined): FetchFn {
  return async (input, init) => {
    const provider = getInit();
    let extra: RequestInit = {};
    if (provider) {
      try {
        extra = (await provider()) ?? {};
      } catch {
        return new Response(null, { status: 401 });
      }
    }
    const headers = new Headers(extra.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    const merged: RequestInit = {
      method: 'GET',
      redirect: 'manual',
      headers,
      credentials: extra.credentials ?? init?.credentials ?? 'same-origin',
    };
    if (extra.mode) merged.mode = extra.mode;
    if (extra.cache) merged.cache = extra.cache;
    if (extra.referrerPolicy) merged.referrerPolicy = extra.referrerPolicy;
    if (init?.signal) merged.signal = init.signal;
    return base(input, merged);
  };
}

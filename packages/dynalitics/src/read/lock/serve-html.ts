import { randomBytes } from 'node:crypto';
import { SECURITY_HEADERS } from '../http.js';
import type { DynaliticsResponse } from '../types.js';

// Serving the dashboard page: per-request nonce, strict CSP, the two placeholders (docs/SPEC.md 10.8).
// CORS and CSRF posture, stated here because this layer owns it: the handler emits NO CORS headers, sets NO cookies,
// accepts only GET and never changes state, so there is nothing for a cross-site request to forge. A cross-origin
// deployment needs the host's own CORS layer in front. There is no CSRF code on purpose (SECURITY.md non-guarantee).

export const newNonce = (): string => randomBytes(16).toString('base64url');

export function csp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Fills the two placeholders of the dashboard page. Nonce is base64url; the base path is pre-validated and normalised. */
export function htmlResponse(
  html: string,
  basePath: string,
  nonce = newNonce(),
): DynaliticsResponse {
  const body = html
    .split('%%DYNALITICS_NONCE%%')
    .join(nonce)
    .split('%%DYNALITICS_BASE%%')
    .join(basePath);
  return {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp(nonce),
      'X-Frame-Options': 'DENY',
    },
    body,
  };
}

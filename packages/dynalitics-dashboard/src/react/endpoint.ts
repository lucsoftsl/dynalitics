import { normalizeBase } from '../ui/api.js';

/**
 * The endpoint as a same-origin path prefix, or '' for the site root. Builds on the HTML dashboard's
 * normalizeBase and also refuses anything with an empty path segment: `//host` is a protocol-relative URL
 * (another origin), and a request there would carry the host's `getRequestInit` headers with it.
 */
export function safeEndpoint(raw: string | null | undefined): string {
  const base = normalizeBase(raw);
  return base.includes('//') ? '' : base;
}

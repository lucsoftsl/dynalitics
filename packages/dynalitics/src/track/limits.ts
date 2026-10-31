// Removed from every stored string: C0/DEL and C1 controls (NUL breaks PostgreSQL text, controls enable log
// injection), U+2028/2029 (break JSON-lines pipelines) and bidi controls/marks (spoof how a path reads).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export type Oversize = 'truncate' | 'reject';

export function cleanString(s: string): string {
  return s.replace(CONTROL, '').replace(LONE_SURROGATE, '�');
}

/** Fits `s` into `max` UTF-16 units. Returns null when the policy is "reject" and it does not fit. */
export function fitString(s: string, max: number, oversize: Oversize): string | null {
  if (s.length <= max) return s;
  if (oversize === 'reject') return null;
  let cut = max;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // never leave half of a surrogate pair
  return s.slice(0, cut);
}

export function stripQuery(page: string): string {
  const end = page.search(/[?#]/);
  return end === -1 ? page : page.slice(0, end);
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

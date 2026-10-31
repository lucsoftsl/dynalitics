/**
 * PII masking (spec 10.6). Every function is TOTAL and FAILS CLOSED: a value that does not match the expected shape
 * exactly comes out as a fixed "***", never as a partial copy of unparseable input.
 */
const first = (s: string): string => [...s][0] ?? '';
const FIXED = '***';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HASH = /^[0-9a-f]{64}$/i;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+$/u;
const MIN_USER_ID_LENGTH = 6;

/** IPv4 keeps two octets, IPv6 two groups, hashed values 8 hex characters. */
export function maskIp(ip: string | null): string | null {
  if (ip === null || ip === '') return null;
  if (IPV4.test(ip)) return `${ip.split('.').slice(0, 2).join('.')}.x.x`;
  if (HASH.test(ip)) return `${ip.slice(0, 8)}…`;
  if (IPV6.test(ip)) {
    if (ip.startsWith('::')) return '::x';
    const [a = '', b = ''] = ip.split(':');
    return b === '' ? `${a}::x` : `${a}:${b}::x`;
  }
  return FIXED; // ports, lists ("1.2.3.4, 5.6.7.8"), zone ids, words: never partially echoed
}

/** First character of the local part and the domain: `j***@example.com`. Anything that is not exactly one address: `***`. */
export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  if (!EMAIL.test(email)) return FIXED;
  const at = email.indexOf('@');
  return `${first(email.slice(0, at))}***${email.slice(at)}`;
}

export function maskUsername(name: string | null): string | null {
  return name === null ? null : `${first(name)}***`;
}

/**
 * `u_90042` -> `u_***42`: the first two and last two characters of ids of at least 6 characters, `***` for shorter ones
 * (so at most 4 characters are ever shown). An id that looks like an email address is masked as an email.
 */
export function maskUserId(id: string | null): string | null {
  if (id === null) return null;
  if (id.includes('@')) return maskEmail(id);
  const chars = [...id];
  if (chars.length < MIN_USER_ID_LENGTH) return FIXED;
  return `${chars.slice(0, 2).join('')}${FIXED}${chars.slice(-2).join('')}`;
}

export const MASKED_CUSTOM = FIXED;

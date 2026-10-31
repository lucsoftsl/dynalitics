import type { SafeCause } from './errors.js';

export type Redactor = (text: string) => string;

const REDACTED = '[redacted]';
const MIN_STANDALONE_SECRET = 4;

// ://user:password@host  -> ://user:[redacted]@host
const URL_USERINFO = /(:\/\/[^\s:/@]*:)([^\s@/]+)(@)/g;
// Password=...; pwd="..." (ADO / ODBC style), also password=... in query strings
const KEY_VALUE = /((?:password|pwd)\s*=\s*)("[^"]*"|'[^']*'|[^;&\s]+)/gi;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every string that must never appear in output because it came from a connection string. */
export function secretsFromConnectionString(connectionString: string): string[] {
  const secrets = new Set<string>([connectionString]);
  const add = (s: string): void => {
    if (s.length >= MIN_STANDALONE_SECRET) secrets.add(s);
  };
  const userinfo = /:\/\/[^\s:/@]*:([^\s@/]+)@/.exec(connectionString);
  if (userinfo?.[1] !== undefined) {
    add(userinfo[1]);
    add(safeDecode(userinfo[1]));
  }
  for (const m of connectionString.matchAll(
    /(?:password|pwd)\s*=\s*("[^"]*"|'[^']*'|[^;&\s]+)/gi,
  )) {
    const raw = (m[1] ?? '').replace(/^["']|["']$/g, '');
    add(raw);
    add(safeDecode(raw));
  }
  return [...secrets];
}

export function createRedactor(secrets: readonly string[]): Redactor {
  // Longest first so a full connection string is replaced before the password inside it.
  const ordered = [...new Set(secrets)]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const secret of ordered) out = out.split(secret).join(REDACTED);
    return out.replace(URL_USERINFO, `$1${REDACTED}$3`).replace(KEY_VALUE, `$1${REDACTED}`);
  };
}

/** Copy only name, code and a redacted message. Nothing else of the original error survives. */
export function sanitizeError(err: unknown, redact: Redactor): SafeCause {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
      message: redact(err.message),
    };
  }
  if (typeof err === 'string') return { name: 'Error', message: redact(err) };
  return { name: 'Error', message: 'Unknown error' };
}

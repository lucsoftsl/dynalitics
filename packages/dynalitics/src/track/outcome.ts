// The request outcome of a visit (docs/SPEC.md 20): HTTP status and an error code. Neither is personal data, so both are
// stored whatever the consent. The reason is a CODE on purpose: error messages routinely carry emails, ids, SQL or
// file paths, and the charset below cannot hold an email address, a URL or a sentence.
import type { Note } from './build-row.js';

export const MIN_STATUS = 100;
export const MAX_STATUS = 599;
export const ERROR_REASON = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

type Field<T> = { readonly value: T | null; readonly note?: Note };

/** Integer 100..599, else NULL (the visit is kept and the problem reported). */
export function statusField(raw: unknown): Field<number> {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_STATUS && raw <= MAX_STATUS)
    return { value: raw };
  return {
    value: null,
    note: {
      code: 'invalid_visit',
      message: `status must be an integer ${MIN_STATUS}..${MAX_STATUS} and was not stored`,
    },
  };
}

/** A code matching ERROR_REASON, else NULL (reported, with no echo of the value: it may be a message with data in it). */
export function errorReasonField(raw: unknown): Field<string> {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw === 'string' && ERROR_REASON.test(raw)) return { value: raw };
  return {
    value: null,
    note: {
      code: 'invalid_visit',
      message:
        'errorReason must be a short code (^[A-Za-z][A-Za-z0-9_.:-]{0,63}$), not a message, and was not stored',
    },
  };
}

/**
 * A storable reason for a thrown value: its `code` (e.g. `ECONNREFUSED`, `P2002`) when that is code-shaped, else its
 * `name` (`TypeError`, `ValidationError`). Never the message. Null when neither fits.
 */
export function errorReasonOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: unknown; name?: unknown };
  for (const candidate of [e.code, e.name])
    if (typeof candidate === 'string' && ERROR_REASON.test(candidate)) return candidate;
  return null;
}

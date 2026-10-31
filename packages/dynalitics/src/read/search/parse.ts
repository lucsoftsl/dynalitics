import type { QueryErrorReason } from '../../protocol.js';
import type { SearchField } from './fields.js';

// The explorer query language (docs/SPEC.md 18.2). Pure: string in, typed clauses out. Nothing here produces SQL;
// field names are resolved against the allow-list and every value stays data (bound later as a parameter).

export const QUERY_LIMITS = { maxQueryChars: 512, maxClauses: 12, maxValueChars: 128 } as const;

export type TextMatch =
  | { readonly kind: 'exact' | 'prefix' | 'suffix' | 'contains'; readonly value: string }
  | { readonly kind: 'exists' };
export type NumberOp = '=' | '>' | '>=' | '<' | '<=';

export type Clause =
  /** Case-insensitive "contains" over every field with `search: true`. `value` is lower-cased. */
  | { readonly type: 'term'; readonly negate: boolean; readonly value: string }
  | {
      readonly type: 'text';
      readonly negate: boolean;
      readonly field: SearchField;
      readonly match: TextMatch;
    }
  | {
      readonly type: 'boolean';
      readonly negate: boolean;
      readonly field: SearchField;
      readonly value: boolean;
    }
  | {
      readonly type: 'number';
      readonly negate: boolean;
      readonly field: SearchField;
      readonly op: NumberOp;
      readonly value: number;
    };

export type ParsedQuery =
  | { readonly ok: true; readonly clauses: readonly Clause[] }
  | { readonly ok: false; readonly reason: QueryErrorReason; readonly position: number };

const KEY_PREFIX = /^[A-Za-z_][A-Za-z0-9_]{0,63}:/;
const NUMBER = /^(>=|<=|>|<)?(-?[0-9]{1,15}(?:\.[0-9]{1,6})?)$/;
const BOOLEAN = /^(true|false)$/i;
const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

class QueryError extends Error {
  constructor(
    readonly reason: QueryErrorReason,
    readonly position: number,
  ) {
    super(reason);
  }
}

interface Raw {
  readonly text: string;
  readonly quoted: boolean;
  readonly start: number;
}

/** Reads one value (quoted or bare word) starting at `i`. */
function readValue(q: string, i: number): { raw: Raw; next: number } {
  if (q[i] === '"') {
    const close = q.indexOf('"', i + 1);
    if (close === -1) throw new QueryError('unbalanced_quote', i);
    return { raw: { text: q.slice(i + 1, close), quoted: true, start: i + 1 }, next: close + 1 };
  }
  let j = i;
  while (j < q.length && !isSpace(q[j])) {
    if (q[j] === '"') throw new QueryError('unbalanced_quote', j);
    j++;
  }
  return { raw: { text: q.slice(i, j), quoted: false, start: i }, next: j };
}

function checkLength(raw: Raw): void {
  if (raw.text.length === 0) throw new QueryError('empty_value', raw.start);
  if (raw.text.length > QUERY_LIMITS.maxValueChars)
    throw new QueryError('value_too_long', raw.start);
}

/** Quoted text is literal; bare text may carry `*` at either end only. */
function textMatch(raw: Raw): TextMatch {
  const lower = raw.text.toLowerCase();
  if (raw.quoted) return { kind: 'exact', value: lower };
  const lead = lower.startsWith('*');
  const trail = lower.endsWith('*') && lower.length > 1;
  const core = lower.slice(lead ? 1 : 0, trail ? -1 : undefined);
  if (core.length === 0) return { kind: 'exists' };
  if (core.includes('*')) throw new QueryError('bad_value', raw.start + (lead ? 1 : 0));
  const kind = lead && trail ? 'contains' : lead ? 'suffix' : trail ? 'prefix' : 'exact';
  return { kind, value: core };
}

function fieldClause(field: SearchField, raw: Raw, negate: boolean): Clause {
  switch (field.type) {
    case 'text':
      return { type: 'text', negate, field, match: textMatch(raw) };
    case 'boolean': {
      if (!BOOLEAN.test(raw.text)) throw new QueryError('bad_value', raw.start);
      return { type: 'boolean', negate, field, value: raw.text.toLowerCase() === 'true' };
    }
    case 'number': {
      const m = NUMBER.exec(raw.text);
      if (m?.[2] === undefined) throw new QueryError('bad_value', raw.start);
      return { type: 'number', negate, field, op: (m[1] ?? '=') as NumberOp, value: Number(m[2]) };
    }
  }
}

/** Parses `q` against the allow-list. Never throws; the first problem found is reported with its position. */
export function parseQuery(q: string, fields: ReadonlyMap<string, SearchField>): ParsedQuery {
  if (q.length > QUERY_LIMITS.maxQueryChars)
    return { ok: false, reason: 'too_long', position: QUERY_LIMITS.maxQueryChars };
  const clauses: Clause[] = [];
  try {
    let i = 0;
    while (i < q.length) {
      if (isSpace(q[i])) {
        i++;
        continue;
      }
      const start = i;
      if (clauses.length === QUERY_LIMITS.maxClauses)
        throw new QueryError('too_many_clauses', start);
      let negate = false;
      if (q[i] === '-') {
        negate = true;
        i++;
        if (i >= q.length || isSpace(q[i])) throw new QueryError('empty_value', start);
      }
      const prefix = q[i] === '"' ? null : KEY_PREFIX.exec(q.slice(i));
      if (prefix !== null) {
        const key = prefix[0].slice(0, -1);
        const field = fields.get(key);
        if (field === undefined) throw new QueryError('unknown_field', i);
        const valueAt = i + prefix[0].length;
        if (valueAt >= q.length || isSpace(q[valueAt]))
          throw new QueryError('empty_value', valueAt);
        const { raw, next } = readValue(q, valueAt);
        checkLength(raw);
        clauses.push(fieldClause(field, raw, negate));
        i = next;
      } else {
        const { raw, next } = readValue(q, i);
        checkLength(raw);
        clauses.push({ type: 'term', negate, value: raw.text.toLowerCase() });
        i = next;
      }
      if (i < q.length && !isSpace(q[i])) throw new QueryError('unbalanced_quote', i);
    }
  } catch (err) {
    if (err instanceof QueryError) return { ok: false, reason: err.reason, position: err.position };
    throw err;
  }
  return { ok: true, clauses };
}

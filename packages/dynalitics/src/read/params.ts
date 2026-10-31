import type { Interval } from '../protocol.js';
import { bucketStarts } from './buckets.js';

export type RouteName =
  | 'meta'
  | 'visits-over-time'
  | 'top-pages'
  | 'new-vs-returning'
  | 'consent-rate'
  | 'recent-visits'
  | 'search'
  | 'search-histogram'
  | 'search-fields';

const SEARCH_ROUTES: ReadonlySet<RouteName> = new Set([
  'search',
  'search-histogram',
  'search-fields',
]);

export interface ReadLimits {
  readonly maxRangeDays: number;
  readonly maxBuckets: number;
  readonly topPagesMax: number;
  readonly recentMax: number;
  readonly newVsReturningMaxRangeDays: number;
  /** Explorer routes (spec 18.3): contains-searches only use the timestamp index, so the range is capped lower. */
  readonly explorerMaxRangeDays: number;
}
export interface ParamContext {
  readonly now: Date;
  readonly limits: ReadLimits;
  readonly defaults: {
    readonly rangeDays: number;
    readonly interval: Interval;
    readonly topPagesLimit: number;
    readonly recentLimit: number;
  };
  /** Dimension names offered for `breakdown`. The request can only pick one of these names. */
  readonly breakdowns: ReadonlySet<string>;
  /** Explorer facet field names offered for `split`. */
  readonly splits: ReadonlySet<string>;
  readonly hasCursor: boolean;
}
export interface Cursor {
  readonly ts: Date;
  readonly id: string;
}
export interface ParsedParams {
  readonly from: Date;
  readonly to: Date;
  readonly interval: Interval;
  readonly limit: number;
  readonly breakdown: string | undefined;
  readonly cursor: Cursor | undefined;
  readonly pii: boolean;
  /** Explorer query text, unparsed (the search parser validates it against the allow-list). '' when absent. */
  readonly q: string;
  readonly split: string | undefined;
}
export type ParseResult =
  | { readonly ok: true; readonly params: ParsedParams }
  | {
      readonly ok: false;
      readonly code: 'invalid_parameter' | 'range_too_large';
      readonly param?: string;
    };

const DAY_MS = 86_400_000;
const MAX_QUERY_CHARS = 2048;
const INTERVALS: ReadonlySet<string> = new Set(['hour', 'day', 'week', 'month']);
const ALLOWED: Readonly<Record<RouteName, ReadonlySet<string>>> = {
  meta: new Set(),
  'visits-over-time': new Set(['from', 'to', 'interval', 'breakdown']),
  'top-pages': new Set(['from', 'to', 'limit']),
  'new-vs-returning': new Set(['from', 'to', 'interval']),
  'consent-rate': new Set(['from', 'to', 'interval']),
  'recent-visits': new Set(['from', 'to', 'limit', 'cursor', 'pii']),
  search: new Set(['from', 'to', 'limit', 'cursor', 'pii', 'q']),
  'search-histogram': new Set(['from', 'to', 'interval', 'q', 'split']),
  'search-fields': new Set(['from', 'to', 'q']),
};
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CURSOR_TOKEN = /^[A-Za-z0-9_-]{1,200}$/;
const CURSOR_BODY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{1,19})$/;

function parseInstant(v: string): Date | null {
  let iso: string;
  if (DATE_ONLY.test(v)) iso = `${v}T00:00:00.000Z`;
  else if (INSTANT.test(v)) {
    // pad a short fraction to milliseconds: ".5Z" -> ".500Z"; no fraction -> ".000Z"
    iso = v.includes('.')
      ? v.replace(/\.(\d{1,3})Z$/, (_m, f: string) => `.${f.padEnd(3, '0')}Z`)
      : v.replace('Z', '.000Z');
  } else return null;
  const d = new Date(iso);
  // Reject roll-overs such as 2026-02-30: the round trip must reproduce the input.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 19) !== iso.slice(0, 19) ? null : d;
}

export function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Strict: anchored patterns only; the result is typed and later bound as parameters. */
export function decodeCursor(token: string): Cursor | null {
  if (!CURSOR_TOKEN.test(token)) return null;
  const m = CURSOR_BODY.exec(Buffer.from(token, 'base64url').toString('utf8'));
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const ts = parseInstant(m[1]);
  return ts === null ? null : { ts, id: m[2] };
}

const invalid = (param?: string): ParseResult =>
  param === undefined
    ? { ok: false, code: 'invalid_parameter' }
    : { ok: false, code: 'invalid_parameter', param };

/** Parses and validates every query parameter of a route. Anything not on the route's allow-list is an error. */
export function parseParams(
  route: RouteName,
  query: Readonly<Record<string, string | readonly string[]>>,
  ctx: ParamContext,
): ParseResult {
  const allowed = ALLOWED[route];
  let size = 0;
  const single: Record<string, string> = {};
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) return invalid(key);
    const value = query[key];
    if (typeof value !== 'string') return invalid(key);
    size += key.length + value.length;
    single[key] = value;
  }
  if (size > MAX_QUERY_CHARS) return invalid();
  const has = (k: string): boolean => Object.hasOwn(single, k);

  let to = ctx.now;
  if (has('to')) {
    const t = parseInstant(single['to'] ?? '');
    if (t === null) return invalid('to');
    to = t;
  }
  let from = new Date(to.getTime() - ctx.defaults.rangeDays * DAY_MS);
  if (has('from')) {
    const f = parseInstant(single['from'] ?? '');
    if (f === null) return invalid('from');
    from = f;
  }
  if (route !== 'meta' && to.getTime() <= from.getTime()) return invalid('to');

  let interval = ctx.defaults.interval;
  if (has('interval')) {
    const i = single['interval'] ?? '';
    if (!INTERVALS.has(i)) return invalid('interval');
    interval = i as Interval;
  }

  let limit = route === 'top-pages' ? ctx.defaults.topPagesLimit : ctx.defaults.recentLimit;
  if (has('limit')) {
    const raw = single['limit'] ?? '';
    const max = route === 'top-pages' ? ctx.limits.topPagesMax : ctx.limits.recentMax;
    if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) return invalid('limit');
    limit = Number(raw);
  }

  let breakdown: string | undefined;
  if (has('breakdown')) {
    const b = single['breakdown'] ?? '';
    if (!ctx.breakdowns.has(b)) return invalid('breakdown');
    breakdown = b;
  }

  let cursor: Cursor | undefined;
  if (has('cursor')) {
    const c = decodeCursor(single['cursor'] ?? '');
    if (c === null || !ctx.hasCursor) return invalid('cursor');
    cursor = c;
  }

  let split: string | undefined;
  if (has('split')) {
    const s = single['split'] ?? '';
    if (!ctx.splits.has(s)) return invalid('split');
    split = s;
  }
  const q = single['q'] ?? '';

  let pii = false;
  if (has('pii')) {
    if (single['pii'] !== 'reveal') return invalid('pii');
    pii = true;
  }

  const rangeDays = (to.getTime() - from.getTime()) / DAY_MS;
  const cap =
    route === 'new-vs-returning'
      ? ctx.limits.newVsReturningMaxRangeDays
      : SEARCH_ROUTES.has(route)
        ? Math.min(ctx.limits.explorerMaxRangeDays, ctx.limits.maxRangeDays)
        : ctx.limits.maxRangeDays;
  if (route !== 'meta' && rangeDays > cap) return { ok: false, code: 'range_too_large' };
  const bucketed =
    route === 'visits-over-time' ||
    route === 'new-vs-returning' ||
    route === 'consent-rate' ||
    route === 'search-histogram';
  if (bucketed && bucketStarts(from, to, interval).length > ctx.limits.maxBuckets) {
    return { ok: false, code: 'range_too_large' };
  }
  return { ok: true, params: { from, to, interval, limit, breakdown, cursor, pii, q, split } };
}

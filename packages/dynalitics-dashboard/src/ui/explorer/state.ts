import type { Interval, MetaData } from '../../protocol.js';
import { bucketEnd } from '../format.js';
import { windowFor, type RangeDef, type Window } from '../ranges.js';

// Pure explorer state (docs/DESIGN.md 14.1): what is searched, how it is split, the zoom and the live tail.
// Everything here is serialisable into the URL hash so a view can be shared.

export const TAIL_CHOICES = [5, 15, 30] as const;
export type TailSeconds = 0 | (typeof TAIL_CHOICES)[number];

export interface Zoom {
  readonly fromMs: number;
  readonly toMs: number;
  readonly interval: Interval;
}

export interface ExplorerState {
  readonly q: string;
  readonly split: string | null;
  readonly tail: TailSeconds;
  readonly zoom: Zoom | null;
}

export const EMPTY_EXPLORER: ExplorerState = { q: '', split: null, tail: 0, zoom: null };

const param = (hash: string, key: string): string | null => {
  const m = new RegExp(`(?:^|[#&])${key}=([^&]*)`).exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
};

export function isExplorerHash(hash: string): boolean {
  return param(hash, 'view') === 'explorer';
}

/** Reads the explorer part of the hash. Unknown splits and tails are dropped, never trusted. */
export function explorerFromHash(hash: string, meta: MetaData): ExplorerState {
  const facets = new Set(meta.explorer?.fields.filter((f) => f.facet).map((f) => f.key) ?? []);
  const split = param(hash, 'split');
  const tail = Number(param(hash, 'tail'));
  const max = meta.explorer?.limits.maxQueryChars ?? 512;
  return {
    q: (param(hash, 'q') ?? '').slice(0, max),
    split: split !== null && facets.has(split) ? split : null,
    tail: tailOf(tail, meta),
    zoom: null,
  };
}

export function tailOf(seconds: number, meta: MetaData): TailSeconds {
  const min = (meta.explorer?.limits.tailMinIntervalMs ?? 5000) / 1000;
  return (TAIL_CHOICES as readonly number[]).includes(seconds) && seconds >= min
    ? (seconds as TailSeconds)
    : 0;
}

export function tailChoices(meta: MetaData): readonly TailSeconds[] {
  return TAIL_CHOICES.filter((s) => tailOf(s, meta) === s);
}

export function explorerHash(rangeKey: string, s: ExplorerState): string {
  const parts = [`view=explorer`, `range=${rangeKey}`];
  if (s.q) parts.push(`q=${encodeURIComponent(s.q)}`);
  if (s.split) parts.push(`split=${encodeURIComponent(s.split)}`);
  if (s.tail) parts.push(`tail=${s.tail}`);
  return `#${parts.join('&')}`;
}

/** Ranges the explorer routes accept (SPEC 18.3). */
export function explorerRanges(meta: MetaData, offered: readonly RangeDef[]): readonly RangeDef[] {
  const cap = meta.explorer?.limits.maxRangeDays ?? 31;
  return offered.filter((r) => r.days <= cap);
}

/** The window of the explorer: the zoom if set, else the range on the server's clock. */
export function explorerWindow(range: RangeDef, metaNow: string, zoom: Zoom | null): Window | null {
  if (!zoom) return windowFor(range, metaNow);
  return {
    from: new Date(zoom.fromMs).toISOString(),
    to: new Date(zoom.toMs).toISOString(),
    fromMs: zoom.fromMs,
    toMs: zoom.toMs,
    interval: zoom.interval,
  };
}

/** A day (or week) column zooms to itself one interval finer; an hour column does not zoom. */
export function zoomInto(bucketStart: number, interval: Interval, win: Window): Zoom | null {
  const finer: Partial<Record<Interval, Interval>> = { day: 'hour', week: 'day', month: 'day' };
  const next = finer[interval];
  if (!next) return null;
  const fromMs = Math.max(bucketStart, win.fromMs);
  const toMs = Math.min(bucketEnd(bucketStart, interval), win.toMs);
  return toMs > fromMs ? { fromMs, toMs, interval: next } : null;
}

const NEEDS_QUOTES = /[\s:*"-]/;

/** `key:*` ("has a value"); a facet VALUE of `*` goes through addClause and is quoted, so it stays literal. */
export const ANY_VALUE = Symbol('any value');

/**
 * Appends `key:value` (or `-key:value`) to the query. Returns null when the value cannot be written in the query
 * language: it contains `"` and SPEC 18.2 has no escapes. A clause already present is not added twice.
 */
export function addClause(
  q: string,
  key: string,
  value: string | typeof ANY_VALUE,
  negate: boolean,
): string | null {
  if (value !== ANY_VALUE && value.includes('"')) return null;
  const v =
    value === ANY_VALUE ? '*' : value === '' || NEEDS_QUOTES.test(value) ? `"${value}"` : value;
  const clause = `${negate ? '-' : ''}${key}:${v}`;
  const trimmed = q.trim();
  if (trimmed.split(/\s+/).includes(clause)) return trimmed;
  return trimmed ? `${trimmed} ${clause}` : clause;
}

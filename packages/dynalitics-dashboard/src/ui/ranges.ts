import type { Interval, MetaData } from '../protocol.js';
import { parseInstant } from './format.js';

export type RangeKey = '24h' | '7d' | '30d' | '90d';

export interface RangeDef {
  readonly key: RangeKey;
  readonly ms: number;
  readonly days: number;
  readonly interval: Interval;
  readonly label: string;
  readonly short: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGES: readonly RangeDef[] = [
  { key: '24h', ms: DAY, days: 1, interval: 'hour', label: 'LAST 24 HOURS', short: '24 hours' },
  { key: '7d', ms: 7 * DAY, days: 7, interval: 'day', label: 'LAST 7 DAYS', short: '7 days' },
  { key: '30d', ms: 30 * DAY, days: 30, interval: 'day', label: 'LAST 30 DAYS', short: '30 days' },
  { key: '90d', ms: 90 * DAY, days: 90, interval: 'week', label: 'LAST 90 DAYS', short: '90 days' },
];

export const DEFAULT_RANGE: RangeKey = '7d';

export function rangeByKey(key: string): RangeDef | undefined {
  return RANGES.find((r) => r.key === key);
}

/** Only ranges the server will accept (SPEC 10.9 rule 9). */
export function offeredRanges(meta: MetaData): readonly RangeDef[] {
  return RANGES.filter((r) => r.days <= meta.limits.maxRangeDays);
}

export function initialRange(meta: MetaData, hash: string): RangeKey {
  const offered = offeredRanges(meta);
  const fromHash = /(?:^|[#&])range=(24h|7d|30d|90d)(?:&|$)/.exec(hash)?.[1];
  const wanted =
    offered.find((r) => r.key === fromHash) ??
    offered.find((r) => r.days === meta.defaults.rangeDays);
  return (wanted ?? offered[0])?.key ?? DEFAULT_RANGE;
}

export interface Window {
  readonly from: string;
  readonly to: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly interval: Interval;
}

/** `to` is the server's clock (meta.now), never the browser's. Returns null when meta.now is unusable. */
export function windowFor(range: RangeDef, metaNow: string, capDays?: number): Window | null {
  const toMs = parseInstant(metaNow);
  if (Number.isNaN(toMs)) return null;
  const capped = capDays !== undefined && range.days > capDays;
  const ms = capped ? capDays * DAY : range.ms;
  const interval: Interval = capped ? (capDays <= 1 ? 'hour' : 'day') : range.interval;
  const fromMs = toMs - ms;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    interval,
  };
}

export function isCapped(range: RangeDef, capDays: number): boolean {
  return range.days > capDays;
}

export interface WindowLabel {
  readonly capped: boolean;
  /** Eyebrow form, e.g. `LAST 31 DAYS`. */
  readonly upper: string;
  /** Sentence form, e.g. `last 31 days`. */
  readonly lower: string;
}

/** Names the window a capped panel really shows (docs/DESIGN.md 6.4.1). */
export function windowLabel(range: RangeDef, capDays: number): WindowLabel {
  if (!isCapped(range, capDays))
    return { capped: false, upper: range.label, lower: range.label.toLowerCase() };
  const lower = capDays === 1 ? 'last day' : `last ${capDays} days`;
  return { capped: true, upper: lower.toUpperCase(), lower };
}

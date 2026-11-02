import type { Interval } from '../protocol.js';

// Every instant is shown in UTC (docs/DESIGN.md section 0, decision 2).

export interface Formatters {
  readonly num: (n: number) => string;
  readonly compact: (n: number) => string;
  readonly day: (t: number) => string;
  readonly weekday: (t: number) => string;
  readonly hour: (t: number) => string;
  readonly time: (t: number) => string;
  readonly month: (t: number) => string;
  /** Country name for an ISO alpha-2 code, in the formatters' locale (DESIGN 16). */
  readonly country: (code: string) => string;
}

function utc(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
}

/** Country names in the reader's language from the browser; the code when the browser has none. */
export function countryNamer(locale: string | undefined): (code: string) => string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(locale ? [locale] : undefined, {
      type: 'region',
      fallback: 'code',
    });
  } catch {
    names = null;
  }
  return (code) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
}

export function createFormatters(locale?: string): Formatters {
  const nf = new Intl.NumberFormat(locale);
  const cf = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const day = utc(locale, { day: 'numeric', month: 'short' });
  const weekday = utc(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const hour = utc(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const time = utc(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const month = utc(locale, { month: 'short' });
  const country = countryNamer(locale);
  return {
    country,
    num: (n) => nf.format(n),
    compact: (n) => cf.format(n),
    day: (t) => day.format(t),
    weekday: (t) => weekday.format(t),
    hour: (t) => hour.format(t),
    time: (t) => time.format(t),
    month: (t) => month.format(t),
  };
}

/** 0.825 -> "82.5%", 1 -> "100%", 0 -> "0%". */
export function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

/** Whole-number share for list rows; "<1%" when it rounds to zero but visits exist. */
export function sharePct(share: number, visits: number): string {
  if (visits > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)?$/;

/** Strict UTC ISO-8601 only: V8's Date.parse also accepts arbitrary text such as "<b>1". NaN if invalid. */
export function parseInstant(iso: string): number {
  return ISO_INSTANT.test(iso) ? Date.parse(iso) : Number.NaN;
}

const HOUR = 3_600_000;

export function axisLabel(f: Formatters, t: number, interval: Interval, isFirst: boolean): string {
  if (interval === 'hour') {
    return isFirst || new Date(t).getUTCHours() === 0 ? f.day(t) : f.hour(t);
  }
  if (interval === 'month') return f.month(t);
  return f.day(t);
}

export function tooltipTitle(
  f: Formatters,
  t: number,
  interval: Interval,
  flags: { readonly last: boolean; readonly first: boolean; readonly fromMs: number },
): string {
  let out: string;
  if (interval === 'hour') out = `${f.day(t)}, ${f.hour(t)}-${f.hour(t + HOUR)} UTC`;
  else if (interval === 'week') out = `Week of ${f.day(t)}`;
  else if (interval === 'month') out = `${f.month(t)} ${new Date(t).getUTCFullYear()}`;
  else out = f.weekday(t);
  if (flags.last) out += ' (so far)';
  else if (flags.first && flags.fromMs > t) out += ' (partial period)';
  return out;
}

/** "HH:MM:SS" and "30 Oct" for the table's time cell. */
export function splitTimestamp(f: Formatters, iso: string): { time: string; date: string } | null {
  const t = parseInstant(iso);
  if (Number.isNaN(t)) return null;
  return { time: f.time(t), date: f.day(t) };
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** First instant after the bucket that starts at `t` (month buckets are calendar months). */
export function bucketEnd(t: number, interval: Interval): number {
  if (interval === 'hour') return t + HOUR;
  if (interval === 'day') return t + 24 * HOUR;
  if (interval === 'week') return t + 7 * 24 * HOUR;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

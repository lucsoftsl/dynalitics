// Independent oracle for the e2e run: recomputes what the read API should answer straight from the raw table
// rows, following docs/SPEC.md 10.3 (zero-filled UTC buckets), 10.5 and 10.11 (read-time new vs returning).
// Deliberately written from the spec, not copied from the handler, so a disagreement points at one of the two.

export type Interval = 'hour' | 'day' | 'week';

export interface DbRow {
  readonly id: string;
  readonly ts: number;
  readonly consent: boolean;
  readonly page: string;
  readonly userId: string | null;
  readonly ip: string | null;
  readonly email: string | null;
  readonly username: string | null;
  readonly plan: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function bucketStart(ts: number, interval: Interval): number {
  if (interval === 'hour') return Math.floor(ts / HOUR) * HOUR;
  const day = Math.floor(ts / DAY) * DAY;
  if (interval === 'day') return day;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY; // weeks start on Monday
}

/** Every bucket start of [from, to), including the partial first and last ones. */
export function bucketStarts(from: number, to: number, interval: Interval): number[] {
  const step = interval === 'hour' ? HOUR : interval === 'day' ? DAY : 7 * DAY;
  const out: number[] = [];
  for (let t = bucketStart(from, interval); t < to; t += step) out.push(t);
  return out;
}

const inWindow = (rows: readonly DbRow[], from: number, to: number): DbRow[] =>
  rows.filter((r) => r.ts >= from && r.ts < to);

export interface SeriesPoint {
  readonly bucket: string;
  readonly visits: number;
}

export function visitsOverTime(
  rows: readonly DbRow[],
  from: number,
  to: number,
  interval: Interval,
) {
  const win = inWindow(rows, from, to);
  const points: SeriesPoint[] = bucketStarts(from, to, interval).map((t) => ({
    bucket: new Date(t).toISOString(),
    visits: win.filter((r) => bucketStart(r.ts, interval) === t).length,
  }));
  return { points, total: win.length };
}

export function topPages(rows: readonly DbRow[], from: number, to: number) {
  const counts = new Map<string, number>();
  for (const r of inWindow(rows, from, to)) counts.set(r.page, (counts.get(r.page) ?? 0) + 1);
  return { counts, total: inWindow(rows, from, to).length };
}

export function consentRate(rows: readonly DbRow[], from: number, to: number, interval: Interval) {
  const win = inWindow(rows, from, to);
  const points = bucketStarts(from, to, interval).map((t) => {
    const b = win.filter((r) => bucketStart(r.ts, interval) === t);
    const granted = b.filter((r) => r.consent).length;
    return { bucket: new Date(t).toISOString(), granted, denied: b.length - granted };
  });
  const granted = win.filter((r) => r.consent).length;
  return { points, totals: { granted, denied: win.length - granted } };
}

export interface NvrCounts {
  readonly new: number;
  readonly returning: number;
  readonly unknown: number;
}

/** SPEC 10.11: identities first seen in the bucket are new; other identified visits are returning; the rest unknown. */
export function newVsReturning(
  rows: readonly DbRow[],
  from: number,
  to: number,
  interval: Interval,
  ipAllowed = true,
) {
  const win = inWindow(rows, from, to);
  const identified = (r: DbRow): boolean =>
    r.consent && (r.userId !== null || (ipAllowed && r.ip !== null));
  const firstSeen = (keyOf: (r: DbRow) => string | null, pick: (r: DbRow) => boolean): number[] => {
    const firsts = new Map<string, number>();
    for (const r of win.filter(pick)) {
      const k = keyOf(r) as string;
      firsts.set(k, Math.min(firsts.get(k) ?? Number.POSITIVE_INFINITY, r.ts));
    }
    return [...firsts]
      .filter(([k]) => !rows.some((p) => keyOf(p) === k && p.ts < from))
      .map(([, ts]) => ts);
  };
  const newTimes = [
    ...firstSeen(
      (r) => r.userId,
      (r) => r.consent && r.userId !== null,
    ),
    ...(ipAllowed
      ? firstSeen(
          (r) => r.ip,
          (r) => r.consent && r.userId === null && r.ip !== null,
        )
      : []),
  ];
  const points = bucketStarts(from, to, interval).map((t) => {
    const b = win.filter((r) => bucketStart(r.ts, interval) === t);
    const ident = b.filter(identified).length;
    const nw = newTimes.filter((ts) => bucketStart(ts, interval) === t).length;
    return {
      bucket: new Date(t).toISOString(),
      new: nw,
      returning: Math.max(0, ident - nw),
      unknown: b.length - ident,
    };
  });
  const totals: NvrCounts = {
    new: points.reduce((a, p) => a + p.new, 0),
    returning: points.reduce((a, p) => a + p.returning, 0),
    unknown: points.reduce((a, p) => a + p.unknown, 0),
  };
  return { points, totals };
}

/** Newest first, ties by id descending (SPEC 10.5). */
export function recentVisits(
  rows: readonly DbRow[],
  from: number,
  to: number,
  limit: number,
): DbRow[] {
  return inWindow(rows, from, to)
    .sort((a, b) => b.ts - a.ts || Number(BigInt(b.id) - BigInt(a.id)))
    .slice(0, limit);
}

export function planCounts(
  rows: readonly DbRow[],
  from: number,
  to: number,
): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const r of inWindow(rows, from, to)) out.set(r.plan, (out.get(r.plan) ?? 0) + 1);
  return out;
}

import type { Interval } from '../protocol.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Start of the UTC bucket containing `d`. Weeks start on Monday. */
export function floorBucket(d: Date, interval: Interval): Date {
  const t = d.getTime();
  switch (interval) {
    case 'hour':
      return new Date(Math.floor(t / HOUR_MS) * HOUR_MS);
    case 'day':
      return new Date(Math.floor(t / DAY_MS) * DAY_MS);
    case 'week': {
      const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
      const sinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
      return new Date(dayStart - sinceMonday * DAY_MS);
    }
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
}

export function nextBucket(bucket: Date, interval: Interval): Date {
  switch (interval) {
    case 'hour':
      return new Date(bucket.getTime() + HOUR_MS);
    case 'day':
      return new Date(bucket.getTime() + DAY_MS);
    case 'week':
      return new Date(bucket.getTime() + 7 * DAY_MS);
    case 'month':
      return new Date(Date.UTC(bucket.getUTCFullYear(), bucket.getUTCMonth() + 1, 1));
  }
}

/** Every bucket start intersecting [from, to): the server zero-fills with these (spec 10.3). */
export function bucketStarts(from: Date, to: Date, interval: Interval): Date[] {
  const out: Date[] = [];
  for (let b = floorBucket(from, interval); b < to; b = nextBucket(b, interval)) out.push(b);
  return out;
}

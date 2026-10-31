import { describe, expect, test } from 'vitest';
import {
  bucketStart,
  bucketStarts,
  consentRate,
  newVsReturning,
  planCounts,
  recentVisits,
  topPages,
  visitsOverTime,
  type DbRow,
} from './oracle.js';

const day = (n: number, h = 12) => Date.UTC(2026, 9, n, h);
let seq = 0;
const row = (ts: number, extra: Partial<DbRow> = {}): DbRow => ({
  id: String(++seq),
  ts,
  consent: true,
  page: '/',
  userId: null,
  ip: null,
  email: null,
  username: null,
  plan: null,
  ...extra,
});

describe('e2e oracle (SPEC 10.3 / 10.11)', () => {
  test('buckets are UTC, half-open and zero-filled; weeks start on Monday', () => {
    expect(bucketStart(Date.UTC(2026, 9, 30, 23, 59), 'day')).toBe(Date.UTC(2026, 9, 30));
    expect(new Date(bucketStart(Date.UTC(2026, 9, 30), 'week')).getUTCDay()).toBe(1);
    expect(bucketStarts(day(1, 6), day(4, 6), 'day')).toHaveLength(4);
    const v = visitsOverTime([row(day(2)), row(day(2, 13))], day(1, 0), day(4, 0), 'day');
    expect(v.points.map((p) => p.visits)).toEqual([0, 2, 0]);
    expect(v.total).toBe(2);
    expect(visitsOverTime([row(day(4, 0))], day(1, 0), day(4, 0), 'day').total).toBe(0); // `to` is exclusive
  });
  test('top pages and consent totals count only rows in the window', () => {
    const rows = [
      row(day(2), { page: '/a' }),
      row(day(2), { page: '/a' }),
      row(day(2), { page: '/b', consent: false }),
      row(day(20), { page: '/a' }),
    ];
    expect([...topPages(rows, day(1, 0), day(5, 0)).counts]).toEqual([
      ['/a', 2],
      ['/b', 1],
    ]);
    expect(consentRate(rows, day(1, 0), day(5, 0), 'day').totals).toEqual({
      granted: 2,
      denied: 1,
    });
  });
  test('new vs returning: first-ever row in the bucket is new, earlier history makes returning, declined is unknown', () => {
    const rows = [
      row(day(1), { userId: 'a' }), // before the window
      row(day(10), { userId: 'a' }), // returning
      row(day(10, 13), { userId: 'b' }), // new
      row(day(11), { userId: 'b' }), // returning (same bucket logic: not first-ever)
      row(day(11, 13), { ip: '1.2.3.4' }), // new ip identity
      row(day(12), { ip: '1.2.3.4' }), // returning ip
      row(day(12, 13), { consent: false }), // unknown
      row(day(12, 14), { userId: 'a', ip: '1.2.3.4' }), // user identity wins, returning
    ];
    const r = newVsReturning(rows, day(9, 0), day(13, 0), 'day');
    expect(r.totals).toEqual({ new: 2, returning: 4, unknown: 1 });
    expect(r.points.reduce((a, p) => a + p.new + p.returning + p.unknown, 0)).toBe(7); // equals visits-over-time
    expect(newVsReturning(rows, day(9, 0), day(13, 0), 'day', false).totals.unknown).toBe(3); // ip identity off
  });
  test('an ip first seen on a row WITH a user id earlier is not new later (SPEC 10.11 Q3 comment)', () => {
    const rows = [row(day(1), { userId: 'u', ip: '9.9.9.9' }), row(day(10), { ip: '9.9.9.9' })];
    expect(newVsReturning(rows, day(9, 0), day(13, 0), 'day').totals).toEqual({
      new: 0,
      returning: 1,
      unknown: 0,
    });
  });
  test('recent visits are newest first with id descending on ties; plan counts keep null', () => {
    const rows = [row(day(2), { plan: 'pro' }), row(day(2)), row(day(3), { plan: 'pro' })];
    expect(recentVisits(rows, day(1, 0), day(5, 0), 2).map((r) => r.ts)).toEqual([day(3), day(2)]);
    const [a, b] = recentVisits(rows, day(2, 0), day(2, 23), 5);
    expect(Number(a!.id)).toBeGreaterThan(Number(b!.id));
    expect(planCounts(rows, day(1, 0), day(5, 0)).get(null)).toBe(1);
  });
});

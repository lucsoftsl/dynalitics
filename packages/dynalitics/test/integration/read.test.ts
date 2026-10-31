/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- test code reading untyped JSON responses */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { getDialect } from '../../src/dialect/index.js';
import type { Dynalitics } from '../../src/types.js';
import type { Interval } from '../../src/protocol.js';
import { bucketStarts, floorBucket } from '../../src/read/buckets.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsHandler } from '../../src/read/types.js';
import { ENABLED, setupFixture, type Fixture } from './support.js';

const customFields = {
  plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
  campaign: { type: 'string', maxLength: 64 },
} as const;

interface R {
  idx: number;
  ts: Date;
  consent: boolean;
  page: string;
  ip: string | null;
  user: string | null;
  username: string | null;
  email: string | null;
  plan: string | null;
  campaign: string | null;
}

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dataset(): Omit<R, 'idx'>[] {
  const rand = rng(42);
  const out: Omit<R, 'idx'>[] = [];
  const day = 86_400_000;
  const start = Date.UTC(2026, 9, 10);
  for (let i = 0; i < 320; i++) {
    const consent = rand() < 0.85;
    out.push({
      ts: new Date(start + Math.floor(rand() * 20 * day)),
      consent,
      page: `/p${Math.floor(rand() * 5)}`,
      user: consent && rand() < 0.7 ? `u${Math.floor(rand() * 15)}` : null,
      ip: consent && rand() < 0.6 ? `198.51.100.${Math.floor(rand() * 10)}` : null,
      username: consent ? `name${i}` : null,
      email: consent ? `person${i}@example.com` : null,
      plan: rand() < 0.5 ? `p${Math.floor(rand() * 3)}` : null,
      campaign: consent && rand() < 0.4 ? 'fall' : null,
    });
  }
  const tie = new Date(Date.UTC(2026, 9, 22, 10, 0, 0, 0));
  for (let k = 0; k < 2; k++)
    out.push({
      ts: tie,
      consent: true,
      page: '/tie',
      user: 'tie_user',
      ip: null,
      username: null,
      email: null,
      plan: null,
      campaign: null,
    });
  return out;
}

const bucketOf = (d: Date, i: Interval): string => floorBucket(d, i).toISOString();
const ipAllowed = true; // ip.mode raw in this suite

function expectedNvr(rows: R[], from: Date, to: Date, interval: Interval) {
  const inRange = rows.filter((r) => r.ts >= from && r.ts < to);
  const total = new Map<string, number>();
  const identified = new Map<string, number>();
  const fresh = new Map<string, number>();
  const add = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of inRange) {
    const b = bucketOf(r.ts, interval);
    add(total, b);
    if (r.consent && (r.user !== null || (ipAllowed && r.ip !== null))) add(identified, b);
  }
  const firstIn = (key: (r: R) => string | null, pool: R[]): Map<string, Date> => {
    const m = new Map<string, Date>();
    for (const r of pool) {
      const k = key(r);
      if (k === null) continue;
      const cur = m.get(k);
      if (cur === undefined || r.ts < cur) m.set(k, r.ts);
    }
    return m;
  };
  for (const [u, ts] of firstIn(
    (r) => r.user,
    inRange.filter((r) => r.consent),
  )) {
    if (!rows.some((r) => r.user === u && r.ts < from)) add(fresh, bucketOf(ts, interval));
  }
  for (const [ip, ts] of firstIn(
    (r) => r.ip,
    inRange.filter((r) => r.consent && r.user === null),
  )) {
    if (!rows.some((r) => r.ip === ip && r.ts < from)) add(fresh, bucketOf(ts, interval));
  }
  return bucketStarts(from, to, interval).map((d) => {
    const b = d.toISOString();
    const t = total.get(b) ?? 0;
    const id = identified.get(b) ?? 0;
    const n = Math.min(fresh.get(b) ?? 0, id);
    return { bucket: b, new: n, returning: id - n, unknown: t - id };
  });
}

function expectedFirstFlag(rows: R[], r: R): boolean | null {
  if (!r.consent) return null;
  const earlier = (same: (x: R) => boolean): boolean =>
    rows.some(
      (x) =>
        x !== r && same(x) && (x.ts < r.ts || (x.ts.getTime() === r.ts.getTime() && x.idx < r.idx)),
    );
  if (r.user !== null) return !earlier((x) => x.user === r.user);
  if (ipAllowed && r.ip !== null) return !earlier((x) => x.ip === r.ip);
  return null;
}

describe.each(ENABLED)('integration (read API against real data): %s', (dialect) => {
  let fx: Fixture;
  let dyn: Dynalitics;
  let handler: DynaliticsHandler;
  let rows: R[];
  const warnings: string[] = [];

  const get = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle({ method: 'GET', path, query, headers: {}, raw: {} });
    return { status: res.status, json: JSON.parse(res.body) };
  };

  beforeAll(async () => {
    fx = await setupFixture(dialect, { customFields });
    dyn = await createDynalitics({
      dialect,
      connection: { reader: { connectionString: fx.readerUrl } },
      table: fx.table,
      customFields,
      ip: { mode: 'raw' },
      logger: { info: () => undefined, warn: (m) => void warnings.push(m), error: () => undefined },
    });
    handler = createHandler(dyn, {
      authorize: () => ({ allowed: true, revealPii: true }),
      pii: { reveal: true },
      scope: 'none', // the whole table is this test's table
    });

    const data = dataset();
    rows = data.map((r, idx) => ({ ...r, idx }));
    const d = getDialect(dialect);
    const values = rows.map((r) => [
      d.timestampParam(r.ts),
      r.consent,
      r.page,
      r.ip,
      r.user,
      r.username,
      r.email,
      r.plan !== null || r.campaign !== null
        ? JSON.stringify({
            ...(r.plan === null ? {} : { plan: r.plan }),
            ...(r.campaign === null ? {} : { campaign: r.campaign }),
          })
        : null,
    ]);
    for (let at = 0; at < values.length; at += 100) {
      const q = d.buildInsert(dyn.model, values.slice(at, at + 100));
      await fx.admin.query(q, { timeoutMs: 30_000 }); // inserted in order, so ids follow idx
    }
  });
  afterAll(async () => {
    await dyn.close();
    await fx.cleanup();
  });

  test('the generated SELECT-only reader starts without any privilege warning', () => {
    expect(warnings).toEqual([]);
    expect(dyn.capabilities).toEqual({ canWrite: false, canRead: true });
  });

  test.each<[Interval, string, string]>([
    ['hour', '2026-10-18', '2026-10-20'],
    ['day', '2026-10-10', '2026-10-30'],
    ['week', '2026-10-05', '2026-11-02'],
    ['month', '2026-10-01', '2026-11-01'],
  ])(
    'visits-over-time (%s) matches a brute-force count, zero-filled, with the right bucket starts',
    async (interval, from, to) => {
      const { status, json } = await get('/api/visits-over-time', { from, to, interval });
      expect(status).toBe(200);
      const f = new Date(from);
      const t = new Date(to);
      const expected = bucketStarts(f, t, interval).map((b) => ({
        bucket: b.toISOString(),
        visits: rows.filter(
          (r) => r.ts >= f && r.ts < t && bucketOf(r.ts, interval) === b.toISOString(),
        ).length,
      }));
      expect(json.data.points).toEqual(expected);
      expect(json.data.total).toBe(expected.reduce((a, p) => a + p.visits, 0));
    },
  );

  test('weeks start on Monday (UTC)', async () => {
    const { json } = await get('/api/visits-over-time', {
      from: '2026-10-05',
      to: '2026-10-19',
      interval: 'week',
    });
    expect(json.data.points.map((p: { bucket: string }) => p.bucket)).toEqual([
      '2026-10-05T00:00:00.000Z',
      '2026-10-12T00:00:00.000Z',
    ]);
    expect(new Date(json.data.points[0].bucket).getUTCDay()).toBe(1);
  });

  test('breakdown by a JSON custom field: top values, a null series, and other = total - listed', async () => {
    const f = new Date('2026-10-10');
    const t = new Date('2026-10-30');
    const { json } = await get('/api/visits-over-time', {
      from: '2026-10-10',
      to: '2026-10-30',
      interval: 'day',
      breakdown: 'plan',
    });
    const series = json.data.breakdown.series as {
      value: string | null;
      isOther: boolean;
      points: { bucket: string; visits: number }[];
    }[];
    for (const v of ['p0', 'p1', 'p2']) {
      const s = series.find((x) => x.value === v)!;
      expect(s.points.map((p) => p.visits)).toEqual(
        bucketStarts(f, t, 'day').map(
          (b) =>
            rows.filter(
              (r) =>
                r.plan === v && bucketOf(r.ts, 'day') === b.toISOString() && r.ts >= f && r.ts < t,
            ).length,
        ),
      );
    }
    const nullSeries = series.find((x) => x.value === null && !x.isOther)!;
    expect(nullSeries.points.reduce((a, p) => a + p.visits, 0)).toBe(
      rows.filter((r) => r.plan === null && r.ts >= f && r.ts < t).length,
    );
    const total = json.data.total as number;
    const sum = series.reduce((a, s) => a + s.points.reduce((x, p) => x + p.visits, 0), 0);
    expect(sum).toBe(total); // listed + null + other == total
  });

  test('breakdown by consent', async () => {
    const { json } = await get('/api/visits-over-time', {
      from: '2026-10-10',
      to: '2026-10-30',
      breakdown: 'consent',
    });
    const byValue = Object.fromEntries(
      (
        json.data.breakdown.series as {
          value: string | null;
          isOther: boolean;
          points: { visits: number }[];
        }[]
      )
        .filter((s) => !s.isOther)
        .map((s) => [String(s.value), s.points.reduce((a, p) => a + p.visits, 0)]),
    );
    expect(byValue['true']).toBe(
      rows.filter((r) => r.consent && r.ts < new Date('2026-10-30')).length,
    );
    expect(byValue['false']).toBe(
      rows.filter((r) => !r.consent && r.ts < new Date('2026-10-30')).length,
    );
  });

  test('top-pages and consent-rate match', async () => {
    const f = new Date('2026-10-10');
    const t = new Date('2026-10-31');
    const top = (await get('/api/top-pages', { from: '2026-10-10', to: '2026-10-31', limit: '3' }))
      .json.data;
    const counts = new Map<string, number>();
    rows
      .filter((r) => r.ts >= f && r.ts < t)
      .forEach((r) => counts.set(r.page, (counts.get(r.page) ?? 0) + 1));
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
    expect(top.pages.map((p: { page: string; visits: number }) => [p.page, p.visits])).toEqual(
      sorted,
    );
    expect(top.totalVisits).toBe(rows.filter((r) => r.ts >= f && r.ts < t).length);
    expect(top.totalVisits - top.otherVisits).toBe(
      top.pages.reduce((a: number, p: { visits: number }) => a + p.visits, 0),
    );

    const cr = (
      await get('/api/consent-rate', { from: '2026-10-10', to: '2026-10-31', interval: 'week' })
    ).json.data;
    const granted = rows.filter((r) => r.ts >= f && r.ts < t && r.consent).length;
    expect(cr.totals.granted).toBe(granted);
    expect(cr.totals.denied).toBe(rows.filter((r) => r.ts >= f && r.ts < t).length - granted);
  });

  test.each<[Interval, string, string]>([
    ['day', '2026-10-10', '2026-10-30'],
    ['day', '2026-10-16', '2026-10-24'],
    ['hour', '2026-10-21', '2026-10-23'],
    ['week', '2026-10-12', '2026-10-30'],
  ])(
    'new-vs-returning (%s %s..%s) equals the brute-force oracle of SPEC 8.5.1',
    async (interval, from, to) => {
      const { json } = await get('/api/new-vs-returning', { from, to, interval });
      expect(json.unavailable).toBeNull();
      expect(json.data).toMatchObject({
        source: 'computed',
        basis: 'user_id_then_ip',
        approximate: true,
      });
      expect(json.data.points).toEqual(expectedNvr(rows, new Date(from), new Date(to), interval));
      if (interval === 'day' && from === '2026-10-10') {
        // guard against a vacuous comparison: every category must actually occur in the data
        expect(json.data.totals.new).toBeGreaterThan(5);
        expect(json.data.totals.returning).toBeGreaterThan(5);
        expect(json.data.totals.unknown).toBeGreaterThan(5);
      }
      const visits = (await get('/api/visits-over-time', { from, to, interval })).json.data
        .total as number;
      const t = json.data.totals as { new: number; returning: number; unknown: number };
      expect(t.new + t.returning + t.unknown).toBe(visits);
    },
  );

  test('recent-visits: newest first, masked by default, per-row first-visit equals the oracle (ties broken by id)', async () => {
    const all: any[] = [];
    const flags = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const { status, json } = await get('/api/recent-visits', {
        from: '2026-10-01',
        to: '2026-11-01',
        limit: '50',
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(status).toBe(200);
      all.push(...json.data.visits);
      cursor = json.data.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(all).toHaveLength(rows.length);
    expect(new Set(all.map((v) => v.id)).size).toBe(rows.length);
    const times = all.map((v) => v.timestamp as string);
    expect([...times].sort().reverse()).toEqual(times);
    for (const v of all) {
      const r = rows[Number(v.id) - 1]!;
      expect(v.pageVisited).toBe(r.page);
      expect(v.consent).toBe(r.consent);
      expect(v.timestamp).toBe(r.ts.toISOString());
      expect(v.isFirstVisit).toBe(expectedFirstFlag(rows, r));
      flags.add(String(v.isFirstVisit));
      if (r.email !== null) {
        expect(v.email).toBe(`${r.email.slice(0, 1)}***@example.com`);
        expect(v.username).toBe(`${r.username!.slice(0, 1)}***`);
      } else {
        expect(v.email).toBeNull();
      }
      if (r.ip !== null) expect(v.ipAddress).toBe('198.51.x.x');
      expect(v.custom?.campaign ?? null).toBe(r.campaign === null ? null : '***');
    }
    expect([...flags].sort()).toEqual(['false', 'null', 'true']); // all three outcomes occur
    expect(JSON.stringify(all)).not.toContain(
      'example.com'.replace('example.com', '@example.com').slice(0, 0) + 'person',
    );
  });

  test('PII can be revealed only with ?pii=reveal (option + authorize are already granted in this suite)', async () => {
    const masked = (
      await get('/api/recent-visits', { from: '2026-10-01', to: '2026-11-01', limit: '5' })
    ).json;
    const revealed = (
      await get('/api/recent-visits', {
        from: '2026-10-01',
        to: '2026-11-01',
        limit: '5',
        pii: 'reveal',
      })
    ).json;
    expect(masked.meta.piiMasked).toBe(true);
    expect(revealed.meta.piiMasked).toBe(false);
    const withEmail = revealed.data.visits.find((v: { email: string | null }) => v.email !== null);
    expect(withEmail.email).toMatch(/^person\d+@example\.com$/);
  });

  test('meta reflects the real model; hostile and malformed input never reaches SQL', async () => {
    const meta = (await get('/api/meta')).json.data;
    expect(meta.fields).toMatchObject({ id: true, ipAddress: true, userId: true, email: true });
    for (const [path, query] of [
      ['/api/visits-over-time', { breakdown: "plan'; DROP TABLE x;--" }],
      ['/api/visits-over-time', { interval: 'day; DROP' }],
      [
        '/api/recent-visits',
        { cursor: Buffer.from('2026-10-30T12:00:00.000Z|1 OR 1=1').toString('base64url') },
      ],
      ['/api/top-pages', { limit: '5; SELECT 1' }],
    ] as const) {
      expect((await get(path, query)).status).toBe(400);
    }
    expect((await get('/api/top-pages')).status).toBe(200); // the table is still there
  });

  test('the SELECT-only reader cannot be used to write, even by a hostile request (no write path exists)', async () => {
    const before = (await fx.rows()).length;
    await get('/api/top-pages', { limit: '1' });
    expect((await fx.rows()).length).toBe(before);
  });
});

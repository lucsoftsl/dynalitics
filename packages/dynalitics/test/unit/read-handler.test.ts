/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- test code reading untyped JSON responses */
import { describe, expect, test, vi } from 'vitest';
import { createHandler } from '../../src/read/handler.js';
import { DynaliticsConfigError } from '../../src/errors.js';
import { DriverError } from '../../src/driver/types.js';
import type { ApiResponse } from '../../src/protocol.js';
import type { DynaliticsRequest } from '../../src/read/types.js';
import { readFixture, type Answers } from '../helpers/read-fixture.js';

const req = (
  path: string,
  query: Record<string, string | string[]> = {},
  over: Partial<DynaliticsRequest> = {},
): DynaliticsRequest => ({
  method: 'GET',
  path,
  query,
  headers: {},
  raw: { marker: 'raw-request' },
  ...over,
});
const allow = () => true;
function setup(
  answers: Answers = {},
  options: Record<string, unknown> = {},
  schema = {},
  fx: Parameters<typeof readFixture>[2] = {},
) {
  const f = readFixture(answers, schema, fx);
  const handler = createHandler(f.dyn, { authorize: allow, ...options });
  return { ...f, handler };
}
const body = async (h: ReturnType<typeof createHandler>, r: DynaliticsRequest) => {
  const res = await h.handle(r);
  return { res, json: JSON.parse(res.body) as ApiResponse<any> };
};
const ok = async (h: ReturnType<typeof createHandler>, r: DynaliticsRequest) => {
  const { res, json } = await body(h, r);
  expect(res.status).toBe(200);
  if (!json.success) throw new Error('expected success');
  return json;
};

describe('createHandler: locked by default', () => {
  test('refuses to be created without an authorize function', () => {
    const f = readFixture();
    for (const bad of [undefined, null, 'yes', true, {}]) {
      expect(() => createHandler(f.dyn, { authorize: bad } as never)).toThrow(
        DynaliticsConfigError,
      );
    }
    expect(() => createHandler(f.dyn, {} as never)).toThrow(/authorize/);
  });

  test('needs a reader credential', () => {
    const f = readFixture({}, {}, { noReader: true });
    expect(() => createHandler(f.dyn, { authorize: allow })).toThrow(/reader/);
  });

  test('validates its options (all issues, unknown keys, base path)', () => {
    const f = readFixture();
    expect(() =>
      createHandler(f.dyn, {
        authorize: allow,
        basePath: '/a b',
        cacheTtlMs: -1,
        nope: 1,
      } as never),
    ).toThrow(DynaliticsConfigError);
    expect(() =>
      createHandler(f.dyn, { authorize: allow, basePath: '/admin/analytics' }),
    ).not.toThrow();
  });
});

describe('authorize runs first, always', () => {
  test('false and {allowed:false} -> 403 forbidden, for known and UNKNOWN paths, so routes cannot be enumerated', async () => {
    for (const result of [false, { allowed: false }]) {
      const { handler, driver } = setup({}, { authorize: () => result });
      for (const path of ['/api/meta', '/api/nope', '/', '/anything/else']) {
        const { res, json } = await body(handler, req(path));
        expect(res.status).toBe(403);
        expect(json).toEqual({
          success: false,
          data: null,
          unavailable: null,
          error: { code: 'forbidden', message: 'Not authorised.' },
        });
      }
      expect(driver.calls).toHaveLength(0);
    }
  });

  test('authorize also runs before the method check and before parameter validation', async () => {
    const { handler } = setup({}, { authorize: () => false });
    expect((await handler.handle(req('/api/meta', {}, { method: 'POST' }))).status).toBe(403);
    expect((await handler.handle(req('/api/visits-over-time', { bogus: '1' }))).status).toBe(403);
  });

  test('a throwing or rejecting authorize fails closed with a generic 500, and is reported', async () => {
    for (const fn of [
      () => {
        throw new Error('db down: postgres://u:secret@h');
      },
      () => Promise.reject(new Error('x')),
    ]) {
      const { handler, driver, errors } = setup({}, { authorize: fn });
      const { res, json } = await body(handler, req('/api/meta'));
      expect(res.status).toBe(500);
      expect(json).toMatchObject({ success: false, error: { code: 'internal' } });
      expect(res.body).not.toContain('secret');
      expect(errors.some((e) => e.code === 'internal')).toBe(true);
      expect(driver.calls).toHaveLength(0);
    }
  });

  test('authorize receives the request (including the raw object) and may be async', async () => {
    const seen: DynaliticsRequest[] = [];
    const { handler } = setup(
      {},
      { authorize: (r: DynaliticsRequest) => (seen.push(r), Promise.resolve(true)) },
    );
    await handler.handle(req('/api/meta', {}, { headers: { authorization: 'Bearer x' } }));
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/api/meta',
      headers: { authorization: 'Bearer x' },
      raw: { marker: 'raw-request' },
    });
  });
});

describe('routing and headers', () => {
  test('only GET; 405 carries Allow', async () => {
    const { handler } = setup();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const res = await handler.handle(req('/api/meta', {}, { method }));
      expect(res.status).toBe(405);
      expect(res.headers['Allow']).toBe('GET');
    }
  });

  test('unknown route -> 404 (after authorize)', async () => {
    const { handler } = setup();
    for (const path of ['/api/nope', '/api/meta/', '/api', '/../etc/passwd', '/api/META']) {
      expect((await handler.handle(req(path))).status).toBe(404);
    }
  });

  test('every response carries the security headers; no CORS headers, no cookies', async () => {
    const { handler } = setup();
    for (const r of [
      req('/api/meta'),
      req('/api/nope'),
      req('/api/meta', {}, { method: 'POST' }),
    ]) {
      const { headers } = await handler.handle(r);
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(Object.keys(headers).filter((h) => /^access-control|^set-cookie/i.test(h))).toEqual(
        [],
      );
    }
  });

  test('invalid parameters -> 400 with the parameter name and no echo of the value', async () => {
    const { handler, driver } = setup();
    const evil = "x'; DROP TABLE events;--";
    const { res, json } = await body(handler, req('/api/visits-over-time', { interval: evil }));
    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      error: { code: 'invalid_parameter', param: 'interval' },
    });
    expect(res.body).not.toContain('DROP');
    expect(driver.calls).toHaveLength(0);
    expect(
      (
        await handler.handle(
          req('/api/visits-over-time', { from: '2026-01-01', to: '2026-10-01', interval: 'day' }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('GET /api/meta', () => {
  test('describes widgets, fields, limits and breakdowns from the model (no table or column names)', async () => {
    const { handler } = setup();
    const j = await ok(handler, req('/api/meta'));
    expect(j.data).toMatchObject({
      version: 2,
      now: '2026-10-30T12:05:00.000Z',
      intervals: ['hour', 'day', 'week', 'month'],
      limits: {
        maxRangeDays: 92,
        maxBuckets: 800,
        topPagesMax: 100,
        recentMax: 100,
        newVsReturningMaxRangeDays: 31,
      },
      defaults: { rangeDays: 7, interval: 'day', topPagesLimit: 10, recentLimit: 25 },
      breakdowns: [
        { key: 'consent', label: 'consent' },
        { key: 'plan', label: 'plan' },
      ],
      widgets: {
        newVsReturning: {
          available: true,
          source: 'computed',
          basis: 'user_id_then_ip',
          approximate: true,
        },
      },
      fields: {
        id: true,
        ipAddress: true,
        userId: true,
        username: true,
        email: true,
        isFirstVisit: true,
      },
      features: { recentVisitsCursor: true, piiRevealable: false },
    });
    expect(JSON.stringify(j)).not.toMatch(/visited_at|page_visited|public|events/);
    expect(j.meta).toMatchObject({ piiMasked: true, cached: false });
  });

  test('reports unmapped fields, unavailable widgets, and piiRevealable only when all conditions allow', async () => {
    const un = setup(
      {},
      {},
      { columns: { email: false, id: false, userId: false } },
      { ipMode: 'truncate' },
    );
    const j = await ok(un.handler, req('/api/meta'));
    expect(j.data.fields).toMatchObject({
      id: false,
      email: false,
      userId: false,
      ipAddress: true,
      isFirstVisit: false,
    });
    expect(j.data.features.recentVisitsCursor).toBe(false);
    expect(j.data.widgets.newVsReturning).toMatchObject({
      available: false,
      reason: 'identity_not_reliable',
    });

    const r1 = setup(
      {},
      { pii: { reveal: true }, authorize: () => ({ allowed: true, revealPii: true }) },
    );
    expect((await ok(r1.handler, req('/api/meta'))).data.features.piiRevealable).toBe(true);
    const r2 = setup({}, { pii: { reveal: true }, authorize: () => ({ allowed: true }) });
    expect((await ok(r2.handler, req('/api/meta'))).data.features.piiRevealable).toBe(false);
    const r3 = setup({}, { authorize: () => ({ allowed: true, revealPii: true }) });
    expect((await ok(r3.handler, req('/api/meta'))).data.features.piiRevealable).toBe(false);
  });

  test('breakdowns include isFirstVisit only when the write-time column exists', async () => {
    const { handler } = setup({}, {}, { firstVisit: { enabled: true } });
    const keys = (await ok(handler, req('/api/meta'))).data.breakdowns.map(
      (b: { key: string }) => b.key,
    );
    expect(keys).toEqual(['consent', 'isFirstVisit', 'plan']);
  });
});

describe('GET /api/visits-over-time', () => {
  const q = { from: '2026-10-24', to: '2026-10-27', interval: 'day' };
  test('zero-fills every bucket and totals them (PostgreSQL returns counts as strings)', async () => {
    const { handler } = setup({
      visits: [
        { bucket: '2026-10-25T00:00:00.000Z', visits: '412' },
        { bucket: '2026-10-26T00:00:00.000Z', visits: 389 },
      ],
    });
    const j = await ok(handler, req('/api/visits-over-time', q));
    expect(j.data).toEqual({
      interval: 'day',
      points: [
        { bucket: '2026-10-24T00:00:00.000Z', visits: 0 },
        { bucket: '2026-10-25T00:00:00.000Z', visits: 412 },
        { bucket: '2026-10-26T00:00:00.000Z', visits: 389 },
      ],
      total: 801,
    });
    expect(j.meta).toMatchObject({
      from: '2026-10-24T00:00:00.000Z',
      to: '2026-10-27T00:00:00.000Z',
      interval: 'day',
      piiMasked: true,
      cached: false,
    });
  });

  test('breakdown: top values, null series, and "other" = total - listed; all series zero-filled', async () => {
    const { handler, sql } = setup({
      visits: [
        { bucket: '2026-10-24T00:00:00.000Z', visits: 100 },
        { bucket: '2026-10-25T00:00:00.000Z', visits: 50 },
      ],
      breakdownTop: [
        { v: 'pro', n: 70 },
        { v: 'free', n: 40 },
      ],
      breakdownSeries: [
        { bucket: '2026-10-24T00:00:00.000Z', v: 'pro', n: 60 },
        { bucket: '2026-10-24T00:00:00.000Z', v: null, n: 10 },
        { bucket: '2026-10-25T00:00:00.000Z', v: 'free', n: 40 },
      ],
    });
    const j = await ok(handler, req('/api/visits-over-time', { ...q, breakdown: 'plan' }));
    expect(j.data.breakdown.key).toBe('plan');
    const series = j.data.breakdown.series as {
      value: string | null;
      isOther: boolean;
      points: { bucket: string; visits: number }[];
    }[];
    const counts = (s: (typeof series)[number]) => s.points.map((p) => p.visits);
    expect(series.map((s) => [s.value, s.isOther])).toEqual([
      ['pro', false],
      ['free', false],
      [null, false],
      [null, true],
    ]);
    expect(counts(series[0]!)).toEqual([60, 0, 0]);
    expect(counts(series[1]!)).toEqual([0, 40, 0]);
    expect(counts(series[2]!)).toEqual([10, 0, 0]);
    expect(counts(series[3]!)).toEqual([30, 10, 0]); // total - listed
    expect(sql().join('\n')).toContain(
      "('custom' ->>".replace("'custom'", '"custom"') + " 'plan')",
    );
  });

  test('breakdown by consent labels values "true"/"false"', async () => {
    const { handler } = setup({
      visits: [{ bucket: '2026-10-24T00:00:00.000Z', visits: 3 }],
      breakdownTop: [
        { v: 'true', n: 2 },
        { v: 'false', n: 1 },
      ],
      breakdownSeries: [
        { bucket: '2026-10-24T00:00:00.000Z', v: 'true', n: 2 },
        { bucket: '2026-10-24T00:00:00.000Z', v: 'false', n: 1 },
      ],
    });
    const j = await ok(handler, req('/api/visits-over-time', { ...q, breakdown: 'consent' }));
    expect(j.data.breakdown.series.map((s: { value: unknown }) => s.value)).toEqual([
      'true',
      'false',
      null,
      null,
    ]);
  });

  test('all values reach the database as bound parameters', async () => {
    const { handler, driver } = setup();
    await ok(handler, req('/api/visits-over-time', q));
    expect(driver.calls[0]?.params).toEqual([
      '2026-10-24T00:00:00.000Z',
      '2026-10-27T00:00:00.000Z',
    ]);
    expect(driver.calls[0]?.sql).toMatch(/\$1.*\$2/);
  });
});

describe('GET /api/top-pages', () => {
  test('shares, otherVisits, and visitor-controlled text passes through unchanged (the dashboard escapes)', async () => {
    const { handler } = setup({
      topTotal: [{ n: '801' }],
      top: [
        { page: '/pricing', n: '310' },
        { page: '<img src=x onerror=alert(1)>', n: 280 },
      ],
    });
    const j = await ok(handler, req('/api/top-pages', { limit: '2' }));
    expect(j.data).toEqual({
      totalVisits: 801,
      pages: [
        { page: '/pricing', visits: 310, share: 0.387 },
        { page: '<img src=x onerror=alert(1)>', visits: 280, share: 0.35 },
      ],
      otherVisits: 211,
    });
  });
  test('an empty range has zero totals and no division by zero', async () => {
    const { handler } = setup({ topTotal: [{ n: 0 }] });
    expect((await ok(handler, req('/api/top-pages'))).data).toEqual({
      totalVisits: 0,
      pages: [],
      otherVisits: 0,
    });
  });
});

describe('GET /api/consent-rate', () => {
  test('rate per bucket and overall, null when empty, zero-filled', async () => {
    const { handler } = setup({
      consent: [{ bucket: '2026-10-25T00:00:00.000Z', granted: '340', total: '412' }],
    });
    const j = await ok(handler, req('/api/consent-rate', { from: '2026-10-24', to: '2026-10-27' }));
    expect(j.data.points).toEqual([
      { bucket: '2026-10-24T00:00:00.000Z', granted: 0, denied: 0, rate: null },
      { bucket: '2026-10-25T00:00:00.000Z', granted: 340, denied: 72, rate: 0.825 },
      { bucket: '2026-10-26T00:00:00.000Z', granted: 0, denied: 0, rate: null },
    ]);
    expect(j.data.totals).toEqual({ granted: 340, denied: 72, rate: 0.825 });
  });
});

describe('GET /api/new-vs-returning (read-time)', () => {
  const q = { from: '2026-10-24', to: '2026-10-27' };
  test('new = first-ever rows in range, returning = identified - new, unknown = total - identified', async () => {
    const { handler, sql } = setup(
      {
        totals: [{ bucket: '2026-10-25T00:00:00.000Z', total: '412', identified: '340' }],
        newUser: [{ bucket: '2026-10-25T00:00:00.000Z', n: '90' }],
      },
      {},
      {},
      { ipMode: 'truncate' },
    ); // truncated ips are not an identity: user id only
    const j = await ok(handler, req('/api/new-vs-returning', q));
    expect(j.data).toMatchObject({
      interval: 'day',
      source: 'computed',
      basis: 'user_id',
      approximate: false,
    });
    expect(j.data.points[1]).toEqual({
      bucket: '2026-10-25T00:00:00.000Z',
      new: 90,
      returning: 250,
      unknown: 72,
    });
    expect(j.data.points[0]).toEqual({
      bucket: '2026-10-24T00:00:00.000Z',
      new: 0,
      returning: 0,
      unknown: 0,
    });
    expect(j.data.totals).toEqual({ new: 90, returning: 250, unknown: 72 });
    const all = sql().join('\n');
    expect(all).toContain('NOT EXISTS');
    expect(all).not.toContain('"ip_address" IS NULL'); // user id only: no ip query
  });

  test('with IP identity allowed both queries run and counts add up; approximate is flagged', async () => {
    const { handler, driver } = setup(
      {
        totals: [{ bucket: '2026-10-25T00:00:00.000Z', total: 100, identified: 80 }],
        newUser: [{ bucket: '2026-10-25T00:00:00.000Z', n: 10 }],
        newIp: [{ bucket: '2026-10-25T00:00:00.000Z', n: 5 }],
      },
      {},
      {},
      { ipMode: 'hash' },
    );
    const j = await ok(handler, req('/api/new-vs-returning', q));
    expect(j.data).toMatchObject({ basis: 'user_id_then_ip', approximate: true });
    expect(j.data.points[1]).toEqual({
      bucket: '2026-10-25T00:00:00.000Z',
      new: 15,
      returning: 65,
      unknown: 20,
    });
    expect(driver.calls).toHaveLength(3);
  });

  test('never reports negative returning even if the database races ahead', async () => {
    const { handler } = setup({
      totals: [{ bucket: '2026-10-25T00:00:00.000Z', total: 5, identified: 3 }],
      newUser: [{ bucket: '2026-10-25T00:00:00.000Z', n: 9 }],
    });
    expect((await ok(handler, req('/api/new-vs-returning', q))).data.points[1].returning).toBe(0);
  });

  test.each([
    ['no identity columns', { columns: { userId: false, ip: false } }, {}, 'no_identity_column'],
    [
      'only truncated ips',
      { columns: { userId: false } },
      { ipMode: 'truncate' as const },
      'identity_not_reliable',
    ],
  ])(
    'unavailable: %s -> 200 with data null and a reason (not an error)',
    async (_n, schema, fx, reason) => {
      const { handler, driver } = setup({}, {}, schema, fx);
      const { res, json } = await body(handler, req('/api/new-vs-returning', q));
      expect(res.status).toBe(200);
      expect(json).toMatchObject({
        success: true,
        data: null,
        error: null,
        unavailable: { reason },
      });
      expect(
        (json as { unavailable: { message: string } }).unavailable.message.length,
      ).toBeGreaterThan(10);
      expect(driver.calls).toHaveLength(0);
    },
  );

  test('ipIdentity "always" makes truncated ips usable but approximate; "never" refuses them', async () => {
    const a = setup(
      {},
      { newVsReturning: { ipIdentity: 'always' } },
      { columns: { userId: false } },
      { ipMode: 'truncate' },
    );
    expect((await ok(a.handler, req('/api/new-vs-returning', q))).data).toMatchObject({
      basis: 'ip',
      approximate: true,
    });
    const n = setup(
      {},
      { newVsReturning: { ipIdentity: 'never' } },
      { columns: { userId: false } },
      { ipMode: 'raw' },
    );
    expect((await body(n.handler, req('/api/new-vs-returning', q))).json).toMatchObject({
      unavailable: { reason: 'no_identity_column' },
    });
  });

  test('disabled by the host; and column source without the write-time column', async () => {
    const d = setup({}, { newVsReturning: { enabled: false } });
    expect((await body(d.handler, req('/api/new-vs-returning', q))).json).toMatchObject({
      unavailable: { reason: 'disabled_by_host' },
    });
    const c = setup({}, { newVsReturning: { source: 'column' } });
    expect((await body(c.handler, req('/api/new-vs-returning', q))).json).toMatchObject({
      unavailable: { reason: 'column_not_mapped' },
    });
  });

  test('source "column" reads the stored flag', async () => {
    const { handler } = setup(
      {
        newColumn: [
          { bucket: '2026-10-25T00:00:00.000Z', total: 100, new_count: 20, returning_count: 50 },
        ],
      },
      { newVsReturning: { source: 'column' } },
      { firstVisit: { enabled: true } },
    );
    const j = await ok(handler, req('/api/new-vs-returning', q));
    expect(j.data).toMatchObject({ source: 'column', approximate: true });
    expect(j.data.points[1]).toEqual({
      bucket: '2026-10-25T00:00:00.000Z',
      new: 20,
      returning: 50,
      unknown: 30,
    });
  });

  test('its range cap is smaller than the general one', async () => {
    const { handler } = setup();
    expect(
      (await handler.handle(req('/api/new-vs-returning', { from: '2026-09-01', to: '2026-10-30' })))
        .status,
    ).toBe(400);
    expect(
      (await handler.handle(req('/api/new-vs-returning', { from: '2026-09-01', to: '2026-10-30' })))
        .body,
    ).toContain('range_too_large');
  });
});

const row = (over: Record<string, unknown> = {}) => ({
  rid: '18231',
  ts_text: '2026-10-30T12:01:44.120Z',
  page: '/pricing',
  consent_flag: 1,
  ip_v: '203.0.113.77',
  user_v: 'u_42',
  name_v: 'jane',
  email_v: 'jane@example.com',
  custom_v: { plan: 'pro', campaign: 'fall', undeclared: 'x' },
  first_flag: 0,
  ...over,
});

describe('GET /api/recent-visits', () => {
  test('masks PII by default; personal custom fields become ***; only declared keys are returned', async () => {
    const { handler } = setup({ recent: [row()] });
    const j = await ok(handler, req('/api/recent-visits'));
    expect(j.data.visits[0]).toEqual({
      id: '18231',
      timestamp: '2026-10-30T12:01:44.120Z',
      pageVisited: '/pricing',
      consent: true,
      isFirstVisit: false,
      ipAddress: '203.0.x.x',
      userId: '***', // masked by default (F-06): ids under 6 characters are fully hidden
      username: 'j***',
      email: 'j***@example.com',
      custom: { plan: 'pro', campaign: '***' },
    });
    expect(j.meta.piiMasked).toBe(true);
    expect(JSON.stringify(j)).not.toMatch(/jane|203\.0\.113|fall|undeclared/);
  });

  test('nulls stay null for denied rows; JSON custom as text is parsed (SQL Server style)', async () => {
    const { handler } = setup({
      recent: [
        row({
          consent_flag: 0,
          ip_v: null,
          user_v: null,
          name_v: null,
          email_v: null,
          custom_v: '{"plan":"free"}',
          first_flag: null,
        }),
      ],
    });
    const v = (await ok(handler, req('/api/recent-visits'))).data.visits[0];
    expect(v).toMatchObject({
      consent: false,
      isFirstVisit: null,
      ipAddress: null,
      userId: null,
      username: null,
      email: null,
      custom: { plan: 'free' },
    });
    const none = setup({ recent: [row({ custom_v: null })] });
    expect((await ok(none.handler, req('/api/recent-visits'))).data.visits[0].custom).toBeNull();
  });

  test('unmapped roles come back as null on every row', async () => {
    const { handler } = setup(
      { recent: [row({ email_v: null, rid: null })] },
      {},
      { columns: { email: false, id: false } },
    );
    const j = await ok(handler, req('/api/recent-visits'));
    expect(j.data.visits[0]).toMatchObject({ id: null, email: null });
    expect(j.data.nextCursor).toBeNull();
  });

  test('reveal needs ALL of: pii.reveal option, authorize revealPii, ?pii=reveal (otherwise masked, never an error)', async () => {
    const answers = { recent: [row()] };
    const cases: [Record<string, unknown>, Record<string, string>, boolean][] = [
      [
        { pii: { reveal: true }, authorize: () => ({ allowed: true, revealPii: true }) },
        { pii: 'reveal' },
        true,
      ],
      [{ pii: { reveal: true }, authorize: () => ({ allowed: true, revealPii: true }) }, {}, false],
      [{ pii: { reveal: true }, authorize: () => ({ allowed: true }) }, { pii: 'reveal' }, false],
      [{ authorize: () => ({ allowed: true, revealPii: true }) }, { pii: 'reveal' }, false],
      [{ pii: { reveal: false }, authorize: () => true }, { pii: 'reveal' }, false],
    ];
    for (const [opts, query, revealed] of cases) {
      const { handler } = setup(answers, opts);
      const { res, json } = await body(handler, req('/api/recent-visits', query));
      expect(res.status).toBe(200);
      const j = json as Extract<typeof json, { success: true }>;
      expect(j.meta.piiMasked).toBe(!revealed);
      expect(j.data?.visits[0].email).toBe(revealed ? 'jane@example.com' : 'j***@example.com');
      expect(j.data?.visits[0].custom?.campaign).toBe(revealed ? 'fall' : '***');
    }
  });

  test('pagination: asks for limit+1, returns an opaque nextCursor from the last returned row, and accepts it back', async () => {
    const rows = [
      row({ rid: '30', ts_text: '2026-10-30T12:00:03.000Z' }),
      row({ rid: '29', ts_text: '2026-10-30T12:00:02.000Z' }),
      row({ rid: '28', ts_text: '2026-10-30T12:00:01.000Z' }),
    ];
    const { handler, driver } = setup({ recent: rows });
    const first = await ok(handler, req('/api/recent-visits', { limit: '2' }));
    expect(first.data.visits.map((v: { id: string }) => v.id)).toEqual(['30', '29']);
    expect(driver.calls[0]?.sql).toMatch(/LIMIT 3$/);
    const cursor = first.data.nextCursor as string;
    expect(Buffer.from(cursor, 'base64url').toString()).toBe('2026-10-30T12:00:02.000Z|29');
    await ok(handler, req('/api/recent-visits', { limit: '2', cursor }));
    const second = driver.calls[1]!;
    expect(second.sql).toContain('r."id" <');
    expect(second.params).toContain('2026-10-30T12:00:02.000Z');
    expect(second.params).toContain('29');
    const last = setup({ recent: rows.slice(0, 2) });
    expect(
      (await ok(last.handler, req('/api/recent-visits', { limit: '2' }))).data.nextCursor,
    ).toBeNull();
  });

  test('a tampered cursor is a 400 and never reaches the database', async () => {
    const { handler, driver } = setup();
    const bad = Buffer.from('2026-10-30T12:00:02.000Z|1 OR 1=1').toString('base64url');
    expect((await handler.handle(req('/api/recent-visits', { cursor: bad }))).status).toBe(400);
    expect(driver.calls).toHaveLength(0);
  });

  test('isFirstVisit is NULL when new-vs-returning is unavailable', async () => {
    const { handler, sql } = setup(
      { recent: [row({ first_flag: null })] },
      { newVsReturning: { enabled: false } },
    );
    const v = (await ok(handler, req('/api/recent-visits'))).data.visits[0];
    expect(v.isFirstVisit).toBeNull();
    expect(sql()[0]).toContain('NULL AS first_flag');
  });
});

describe('failures', () => {
  const failing = (e: unknown) => {
    const f = readFixture();
    f.driver.handler = () => {
      throw e;
    };
    return { ...f, handler: createHandler(f.dyn, { authorize: allow }) };
  };
  test('a database timeout is 504; other driver errors 503; both generic and reported', async () => {
    const t = failing(
      new DriverError(
        { name: 'Error', message: 'canceling statement due to statement timeout on "events"' },
        true,
        true,
      ),
    );
    const r = await t.handler.handle(req('/api/visits-over-time'));
    expect(r.status).toBe(504);
    expect(r.body).toContain('"code":"timeout"');
    expect(r.body).not.toMatch(/events|statement/);
    const u = failing(
      new DriverError(
        { name: 'Error', message: 'password authentication failed for user "x"' },
        false,
        false,
      ),
    );
    const r2 = await u.handler.handle(req('/api/top-pages'));
    expect(r2.status).toBe(503);
    expect(r2.body).not.toMatch(/password|authentication/);
    expect(u.errors).toHaveLength(1);
    const x = failing(new Error('boom: select * from secret'));
    const r3 = await x.handler.handle(req('/api/consent-rate'));
    expect(r3.status).toBe(500);
    expect(r3.body).not.toContain('select');
  });
});

describe('page', () => {
  const html =
    '<!doctype html><meta name="dynalitics-base" content="%%DYNALITICS_BASE%%"><script nonce="%%DYNALITICS_NONCE%%">1</script><style nonce="%%DYNALITICS_NONCE%%"></style>';
  test('serves the dashboard with a fresh nonce, the base path, and a strict CSP', async () => {
    const { handler } = setup({}, { dashboardHtml: html, basePath: '/admin/analytics' });
    const a = await handler.handle(req('/'));
    const b = await handler.handle(req('/'));
    expect(a.status).toBe(200);
    expect(a.headers['Content-Type']).toBe('text/html; charset=utf-8');
    const nonce = /nonce="([^"]+)"/.exec(a.body)?.[1] ?? '';
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.body).not.toContain('%%');
    expect(a.body).toContain('content="/admin/analytics"');
    expect(a.body.match(new RegExp(nonce, 'g'))).toHaveLength(2);
    expect(a.headers['Content-Security-Policy']).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(a.headers['X-Frame-Options']).toBe('DENY');
    expect(/nonce="([^"]+)"/.exec(b.body)?.[1]).not.toBe(nonce);
  });
  test('404 without dashboardHtml; 403 (not the page) when not authorised', async () => {
    expect((await setup().handler.handle(req('/'))).status).toBe(404);
    const locked = setup({}, { dashboardHtml: html, authorize: () => false });
    const r = await locked.handler.handle(req('/'));
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('nonce');
  });
});

describe('limits, cache and concurrency', () => {
  test('micro-cache: a repeat is served from memory with meta.cached = true; different params and masking modes do not collide', async () => {
    const { handler, driver } = setup({ visits: [] }, { cacheTtlMs: 5000 });
    const q = { from: '2026-10-24', to: '2026-10-27' };
    expect((await ok(handler, req('/api/visits-over-time', q))).meta.cached).toBe(false);
    expect((await ok(handler, req('/api/visits-over-time', q))).meta.cached).toBe(true);
    expect(driver.calls).toHaveLength(1);
    await ok(handler, req('/api/visits-over-time', { ...q, interval: 'week' }));
    expect(driver.calls).toHaveLength(2);
  });

  test('cache entries expire', async () => {
    vi.useFakeTimers();
    try {
      const { handler, driver } = setup({}, { cacheTtlMs: 1000 });
      await ok(handler, req('/api/top-pages'));
      await vi.advanceTimersByTimeAsync(1001);
      await ok(handler, req('/api/top-pages'));
      expect(driver.calls.length).toBeGreaterThanOrEqual(4); // two requests x two queries each
    } finally {
      vi.useRealTimers();
    }
  });

  test('concurrency is limited; a request that cannot get a slot in time is a 503', async () => {
    vi.useFakeTimers();
    try {
      const f = readFixture();
      f.driver.handler = () => new Promise(() => undefined);
      const handler = createHandler(f.dyn, {
        authorize: allow,
        limits: { concurrency: 1, timeoutMs: 1000 },
      });
      void handler.handle(req('/api/consent-rate'));
      await vi.advanceTimersByTimeAsync(0);
      const second = handler.handle(req('/api/consent-rate'));
      await vi.advanceTimersByTimeAsync(1000);
      expect((await second).status).toBe(503);
      expect(f.driver.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the configured query timeout is passed to the driver', async () => {
    const f = readFixture();
    const seen: number[] = [];
    f.driver.query = (_q, o) => (seen.push(o.timeoutMs), Promise.resolve([]));
    await createHandler(f.dyn, { authorize: allow, limits: { timeoutMs: 1234 } }).handle(
      req('/api/top-pages'),
    );
    expect(seen).toEqual([1234, 1234]);
  });
});

describe('QA review fixes', () => {
  const html = '<meta name="dynalitics-base" content="%%DYNALITICS_BASE%%">';

  test('F-07: the default base path is served as an EMPTY string, so the client never builds //api/meta', async () => {
    const { handler } = setup({}, { dashboardHtml: html });
    expect((await handler.handle(req('/'))).body).toBe('<meta name="dynalitics-base" content="">');
  });

  test('F-07: base paths that would produce protocol-relative or double-slash URLs are rejected; a trailing slash is normalised away', () => {
    const f = readFixture();
    for (const bad of ['//evil.example', '//x', '/a//b', '/a b', 'admin', '/a?x=1', '/..']) {
      expect(() =>
        createHandler(f.dyn, { authorize: allow, scope: 'none', basePath: bad }),
      ).toThrow(DynaliticsConfigError);
    }
    for (const good of ['/', '/admin', '/admin/', '/admin/analytics', '/a_b-c/d']) {
      expect(() =>
        createHandler(f.dyn, { authorize: allow, scope: 'none', basePath: good }),
      ).not.toThrow();
    }
  });

  test('F-01: only boolean true or { allowed: true } passes; every other value is refused and reported', async () => {
    for (const weird of [
      'yes',
      'false',
      1,
      {},
      [],
      { allowed: 'true' },
      { allowed: 1 },
      null,
      undefined,
      'x-user',
    ]) {
      const { handler, errors, driver } = setup({}, { authorize: () => weird });
      const res = await handler.handle(req('/api/meta'));
      expect(res.status).toBe(403);
      expect(errors.some((e) => e.code === 'authorize_invalid_result')).toBe(true);
      expect(driver.calls).toHaveLength(0);
    }
  });

  test('F-01: revealPii must be exactly true', async () => {
    for (const reveal of ['no', 1, 'true', {}]) {
      const { handler } = setup(
        { recent: [row()] },
        { pii: { reveal: true }, authorize: () => ({ allowed: true, revealPii: reveal }) },
      );
      const j = await ok(handler, req('/api/recent-visits', { pii: 'reveal' }));
      expect(j.meta.piiMasked).toBe(true);
    }
  });

  test('F-01: an authorize that never settles is cut off with a generic 500 (fail closed)', async () => {
    vi.useFakeTimers();
    try {
      const { handler, driver, errors } = setup(
        {},
        { authorize: () => new Promise(() => undefined), authorizeTimeoutMs: 2000 },
      );
      const pending = handler.handle(req('/api/meta'));
      await vi.advanceTimersByTimeAsync(2000);
      const res = await pending;
      expect(res.status).toBe(500);
      expect(errors.some((e) => e.code === 'internal')).toBe(true);
      expect(driver.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('F-06: userId is masked by default (u_***42 shape); revealed only under the triple condition', async () => {
    const answers = {
      recent: [row({ user_v: 'jane@example.com' }), row({ rid: '2', user_v: 'u_90042' })],
    };
    const masked = await ok(setup(answers).handler, req('/api/recent-visits'));
    expect(masked.data.visits[0].userId).toBe('j***@example.com');
    expect(masked.data.visits[1].userId).toBe('u_***42');
    const shown = await ok(
      setup(answers, {
        pii: { reveal: true },
        authorize: () => ({ allowed: true, revealPii: true }),
      }).handler,
      req('/api/recent-visits', { pii: 'reveal' }),
    );
    expect(shown.data.visits[1].userId).toBe('u_90042');
  });
});

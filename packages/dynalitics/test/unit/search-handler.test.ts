/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- test code reading untyped JSON responses */
// Spec 18.3 to 18.5: the explorer routes behind the real handler, with a fake reader.
import { describe, expect, test } from 'vitest';
import type { Dialect } from '../../src/model/types.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsRequest } from '../../src/read/types.js';
import { readFixture, type Answers } from '../helpers/read-fixture.js';

const DIALECTS: Dialect[] = ['postgres', 'mysql', 'mssql'];
const req = (path: string, query: Record<string, string> = {}): DynaliticsRequest => ({
  method: 'GET',
  path,
  query,
  headers: {},
  raw: {},
});

const CUSTOM = {
  plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
  amount: { type: 'number', personal: false },
  beta: { type: 'boolean', personal: false, breakdown: true },
  campaign: { type: 'string', maxLength: 64 }, // personal
} as const;

function setup(
  opts: { dialect?: Dialect; answers?: Answers; options?: Record<string, unknown> } = {},
) {
  const f = readFixture(
    opts.answers ?? {},
    { customFields: CUSTOM },
    opts.dialect === undefined ? {} : { dialect: opts.dialect },
  );
  const handler = createHandler(f.dyn, {
    authorize: () => ({ allowed: true, revealPii: true }),
    scope: 'none',
    ...opts.options,
  } as never);
  const call = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle(req(path, query));
    return { status: res.status, body: JSON.parse(res.body) as Record<string, any> };
  };
  return { ...f, handler, call };
}

const HOSTILE = `'); DROP TABLE events; -- 100%_off! [x] \\ /* plan:"x'y" -page:*/admin* amount:>=2 beta:true`;

describe('meta (18.1)', () => {
  test('lists the explorer, its non-personal fields and its limits', async () => {
    const { call } = setup();
    const { body } = await call('/api/meta');
    expect(body.data.widgets.explorer).toEqual({ available: true });
    expect(body.data.explorer.fields.map((f: { key: string }) => f.key)).toEqual([
      'page',
      'consent',
      'plan',
      'amount',
      'beta',
    ]);
    expect(body.data.explorer.limits).toEqual({
      maxQueryChars: 512,
      maxClauses: 12,
      maxValueChars: 128,
      maxRangeDays: 31,
      facetTop: 5,
      tailMinIntervalMs: 5000,
    });
    expect(body.data.version).toBe(2);
  });

  test('disabled: no explorer in meta and every explorer route is 404', async () => {
    const { call, driver } = setup({ options: { explorer: { enabled: false } } });
    const meta = (await call('/api/meta')).body.data;
    expect(meta.widgets.explorer).toMatchObject({ available: false, reason: 'disabled_by_host' });
    expect(meta.explorer).toBeUndefined();
    for (const p of ['/api/search', '/api/search/histogram', '/api/search/fields'])
      expect((await call(p)).status).toBe(404);
    expect(driver.calls).toHaveLength(0);
  });

  test('explorer.maxRangeDays never exceeds limits.maxRangeDays', async () => {
    const { call } = setup({
      options: { explorer: { maxRangeDays: 90 }, limits: { maxRangeDays: 14 } },
    });
    expect((await call('/api/meta')).body.data.explorer.limits.maxRangeDays).toBe(14);
  });
});

describe('F-39 and binding: the query never becomes SQL text', () => {
  test.each(DIALECTS)('%s', async (dialect) => {
    const { call, driver } = setup({
      dialect,
      answers: { breakdownTop: [{ v: "x'); DROP", n: 1 }] },
    });
    const q = HOSTILE.replace(' \\ ', ' ').replace(' /* ', ' ');
    for (const [path, extra] of [
      ['/api/search', {}],
      ['/api/search/histogram', { split: 'plan', interval: 'day' }],
      ['/api/search/fields', {}],
    ] as const) {
      const res = await call(path, { q, ...extra });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(driver.calls.length).toBeGreaterThan(5);
    for (const c of driver.calls) {
      expect(c.sql).not.toMatch(/;|--|\\|\/\*/);
      expect(c.sql).not.toContain('DROP');
      expect(c.sql).not.toContain('off');
      expect(c.sql).not.toContain('admin');
      const rest = c.sql
        .replace(/"[^"]*"|`[^`]*`|\[[^\]]*\]|'[^']*'|\$\d+|@p\d+|\?/g, '')
        .replace(/[A-Za-z0-9_ (),.*=<>%+:/-]/g, '');
      expect(rest, c.sql).toBe('');
    }
    const params = driver.calls.flatMap((c) => c.params);
    // lower-cased, LIKE metacharacters escaped with '!', wrapped for "contains"
    // whitespace splits terms; each is lower-cased, LIKE-escaped with '!' and wrapped for "contains"
    expect(params).toEqual(expect.arrayContaining(["%');%", '%100!%!_off!!%', '%![x]%']));
    expect(params).toContain("x'y");
    expect(params).toContain('%/admin%'); // -page:*/admin* is a negated contains
    expect(params).toContain(2);
  });
});

describe('positional parameters (MySQL ?): values are bound in text order', () => {
  test('the range comes first, then the filter values, in the order they appear', async () => {
    const { call, driver } = setup({ dialect: 'mysql' });
    await call('/api/search/fields', {
      q: 'Pro -plan:x amount:>2',
      from: '2026-10-20',
      to: '2026-10-21',
    });
    for (const c of driver.calls) {
      expect(c.sql.split('?').length - 1, c.sql).toBe(c.params.length);
      expect(c.params.slice(0, 2)).toEqual(['2026-10-20 00:00:00.000', '2026-10-21 00:00:00.000']);
      expect(c.params.slice(2)).toEqual(['%pro%', '%pro%', 'x', 2]);
    }
  });
});

describe('SQL shape (postgres)', () => {
  const sqlFor = async (q: string) => {
    const { call, sql } = setup();
    expect((await call('/api/search', { q })).status).toBe(200);
    return sql()[0] ?? '';
  };

  test('a bare term searches every text field, case-insensitively', async () => {
    const s = await sqlFor('Pro');
    expect(s).toContain(`LOWER(r."page_visited") LIKE $`);
    expect(s).toContain(`LOWER((r."custom" ->> 'plan')) LIKE $`);
    // personal columns are SELECTed for masking, but never appear in the WHERE clause
    const where = s.slice(s.indexOf(' WHERE r.'));
    expect(where).not.toMatch(/email|username|user_id|ip_address|campaign/);
  });

  test('negation is NULL-safe', async () => {
    expect(await sqlFor('-plan:pro')).toContain(`CASE WHEN (LOWER((r."custom" ->> 'plan')) = $`);
    expect(await sqlFor('-plan:pro')).toMatch(/THEN 1 ELSE 0 END = 0/);
  });

  test('numbers compare numerically, booleans through the dialect, consent:false includes NULL', async () => {
    expect(await sqlFor('amount:>3')).toContain(`SIMILAR TO`);
    expect(await sqlFor('amount:>3')).toMatch(/AS double precision\) END > \$\d/);
    expect(await sqlFor('beta:true')).toContain(`(r."custom" ->> 'beta') = 'true'`);
    expect(await sqlFor('consent:true')).toContain(`r."consent" IS TRUE`);
    expect(await sqlFor('consent:false')).toContain(
      `NOT (CASE WHEN r."consent" IS TRUE THEN 1 ELSE 0 END = 1)`,
    );
  });

  test('an empty query adds no condition', async () => {
    const s = await sqlFor('');
    expect(s).not.toContain('LIKE');
    expect(s).not.toContain('LOWER');
  });
});

describe('errors (18.4)', () => {
  test('invalid_query carries a fixed message, a reason and a position, never the query text', async () => {
    const { call, driver } = setup();
    const { status, body } = await call('/api/search', { q: 'pricing email:secret@corp.com' });
    expect(status).toBe(400);
    expect(body.error).toEqual({
      code: 'invalid_query',
      message: 'Unknown field, or a field that cannot be searched.',
      reason: 'unknown_field',
      position: 8,
    });
    expect(JSON.stringify(body)).not.toContain('secret@corp');
    expect(driver.calls).toHaveLength(0);
  });

  test('a personal custom field is refused exactly like an unknown one', async () => {
    const { call } = setup();
    const personal = (await call('/api/search', { q: 'campaign:x' })).body;
    const typo = (await call('/api/search', { q: 'campaigm:x' })).body;
    expect(personal).toEqual(typo);
  });

  test('split must be a facet field', async () => {
    const { call } = setup();
    expect((await call('/api/search/histogram', { split: 'amount' })).body.error.param).toBe(
      'split',
    );
    expect((await call('/api/search/histogram', { split: 'campaign' })).status).toBe(400);
    expect((await call('/api/search/histogram', { split: 'page' })).status).toBe(200);
  });

  test('q is not accepted by the other routes, and the explorer range is capped at 31 days', async () => {
    const { call } = setup();
    expect((await call('/api/recent-visits', { q: 'x' })).body.error.param).toBe('q');
    expect(
      (await call('/api/search', { from: '2026-09-01', to: '2026-10-30' })).body.error.code,
    ).toBe('range_too_large');
    expect((await call('/api/search', { from: '2026-10-01', to: '2026-10-30' })).status).toBe(200);
  });
});

describe('results', () => {
  const row = {
    rid: '9',
    ts_text: '2026-10-30T12:01:44.120Z',
    page: '/pricing',
    consent_flag: 1,
    ip_v: '203.0.113.9',
    user_v: 'user_123456',
    name_v: 'jane',
    email_v: 'jane@example.com',
    custom_v: { plan: 'pro', campaign: 'spring' },
    first_flag: 0,
  };

  test('search returns masked RecentVisit rows plus matched; reveal follows the triple condition', async () => {
    const { call } = setup({ answers: { recent: [row], topTotal: [{ n: 42 }] } });
    const masked = (await call('/api/search', { q: 'pricing' })).body;
    expect(masked.data.matched).toBe(42);
    expect(masked.meta.piiMasked).toBe(true);
    expect(masked.data.visits[0]).toMatchObject({
      pageVisited: '/pricing',
      email: 'j***@example.com',
      ipAddress: '203.0.x.x',
      custom: { plan: 'pro', campaign: '***' },
    });
    // authorize allows reveal, but the handler option pii.reveal is off: still masked
    const asked = (await call('/api/search', { q: 'pricing', pii: 'reveal' })).body;
    expect(asked.meta.piiMasked).toBe(true);

    const open = setup({
      answers: { recent: [row], topTotal: [{ n: 1 }] },
      options: { pii: { reveal: true } },
    });
    const revealed = (await open.call('/api/search', { q: 'pricing', pii: 'reveal' })).body;
    expect(revealed.meta.piiMasked).toBe(false);
    expect(revealed.data.visits[0].email).toBe('jane@example.com');
  });

  test('fields: top values, NULL count and "other" per facet field', async () => {
    const { call, driver } = setup({
      answers: {
        topTotal: [{ n: 10 }],
        breakdownTop: [
          { v: 'a', n: 4 },
          { v: 'b', n: 3 },
        ],
      },
    });
    const { body } = await call('/api/search/fields', { q: 'plan:*' });
    expect(body.data.matched).toBe(10);
    expect(body.data.fields.map((f: { key: string }) => f.key)).toEqual([
      'page',
      'consent',
      'plan',
      'beta',
    ]);
    expect(body.data.fields[0]).toEqual({
      key: 'page',
      values: [
        { value: 'a', count: 4 },
        { value: 'b', count: 3 },
      ],
      nullCount: 10,
      otherCount: 0,
    });
    // 1 count + (top + null) per facet field, every one filtered
    expect(driver.calls).toHaveLength(1 + 2 * 4);
    expect(driver.calls.every((c) => c.sql.includes(`IS NOT NULL`))).toBe(true);
  });

  test('histogram with split reuses the breakdown series (top values, NULL, other)', async () => {
    const { call } = setup({
      answers: {
        visits: [{ bucket: '2026-10-29T00:00:00.000Z', visits: 5 }],
        breakdownTop: [{ v: '/a', n: 3 }],
        breakdownSeries: [{ bucket: '2026-10-29T00:00:00.000Z', v: '/a', n: 3 }],
      },
    });
    const { body } = await call('/api/search/histogram', {
      from: '2026-10-28',
      to: '2026-10-30',
      split: 'page',
    });
    expect(body.data.total).toBe(5);
    expect(body.data.breakdown.key).toBe('page');
    expect(body.data.breakdown.series.map((s: { value: string | null }) => s.value)).toEqual([
      '/a',
      null,
      null,
    ]);
    expect(body.meta.interval).toBe('day');
  });
});

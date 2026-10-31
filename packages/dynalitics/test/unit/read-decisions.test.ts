/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test code reading untyped JSON responses */
import { describe, expect, test, vi } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import { DynaliticsConfigError } from '../../src/errors.js';
import { DriverError } from '../../src/driver/types.js';
import type { Dialect } from '../../src/model/types.js';
import { createHandler, type ReadErrorInfo } from '../../src/read/handler.js';
import { encodeCursor } from '../../src/read/params.js';
import type { DynaliticsRequest } from '../../src/read/types.js';
import { answerFor, readFixture, type Answers } from '../helpers/read-fixture.js';

const req = (
  path: string,
  query: Record<string, string> = {},
  over: Partial<DynaliticsRequest> = {},
): DynaliticsRequest => ({
  method: 'GET',
  path,
  query,
  headers: {},
  raw: {},
  ...over,
});
const allow = () => true;
const DIALECTS: Dialect[] = ['postgres', 'mysql', 'mssql'];

function setup(
  opts: {
    answers?: Answers;
    dialect?: Dialect;
    ipMode?: 'raw' | 'hash' | 'truncate';
    options?: Record<string, unknown>;
  } = {},
) {
  const f = readFixture(
    opts.answers ?? {},
    {},
    {
      ...(opts.dialect === undefined ? {} : { dialect: opts.dialect }),
      ...(opts.ipMode === undefined ? {} : { ipMode: opts.ipMode }),
    },
  );
  const handler = createHandler(f.dyn, {
    authorize: allow,
    scope: 'none',
    ...opts.options,
  } as never);
  return { ...f, handler };
}
const json = async (h: ReturnType<typeof createHandler>, r: DynaliticsRequest) =>
  JSON.parse((await h.handle(r)).body);

describe('F-08: scope', () => {
  test('without a scope the handler warns at creation (and says how to acknowledge); scope "none" is silent', () => {
    const f = readFixture();
    createHandler(f.dyn, { authorize: allow });
    expect(f.logs.filter((l) => l.startsWith('warn:'))).toHaveLength(1);
    expect(f.logs.join('\n')).toMatch(
      /reads every row.*scope: \{ column, value \}.*scope: "none"/s,
    );
    const g = readFixture();
    createHandler(g.dyn, { authorize: allow, scope: 'none' });
    createHandler(g.dyn, { authorize: allow, scope: { column: 'tenant_id', value: 7 } });
    expect(g.logs.filter((l) => l.startsWith('warn:'))).toEqual([]);
  });

  test.each([
    [{ column: 'tenant id', value: 1 }],
    [{ column: 'a"; DROP TABLE x;--', value: 1 }],
    [{ column: 'tenant_id', value: {} }],
    [{ column: 'tenant_id', value: Number.NaN }],
    [{ column: 'tenant_id' }],
    [{ column: 'tenant_id', value: 1, extra: true }],
    ['all'],
    [[]],
    [
      [
        { column: 'a', value: 1 },
        { column: 'A', value: 2 },
      ],
    ],
  ])('an invalid scope %j is refused when the handler is created', (scope) => {
    const f = readFixture();
    expect(() => createHandler(f.dyn, { authorize: allow, scope } as never)).toThrow(
      DynaliticsConfigError,
    );
  });

  test.each(DIALECTS)(
    '%s: EVERY table reference in EVERY read statement of EVERY route is scoped with a bound parameter',
    async (dialect) => {
      const ts = '2026-10-30T12:00:00.000Z';
      const answers: Answers = {
        visits: [{ bucket: '2026-10-25T00:00:00.000Z', visits: 3 }],
        breakdownTop: [{ v: 'pro', n: 2 }],
        breakdownSeries: [],
        topTotal: [{ n: 3 }],
        top: [{ page: '/a', n: 3 }],
        consent: [],
        totals: [{ bucket: '2026-10-25T00:00:00.000Z', total: 3, identified: 2 }],
        recent: Array.from({ length: 4 }, (_, i) => ({
          rid: String(10 - i),
          ts_text: ts,
          page: '/a',
          consent_flag: 1,
          ip_v: null,
          user_v: 'u1',
          name_v: null,
          email_v: null,
          custom_v: null,
          first_flag: 1,
        })),
      };
      const { handler, driver } = setup({
        dialect,
        answers,
        ipMode: 'raw',
        options: {
          scope: [
            { column: 'tenant_id', value: 7 },
            { column: 'site', value: 'main' },
          ],
        },
      });
      const cursor = encodeCursor(new Date(ts), '10');
      const range = { from: '2026-10-24', to: '2026-10-27' };
      const calls: [string, Record<string, string>][] = [
        ['/api/visits-over-time', range],
        ['/api/visits-over-time', { ...range, breakdown: 'plan' }],
        ['/api/visits-over-time', { ...range, breakdown: 'consent' }],
        ['/api/top-pages', range],
        ['/api/consent-rate', range],
        ['/api/new-vs-returning', range],
        ['/api/recent-visits', { ...range, limit: '3' }],
        ['/api/recent-visits', { ...range, limit: '3', cursor }],
      ];
      for (const [path, query] of calls)
        expect((await handler.handle(req(path, query))).status).toBe(200);

      const d = getDialect(dialect);
      const table = d.qualifiedTable({ schema: 'public', name: 'events' });
      const marker = (col: string) =>
        new RegExp(
          `(?:\\b[a-z]\\.)?${d.quoteIdent(col).replace(/[[\]]/g, '\\$&')} = (?:\\$\\d+|\\?|@p\\d+)`,
          'g',
        );
      expect(driver.calls.length).toBeGreaterThan(calls.length); // nvr and breakdown run several statements
      for (const call of driver.calls) {
        const refs = call.sql.split(`FROM ${table}`).length - 1;
        expect(refs, call.sql).toBeGreaterThan(0);
        expect((call.sql.match(marker('tenant_id')) ?? []).length, call.sql).toBe(refs);
        expect((call.sql.match(marker('site')) ?? []).length, call.sql).toBe(refs);
        expect(call.params.filter((p) => p === 7)).toHaveLength(refs);
        expect(call.params.filter((p) => p === 'main')).toHaveLength(refs);
      }
    },
  );

  test('without a scope no scope predicate is added', async () => {
    const { handler, driver } = setup({ options: { scope: 'none' } });
    await handler.handle(req('/api/top-pages'));
    expect(driver.calls.every((c) => !c.sql.includes('tenant_id'))).toBe(true);
  });
});

describe('F-39: read statements contain no user-controlled characters', () => {
  test.each(DIALECTS)('%s', async (dialect) => {
    const { handler, driver } = setup({
      dialect,
      options: { scope: { column: 'tenant_id', value: "7'; DROP TABLE events; --" } },
      answers: { breakdownTop: [{ v: "x'); DROP", n: 1 }] },
    });
    const cursor = encodeCursor(new Date('2026-10-30T12:00:00.000Z'), '123');
    for (const [path, query] of [
      [
        '/api/visits-over-time',
        { from: '2026-10-24', to: '2026-10-27', breakdown: 'plan', interval: 'week' },
      ],
      ['/api/top-pages', { limit: '7' }],
      ['/api/new-vs-returning', { from: '2026-10-24', to: '2026-10-27' }],
      ['/api/recent-visits', { limit: '9', cursor }],
    ] as const)
      await handler.handle(req(path, { ...query }));
    expect(driver.calls.length).toBeGreaterThan(4);
    for (const call of driver.calls) {
      expect(call.sql).not.toMatch(/;|--|\\|\/\*/);
      expect(call.sql).not.toContain('DROP');
      expect(call.sql).not.toContain("x')");
      // remove quoted identifiers, quoted literals (JSON paths, date formats) and parameter markers: what is left is fixed SQL text
      const rest = call.sql
        .replace(/"[^"]*"|`[^`]*`|\[[^\]]*\]|'[^']*'|\$\d+|@p\d+|\?/g, '')
        .replace(/[A-Za-z0-9_ (),.*=<>%+:/-]/g, '');
      expect(rest, call.sql).toBe('');
    }
    // the hostile values travelled as parameters
    expect(driver.calls.some((c) => c.params.includes("7'; DROP TABLE events; --"))).toBe(true);
  });
});

describe('F-06: userId is masked by default (pii.maskUserId)', () => {
  const row = (user_v: string | null) => ({
    rid: '1',
    ts_text: '2026-10-30T12:01:44.120Z',
    page: '/p',
    consent_flag: 1,
    ip_v: null,
    user_v,
    name_v: null,
    email_v: null,
    custom_v: null,
    first_flag: 0,
  });
  const userOf = async (
    user: string | null,
    options: Record<string, unknown> = {},
    query: Record<string, string> = {},
  ) =>
    (
      await json(
        setup({ answers: { recent: [row(user)] }, options }).handler,
        req('/api/recent-visits', query),
      )
    ).data.visits[0].userId;

  test('default: masked; short ids are fully hidden', async () => {
    expect(await userOf('u_90042')).toBe('u_***42');
    expect(await userOf('u_42')).toBe('***');
    expect(await userOf('jane@example.com')).toBe('j***@example.com');
    expect(await userOf(null)).toBeNull();
  });
  test('revealed only under the same triple condition as the other PII', async () => {
    const on = { pii: { reveal: true }, authorize: () => ({ allowed: true, revealPii: true }) };
    expect(await userOf('u_90042', on, { pii: 'reveal' })).toBe('u_90042');
    expect(await userOf('u_90042', on)).toBe('u_***42');
    expect(
      await userOf('u_90042', { pii: { reveal: true }, authorize: () => true }, { pii: 'reveal' }),
    ).toBe('u_***42');
  });
  test('pii.maskUserId: false shows ids even without reveal', async () => {
    expect(await userOf('u_90042', { pii: { maskUserId: false } })).toBe('u_90042');
    expect(await userOf('jane@example.com', { pii: { maskUserId: false } })).toBe(
      'jane@example.com',
    );
  });
});

describe('F-07: base path is normalised server side', () => {
  const html = '<meta name="dynalitics-base" content="%%DYNALITICS_BASE%%">';
  const served = async (basePath?: string) => {
    const { handler } = setup({
      options: { dashboardHtml: html, ...(basePath === undefined ? {} : { basePath }) },
    });
    return { handler, body: (await handler.handle(req('/'))).body };
  };
  test.each([
    [undefined, ''],
    ['/', ''],
    ['/admin', '/admin'],
    ['/admin/', '/admin'],
    ['/admin/analytics/', '/admin/analytics'],
    ['/a_b-c/d', '/a_b-c/d'],
  ])('basePath %j is served as %j', async (input, expected) => {
    const { handler, body } = await served(input);
    expect(body).toBe(`<meta name="dynalitics-base" content="${expected}">`);
    expect(handler.basePath).toBe(expected);
  });
  test.each([
    '//x',
    '//evil.example',
    '/a//b',
    '/a///',
    '/a b',
    'admin',
    '/a?x=1',
    '/..',
    '/a/../b',
    '/%2e',
    '',
    '/a\\b',
  ])('basePath %j is rejected', (bad) => {
    const f = readFixture();
    expect(() => createHandler(f.dyn, { authorize: allow, scope: 'none', basePath: bad })).toThrow(
      DynaliticsConfigError,
    );
  });
});

describe('F-17: exact-match routing, decided after authorize', () => {
  const evil = [
    '/api//meta',
    '/api/meta/',
    '/api/%6Deta',
    '/api/%2e%2e/meta',
    '/api/../api/meta',
    '/./api/meta',
    '/api/meta%00',
    '/api\\meta',
    '/API/meta',
    '/api/meta?x',
    '//api/meta',
    '/api/meta;x=1',
    '/api/meta.json',
  ];
  test.each(evil)(
    '%j is 404 when authorised and 403 when not (never routed, never an oracle)',
    async (path) => {
      expect((await setup().handler.handle(req(path))).status).toBe(404);
      expect(
        (await setup({ options: { authorize: () => false } }).handler.handle(req(path))).status,
      ).toBe(403);
    },
  );
  test('HEAD and OPTIONS are 405', async () => {
    for (const method of ['HEAD', 'OPTIONS'])
      expect((await setup().handler.handle(req('/api/meta', {}, { method }))).status).toBe(405);
  });
});

describe('F-15: the micro-cache is bounded', () => {
  test('10 000 distinct time ranges keep it under its cap', async () => {
    const { handler } = setup({ options: { cacheTtlMs: 60_000 } });
    for (let i = 0; i < 10_000; i++) {
      const to = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
      await handler.handle(req('/api/top-pages', { from: '2026-09-30', to }));
    }
    expect(handler.cacheSize?.()).toBeLessThanOrEqual(200);
  });
  test('entries survive while the cache is below its cap, and two default requests within the TTL hit', async () => {
    const { handler, driver } = setup({ options: { cacheTtlMs: 60_000 } });
    await handler.handle(req('/api/top-pages'));
    for (let i = 0; i < 300; i++) {
      // only 28 distinct keys: far below the cap of 200
      await handler.handle(
        req('/api/consent-rate', {
          from: '2026-10-01',
          to: `2026-10-${String((i % 28) + 2).padStart(2, '0')}`,
          interval: 'day',
        }),
      );
    }
    const before = driver.calls.length;
    await handler.handle(req('/api/top-pages')); // served from memory
    expect(driver.calls.length).toBe(before);
    expect(handler.cacheSize?.()).toBe(29);
  });
  test('without a TTL nothing is cached', async () => {
    const { handler } = setup();
    await handler.handle(req('/api/top-pages'));
    expect(handler.cacheSize?.()).toBe(0);
  });
});

describe('F-40: the handler reports a small, redacted payload and never the request', () => {
  test('route, status, code, message and a sanitised cause only', async () => {
    const seen: ReadErrorInfo[] = [];
    const secretHeaders = { authorization: 'Bearer SECRET-TOKEN', cookie: 'sid=SECRET-COOKIE' };
    const f = readFixture();
    f.driver.handler = () => {
      throw new DriverError(
        { name: 'Error', code: 'ECONNRESET', message: 'connection reset' },
        true,
        false,
      );
    };
    const throwing = createHandler(f.dyn, {
      authorize: allow,
      scope: 'none',
      onError: (e: ReadErrorInfo) => void seen.push(e),
    });
    await throwing.handle(
      req('/api/top-pages', {}, { headers: secretHeaders, raw: { secret: 'SECRET-RAW' } }),
    );
    const denied = createHandler(f.dyn, {
      authorize: () => 'weird' as never,
      scope: 'none',
      onError: (e: ReadErrorInfo) => void seen.push(e),
    });
    await denied.handle(
      req('/api/meta', {}, { headers: secretHeaders, raw: { secret: 'SECRET-RAW' } }),
    );
    const boom = createHandler(f.dyn, {
      authorize: () => {
        throw new Error('boom SECRET-THROWN');
      },
      scope: 'none',
      onError: (e: ReadErrorInfo) => void seen.push(e),
    });
    await boom.handle(req('/api/meta', {}, { headers: secretHeaders }));

    expect(seen.map((e) => [e.route, e.status, e.code])).toEqual([
      ['/api/top-pages', 503, 'unavailable'],
      ['/api/meta', 403, 'authorize_invalid_result'],
      ['/api/meta', 500, 'internal'],
    ]);
    for (const e of seen)
      expect(Object.keys(e).sort()).toEqual(
        expect.arrayContaining(['code', 'message', 'route', 'status']),
      );
    const dump = JSON.stringify(seen);
    for (const secret of ['SECRET-TOKEN', 'SECRET-COOKIE', 'SECRET-RAW', 'SECRET-THROWN'])
      expect(dump).not.toContain(secret);
    expect(seen[0]?.cause).toEqual({
      name: 'Error',
      code: 'ECONNRESET',
      message: 'connection reset',
    });
  });
});

describe('F-38: the new-vs-returning invariant is checked, not hidden', () => {
  test('more first-time identities than identified visits is reported (and the output stays consistent)', async () => {
    const answers: Answers = {
      totals: [{ bucket: '2026-10-25T00:00:00.000Z', total: 5, identified: 3 }],
      newUser: [{ bucket: '2026-10-25T00:00:00.000Z', n: 9 }],
    };
    const f = readFixture(answers, {}, { ipMode: 'truncate' });
    const handler = createHandler(f.dyn, { authorize: allow, scope: 'none' });
    const j = await json(
      handler,
      req('/api/new-vs-returning', { from: '2026-10-24', to: '2026-10-27' }),
    );
    expect(j.data.points[1]).toEqual({
      bucket: '2026-10-25T00:00:00.000Z',
      new: 3,
      returning: 0,
      unknown: 2,
    });
    expect(f.errors.some((e) => /new-vs-returning/.test(e.message))).toBe(true);
  });
  test('a consistent result reports nothing', async () => {
    const f = readFixture(
      {
        totals: [{ bucket: '2026-10-25T00:00:00.000Z', total: 5, identified: 3 }],
        newUser: [{ bucket: '2026-10-25T00:00:00.000Z', n: 2 }],
      },
      {},
      { ipMode: 'truncate' },
    );
    await json(
      createHandler(f.dyn, { authorize: allow, scope: 'none' }),
      req('/api/new-vs-returning', { from: '2026-10-24', to: '2026-10-27' }),
    );
    expect(f.errors).toEqual([]);
  });
});

describe('F-34: counts cannot overflow on SQL Server', () => {
  test.each([
    ['postgres', 'COUNT(*)'],
    ['mysql', 'COUNT(*)'],
    ['mssql', 'COUNT_BIG(*)'],
  ] as const)('%s counts with %s', async (dialect, fn) => {
    expect(getDialect(dialect).read.count).toBe(fn);
    const { handler, driver } = setup({ dialect, answers: { visits: [] } });
    await handler.handle(req('/api/visits-over-time'));
    await handler.handle(req('/api/top-pages'));
    for (const c of driver.calls) {
      expect(c.sql).toContain(fn);
      if (dialect === 'mssql') expect(c.sql).not.toMatch(/COUNT\(\*\)/);
    }
  });
  test('counts that arrive as strings or bigints are converted', async () => {
    const f = readFixture({
      visits: [{ bucket: '2026-10-25T00:00:00.000Z', visits: '9007199254740' }],
      topTotal: [{ n: BigInt(5) }],
      top: [],
    });
    const handler = createHandler(f.dyn, { authorize: allow, scope: 'none' });
    expect(
      (await json(handler, req('/api/visits-over-time', { from: '2026-10-25', to: '2026-10-26' })))
        .data.total,
    ).toBe(9007199254740);
    expect((await json(handler, req('/api/top-pages'))).data.totalVisits).toBe(5);
  });
});

describe('answerFor is used by the fixture', () => {
  test('sanity', () => {
    expect(answerFor({})({ sql: 'SELECT 1', params: [] })).toEqual([]);
    expect(vi.isFakeTimers()).toBe(false);
  });
});

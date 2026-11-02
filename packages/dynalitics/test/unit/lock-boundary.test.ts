import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createHandler } from '../../src/read/handler.js';
import { createReporter } from '../../src/read/report.js';
import { KNOWN_ROUTES, createReadService } from '../../src/read/service.js';
import type { Authorize, DynaliticsRequest } from '../../src/read/types.js';
import { getInternals } from '../../src/internals.js';
import { readFixture } from '../helpers/read-fixture.js';

// The boundary between the lock layer and the database side (docs/SPEC.md 15.1, 16). Two promises, each enforced twice:
//  1. The database is never queried without an allow decision. Behaviourally (a counting driver behind the real
//     handler) and structurally (the lock modules cannot reach the database code).
//  2. The database side only knows a Grant. It never receives the request, headers, authorize or basePath.

const req = (over: Partial<DynaliticsRequest> = {}): DynaliticsRequest => ({
  method: 'GET',
  path: '/api/top-pages',
  query: {},
  headers: { cookie: 'session=secret', authorization: 'Bearer secret' },
  raw: {},
  ...over,
});

/** Every kind of request a hostile or confused caller could send, against every route. */
const PROBES: DynaliticsRequest[] = [
  ...[
    '/',
    '/api/meta',
    '/api/visits-over-time',
    '/api/top-pages',
    '/api/new-vs-returning',
    '/api/consent-rate',
    '/api/recent-visits',
  ].flatMap((path) => [
    req({ path }),
    req({ path, method: 'POST' }),
    req({ path, query: { pii: 'reveal' } }),
  ]),
  req({ path: '//api/meta' }),
  req({ path: '/api/meta/' }),
  req({ path: '/api/../api/meta' }),
  req({ path: '/nope' }),
];

describe('the database is never queried without an allow decision', () => {
  const denials: readonly [string, Authorize][] = [
    ['false', () => false],
    ['{ allowed: false }', () => ({ allowed: false })],
    ['a malformed result', (() => 'yes') as unknown as Authorize],
    ['undefined', (() => undefined) as unknown as Authorize],
    [
      'a throw',
      () => {
        throw new Error('boom');
      },
    ],
    ['a rejection', () => Promise.reject(new Error('boom'))],
    ['a hang', () => new Promise<never>(() => undefined)],
  ];
  test.each(denials)(
    'authorize says %s: no query reaches the driver, for any request',
    async (_name, authorize) => {
      const f = readFixture();
      const handler = createHandler(f.dyn, { authorize, authorizeTimeoutMs: 100, scope: 'none' });
      for (const probe of PROBES) {
        const res = await handler.handle(probe);
        expect([403, 500]).toContain(res.status);
      }
      expect(f.driver.calls).toEqual([]);
    },
  );

  test('control: with an allow the same driver IS used, so the zero above means something', async () => {
    const f = readFixture();
    const handler = createHandler(f.dyn, { authorize: () => true, scope: 'none' });
    await handler.handle(req({ path: '/api/top-pages' }));
    expect(f.driver.calls.length).toBeGreaterThan(0);
  });

  test('an allow still reaches no query for a wrong method, a non-canonical path or the page', async () => {
    const f = readFixture();
    const handler = createHandler(f.dyn, {
      authorize: () => true,
      dashboardHtml: '<p>%%DYNALITICS_NONCE%%</p>',
      scope: 'none',
    });
    for (const probe of [
      req({ method: 'POST' }),
      req({ method: 'DELETE', path: '/api/meta' }),
      req({ path: '//api/meta' }),
      req({ path: '/api/meta/' }),
      req({ path: '/' }),
      req({ path: '/api/unknown-route' }),
    ]) {
      await handler.handle(probe);
    }
    expect(f.driver.calls).toEqual([]);
  });

  test('authorize is awaited before anything else: a slow allow delays the query, a late deny wins', async () => {
    const f = readFixture();
    let release: (v: boolean) => void = () => undefined;
    const handler = createHandler(f.dyn, {
      authorize: () => new Promise<boolean>((r) => (release = r)),
      scope: 'none',
    });
    const pending = handler.handle(req());
    await new Promise((r) => setTimeout(r, 20));
    expect(f.driver.calls).toEqual([]); // still waiting for the decision: nothing has run
    release(false);
    expect((await pending).status).toBe(403);
    expect(f.driver.calls).toEqual([]);
  });

  test('structural: no lock module can reach the database side', () => {
    const dir = join(import.meta.dirname, '../../src/read/lock');
    const forbidden =
      /from ['"](?:\.\.\/(?:service|queries|routes|params|mask|buckets|semaphore|scope|capabilities|handler)|\.\.\/\.\.\/(?:driver|dialect|model|create|startup|track|queue|internals)|pg|mysql2|mssql)[^'"]*['"]/;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(forbidden);
    }
  });
});

describe('the database side only knows a Grant', () => {
  test('ReadService.run takes (route, query, grant): no request, headers, authorize or basePath', () => {
    const f = readFixture();
    const internals = getInternals(f.dyn);
    if (internals === undefined) throw new Error('no internals');
    const service = createReadService(
      internals,
      { maskUserId: true, scope: 'none' },
      createReporter(undefined, internals, KNOWN_ROUTES),
    );
    expect(service.run.length).toBe(3);
  });

  test('case variants pass the canonical check but are not routes: not_found, and no query runs', async () => {
    const f = readFixture();
    const handler = createHandler(f.dyn, { authorize: () => true, scope: 'none' });
    for (const path of ['/API/meta', '/Api/top-pages', '/api/Meta']) {
      expect((await handler.handle(req({ path }))).status).toBe(404);
    }
    expect(f.driver.calls).toEqual([]);
  });

  test('the service never throws: a driver failure becomes an error outcome with no driver text', async () => {
    const f = readFixture();
    f.driver.handler = () => {
      throw new Error('FATAL: password authentication failed for user "secret_user"');
    };
    const internals = getInternals(f.dyn);
    if (internals === undefined) throw new Error('no internals');
    const reports: unknown[] = [];
    const service = createReadService(
      internals,
      { maskUserId: true, scope: 'none' },
      (...args) => void reports.push(args),
    );
    const outcome = await service.run('/api/top-pages', {}, { reveal: false, revealable: false });
    expect(outcome).toEqual({ kind: 'error', code: 'internal' });
    expect(JSON.stringify(outcome)).not.toContain('secret_user');
    expect(reports.length).toBeGreaterThan(0);
  });

  test('an unknown route is not_found and a bad parameter keeps its name; neither runs a query', async () => {
    const f = readFixture();
    const internals = getInternals(f.dyn);
    if (internals === undefined) throw new Error('no internals');
    const service = createReadService(internals, { maskUserId: true, scope: 'none' }, vi.fn());
    const grant = { reveal: false, revealable: false };
    expect(await service.run('/api/nope', {}, grant)).toEqual({ kind: 'error', code: 'not_found' });
    expect(await service.run('/api/top-pages', { from: 'garbage' }, grant)).toEqual({
      kind: 'error',
      code: 'invalid_parameter',
      param: 'from',
    });
    expect(f.driver.calls).toEqual([]);
  });

  test('masking follows the grant only: a grant without reveal masks, whatever the query asks', async () => {
    const f = readFixture({
      recent: [
        {
          rid: '1',
          ts_text: '2026-10-30T11:00:00.000Z',
          page: '/a',
          consent_flag: 1,
          ip_v: '198.51.100.10',
          user_v: 'u_alice',
          name_v: 'alice',
          email_v: 'alice@example.com',
          custom_v: null,
          first_flag: 0,
        },
      ],
    });
    const internals = getInternals(f.dyn);
    if (internals === undefined) throw new Error('no internals');
    const service = createReadService(internals, { maskUserId: true, scope: 'none' }, vi.fn());
    const run = (reveal: boolean) =>
      service.run('/api/recent-visits', { pii: 'reveal' }, { reveal, revealable: reveal });
    const masked = await run(false);
    const open = await run(true);
    expect(JSON.stringify(masked)).not.toContain('alice@example.com');
    expect(JSON.stringify(open)).toContain('alice@example.com');
  });
});

describe('the reporter echoes only known routes', () => {
  test('a hostile path never reaches onError; the route list is exactly the routed paths', () => {
    const seen: string[] = [];
    const report = createReporter(
      (i) => void seen.push(i.route),
      { report: vi.fn() },
      KNOWN_ROUTES,
    );
    report('/api/meta', 'internal', 'm');
    report('/../etc/passwd?x=<script>', 'internal', 'm');
    report('/api/top-pages', 'authorize_invalid_result', 'm');
    expect(seen).toEqual(['/api/meta', '(other)', '/api/top-pages']);
    expect([...KNOWN_ROUTES].sort()).toEqual(
      [
        '/',
        '/api/consent-rate',
        '/api/errors',
        '/api/countries',
        '/api/world-map',
        '/api/meta',
        '/api/new-vs-returning',
        '/api/recent-visits',
        '/api/search',
        '/api/search/fields',
        '/api/search/histogram',
        '/api/top-pages',
        '/api/visits-over-time',
      ].sort(),
    );
  });
  test('the status in the report is 403 for an invalid authorize result, the mapped status otherwise', () => {
    const seen: number[] = [];
    const report = createReporter(
      (i) => void seen.push(i.status),
      { report: vi.fn() },
      KNOWN_ROUTES,
    );
    report('/', 'authorize_invalid_result', 'm');
    report('/', 'internal', 'm');
    report('/', 'timeout', 'm');
    expect(seen).toEqual([403, 500, 504]);
  });
  test('a throwing onError cannot break the handler', () => {
    const report = createReporter(
      () => {
        throw new Error('host bug');
      },
      { report: vi.fn() },
      KNOWN_ROUTES,
    );
    expect(() => report('/', 'internal', 'm')).not.toThrow();
  });
});

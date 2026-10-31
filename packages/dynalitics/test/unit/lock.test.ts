import { describe, expect, test, vi } from 'vitest';
import { createLock, type LockOptions, type Next } from '../../src/read/lock/index.js';
import { computeGrant, gate } from '../../src/read/lock/gate.js';
import { normalizeAuth } from '../../src/read/lock/authorize.js';
import {
  CANONICAL_PATH,
  isValidBasePath,
  normalizeBasePath,
} from '../../src/read/lock/base-path.js';
import { csp, htmlResponse } from '../../src/read/lock/serve-html.js';
import type { Authorize, DynaliticsRequest, ReadOutcome } from '../../src/read/types.js';

// The lock layer on its own: no database, no service, no driver. `next` stands for the database side and the point of
// most tests here is that it is NOT called (docs/SPEC.md 15.1: run is only called after a strict authorize success).

const request = (over: Partial<DynaliticsRequest> = {}): DynaliticsRequest => ({
  method: 'GET',
  path: '/api/meta',
  query: {},
  headers: { cookie: 'session=secret' },
  raw: { marker: 'raw' },
  ...over,
});
const okOutcome: ReadOutcome = { kind: 'ok', body: { success: true, data: { hello: 1 } } };

function setup(over: Partial<LockOptions> = {}, nextImpl?: Next) {
  const next = vi.fn<Next>(nextImpl ?? (() => Promise.resolve(okOutcome)));
  const report = vi.fn();
  const lock = createLock(
    {
      authorize: () => true,
      basePath: '/',
      dashboardHtml: undefined,
      reveal: false,
      authorizeTimeoutMs: 5000,
      ...over,
    },
    report,
  );
  return { lock, next, report };
}
const status = async (
  s: ReturnType<typeof setup>,
  r: DynaliticsRequest = request(),
): Promise<number> => (await s.lock.handle(r, s.next)).status;

describe('authorize gate (F-01): the database side is reached only after a strict allow', () => {
  const REFUSED_WITH_REPORT: readonly (readonly [string, unknown])[] = [
    ['1', 1],
    ["'yes'", 'yes'],
    ["'true'", 'true'],
    ['undefined', undefined],
    ['null', null],
    ['{}', {}],
    ['an array', [true]],
    ["{ allowed: 'yes' }", { allowed: 'yes' }],
    ['{ allowed: 1 }', { allowed: 1 }],
    ['a function', () => true],
  ];
  test.each(REFUSED_WITH_REPORT)(
    'a malformed result (%s) is 403, reported as authorize_invalid_result, and next is never called',
    async (_name, value) => {
      const s = setup({ authorize: (() => value) as unknown as Authorize });
      expect(await status(s)).toBe(403);
      expect(s.next).not.toHaveBeenCalled();
      expect(s.report).toHaveBeenCalledTimes(1);
      expect(s.report.mock.calls[0]?.[1]).toBe('authorize_invalid_result');
    },
  );
  test('false and { allowed: false } are 403 without a report; next is never called', async () => {
    for (const result of [false, { allowed: false }, { allowed: false, revealPii: true }]) {
      const s = setup({ authorize: () => result });
      expect(await status(s)).toBe(403);
      expect(s.next).not.toHaveBeenCalled();
      expect(s.report).not.toHaveBeenCalled();
    }
  });
  test('a throw, a rejection and a hang are 500 (never 200), reported, and next is never called', async () => {
    const cases: Authorize[] = [
      () => {
        throw new Error('boom');
      },
      () => Promise.reject(new Error('nope')),
      () => new Promise<never>(() => undefined),
    ];
    for (const authorize of cases) {
      const s = setup({ authorize, authorizeTimeoutMs: 100 });
      expect(await status(s)).toBe(500);
      expect(s.next).not.toHaveBeenCalled();
      expect(s.report.mock.calls[0]?.[1]).toBe('internal');
    }
  });
  test('authorize runs first, for every method and path, including unknown and malformed ones', async () => {
    const authorize = vi.fn(() => false);
    const s = setup({ authorize });
    const probes: Partial<DynaliticsRequest>[] = [
      { method: 'POST' },
      { method: 'DELETE', path: '/api/top-pages' },
      { path: '/' },
      { path: '/nope' },
      { path: '//evil' },
      { path: '/api/../meta' },
      { path: '/api/meta/' },
      { path: '/%2e%2e' },
    ];
    for (const p of probes) expect(await status(s, request(p))).toBe(403);
    expect(authorize).toHaveBeenCalledTimes(probes.length);
    expect(s.next).not.toHaveBeenCalled();
  });
  test('authorize receives the request as the host sent it (raw included)', async () => {
    const seen: DynaliticsRequest[] = [];
    const s = setup({
      authorize: (r) => {
        seen.push(r);
        return true;
      },
    });
    const r = request();
    await status(s, r);
    expect(seen[0]?.raw).toBe(r.raw);
    expect(seen[0]?.headers).toBe(r.headers);
  });
  test('normalizeAuth is strict: only true or a plain object with boolean allowed', () => {
    expect(normalizeAuth(true)).toEqual({ allowed: true, revealPii: false, invalid: false });
    expect(normalizeAuth({ allowed: true, revealPii: true })).toMatchObject({ revealPii: true });
    expect(normalizeAuth({ allowed: true, revealPii: 'yes' })).toMatchObject({ revealPii: false });
    expect(normalizeAuth({ allowed: false, revealPii: true })).toMatchObject({ revealPii: false });
    expect(normalizeAuth(1)).toMatchObject({ allowed: false, invalid: true });
  });
});

describe('after an allow: method, canonical path, then the route (F-17)', () => {
  test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])(
    '%s is 405 with Allow: GET and next is never called',
    async (method) => {
      const s = setup();
      const res = await s.lock.handle(request({ method }), s.next);
      expect(res.status).toBe(405);
      expect(res.headers['Allow']).toBe('GET');
      expect(s.next).not.toHaveBeenCalled();
    },
  );
  test.each([
    '//api/meta',
    '/api//meta',
    '/api/../api/meta',
    '/api/./meta',
    '/api/meta/',
    '/api/meta;x=1',
    '/api/%6deta',
    '/api/meta?x',
    '',
    'api/meta',
    '/api/me ta',
    '/‮api/meta',
  ])('the non-canonical path %j is 404 and next is never called', async (path) => {
    const s = setup();
    expect(await status(s, request({ path }))).toBe(404);
    expect(s.next).not.toHaveBeenCalled();
  });
  test('method is checked before the path', async () => {
    const s = setup();
    expect(await status(s, request({ method: 'POST', path: '//x' }))).toBe(405);
  });
  test('a canonical GET route calls next exactly once, with only the route and a grant', async () => {
    const s = setup();
    const res = await s.lock.handle(request({ path: '/api/top-pages' }), s.next);
    expect(res.status).toBe(200);
    expect(s.next).toHaveBeenCalledTimes(1);
    const args = s.next.mock.calls[0] ?? [];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('/api/top-pages');
    expect(Object.keys(args[1] ?? {}).sort()).toEqual(['reveal', 'revealable']);
  });
  test('CANONICAL_PATH accepts only the root and plain segments', () => {
    for (const ok of ['/', '/api', '/api/meta', '/api/new-vs-returning', '/a_b-c']) {
      expect(CANONICAL_PATH.test(ok)).toBe(true);
    }
    for (const bad of ['', '//', '/a//b', '/a/', '/a/.', '/a%20b', '/a;b', '/a?b', '/a b']) {
      expect(CANONICAL_PATH.test(bad)).toBe(false);
    }
  });
});

describe('what the lock does with the database side answer', () => {
  test('ok becomes HTTP 200 JSON with the security headers and no CORS or cookie headers', async () => {
    const s = setup();
    const res = await s.lock.handle(request(), s.next);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, data: { hello: 1 } });
    expect(res.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Type': 'application/json; charset=utf-8',
    });
    const names = Object.keys(res.headers).map((h) => h.toLowerCase());
    expect(names.filter((h) => h.startsWith('access-control') || h === 'set-cookie')).toEqual([]);
  });
  test('an error outcome keeps its code and its param, with the fixed message', async () => {
    const s = setup({}, () =>
      Promise.resolve({ kind: 'error', code: 'invalid_parameter', param: 'from' }),
    );
    const res = await s.lock.handle(request(), s.next);
    expect(res.status).toBe(400);
    expect((JSON.parse(res.body) as { error: unknown }).error).toMatchObject({
      code: 'invalid_parameter',
      param: 'from',
    });
  });
  test.each([
    ['timeout', 504],
    ['unavailable', 503],
    ['internal', 500],
    ['not_found', 404],
    ['range_too_large', 400],
  ] as const)('error code %s maps to HTTP %i', async (code, expected) => {
    const s = setup({}, () => Promise.resolve({ kind: 'error', code }));
    expect(await status(s)).toBe(expected);
  });
  test('if the database side throws anyway the request fails closed: 500 and a report, no detail', async () => {
    const s = setup({}, () => Promise.reject(new Error('SELECT secret FROM events')));
    const res = await s.lock.handle(request(), s.next);
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('SELECT');
    expect(s.report.mock.calls[0]?.[1]).toBe('internal');
  });
});

describe('reveal conditions (G6): all three, computed once', () => {
  const combos = [false, true].flatMap((option) =>
    [false, true].flatMap((authorized) =>
      [false, true].map((asked) => [option, authorized, asked] as const),
    ),
  );
  test.each(combos)(
    'option=%s authorize.revealPii=%s ?pii=reveal=%s',
    async (option, authorized, asked) => {
      const s = setup({
        reveal: option,
        authorize: () => ({ allowed: true, revealPii: authorized }),
      });
      await s.lock.handle(request({ query: asked ? { pii: 'reveal' } : {} }), s.next);
      const grant = s.next.mock.calls[0]?.[1];
      expect(grant).toEqual({
        revealable: option && authorized,
        reveal: option && authorized && asked,
      });
    },
  );
  test.each([['REVEAL'], ['reveal '], ['1'], [['reveal', 'reveal']], [['reveal']]] as const)(
    '?pii=%j does not reveal (the service answers 400 for it)',
    (value) => {
      const grant = computeGrant(
        { allowed: true, revealPii: true, invalid: false },
        { pii: value },
        { revealOption: true },
      );
      expect(grant.reveal).toBe(false);
      expect(grant.revealable).toBe(true);
    },
  );
  test('a plain `true` can never reveal, whatever the option and the query say', async () => {
    const s = setup({ reveal: true, authorize: () => true });
    await s.lock.handle(request({ query: { pii: 'reveal' } }), s.next);
    expect(s.next.mock.calls[0]?.[1]).toEqual({ revealable: false, reveal: false });
  });
});

describe('basePath (F-07, F-17)', () => {
  test('the root normalises to the empty string, never "/" (so the page cannot build //api/meta)', () => {
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('/admin')).toBe('/admin');
    expect(normalizeBasePath('/admin/')).toBe('/admin');
    expect(normalizeBasePath('/a/b/')).toBe('/a/b');
  });
  test('only slash-separated plain segments are valid base paths', () => {
    for (const ok of ['/', '/admin', '/admin/', '/a/b-c_d']) expect(isValidBasePath(ok)).toBe(true);
    for (const bad of [
      '',
      '//',
      '//evil.example',
      '/a//b',
      '/a/./b',
      '/a?x',
      '/a b',
      'admin',
      '/%2f',
    ])
      expect(isValidBasePath(bad)).toBe(false);
  });
  test('the lock reports the normalised base path', () => {
    expect(setup({ basePath: '/' }).lock.basePath).toBe('');
    expect(setup({ basePath: '/admin/' }).lock.basePath).toBe('/admin');
  });
});

describe('serving the page (G12)', () => {
  const html =
    '<meta content="%%DYNALITICS_BASE%%"><script nonce="%%DYNALITICS_NONCE%%"></script>%%DYNALITICS_NONCE%%';
  test('GET / is the page with a fresh nonce, the strict CSP, and the normalised base; next is not called', async () => {
    const s = setup({ dashboardHtml: html, basePath: '/admin/' });
    const a = await s.lock.handle(request({ path: '/' }), s.next);
    const b = await s.lock.handle(request({ path: '/' }), s.next);
    const nonce = (r: { body: string }) => /nonce="([^"]+)"/.exec(r.body)?.[1] ?? '';
    expect(a.status).toBe(200);
    expect(a.body).toContain('content="/admin"');
    expect(nonce(a)).toMatch(/^[\w-]{22}$/);
    expect(nonce(a)).not.toBe(nonce(b));
    expect(a.body.split(nonce(a)).length).toBe(3); // both placeholders replaced, none left over
    expect(a.body).not.toContain('%%DYNALITICS');
    expect(a.headers['Content-Security-Policy']).toBe(csp(nonce(a)));
    expect(a.headers).toMatchObject({ 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    expect(s.next).not.toHaveBeenCalled();
  });
  test('the root mount puts an empty base in the page', async () => {
    const s = setup({ dashboardHtml: html, basePath: '/' });
    expect((await s.lock.handle(request({ path: '/' }), s.next)).body).toContain('content=""');
  });
  test('without a dashboard GET / is 404, and still only after authorize', async () => {
    const s = setup();
    expect(await status(s, request({ path: '/' }))).toBe(404);
    const denied = setup({ authorize: () => false });
    expect(await status(denied, request({ path: '/' }))).toBe(403);
  });
  test('the CSP is exactly the strict one: nothing allowed but the nonce, self and data images', () => {
    const policy = csp('N');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'nonce-N'");
    expect(policy).toContain("style-src 'nonce-N'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toMatch(/unsafe-|\*/);
    expect(htmlResponse('x', '', 'N').headers['Content-Security-Policy']).toBe(policy);
  });
});

describe('gate() as a pure function', () => {
  const allowed = { allowed: true, revealPii: false, invalid: false };
  test('decisions in order: 405, 404, page, run', () => {
    const cfg = { revealOption: false };
    expect(gate(request({ method: 'POST' }), allowed, cfg)).toEqual({
      kind: 'refuse',
      code: 'method_not_allowed',
    });
    expect(gate(request({ path: '//x' }), allowed, cfg)).toEqual({
      kind: 'refuse',
      code: 'not_found',
    });
    expect(gate(request({ path: '/' }), allowed, cfg)).toEqual({ kind: 'page' });
    expect(gate(request({ path: '/api/meta' }), allowed, cfg)).toMatchObject({
      kind: 'run',
      route: '/api/meta',
    });
  });
});

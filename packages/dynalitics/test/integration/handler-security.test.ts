/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- these tests inspect untyped JSON replies from a real HTTP server on purpose */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { createHandler, toFetchHandler, toNodeListener } from '../../src/read/index.js';
import type { Logger } from '../../src/logger.js';
import type { ReadErrorInfo } from '../../src/read/handler.js';
import type { Dynalitics, ErrorInfo } from '../../src/types.js';
import { ADAPTERS, ENABLED, setupFixture, type Fixture } from './support.js';

const customFields = {
  plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
  campaign: { type: 'string', maxLength: 64 },
} as const;
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const BASE = '/admin/analytics';
const HTML =
  '<!doctype html><meta name="dynalitics-base" content="%%DYNALITICS_BASE%%"><style nonce="%%DYNALITICS_NONCE%%"></style>';
const XSS = '<img src=x onerror=alert(1)>';
const CANARY_EMAIL = 'jane.canary@example.com';
const CANARY_IP = '203.0.113.77';

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: Record<string, any>;
}

describe.each(ENABLED)('read handler over real HTTP against a real database: %s', (dialect) => {
  let fx: Fixture;
  let server: Server;
  let port = 0;
  let dyn: Dynalitics;
  let nodeless: ReturnType<typeof toFetchHandler>;
  const errors: (ErrorInfo | ReadErrorInfo)[] = []; // tracker errors and (since F-40) the handler's own payload
  const authorizeCalls: string[] = [];

  // The test chooses the authorize() outcome per request with a header, so one server covers every case.
  const authorize = (req: { headers: Record<string, unknown>; path: string }): unknown => {
    authorizeCalls.push(req.path);
    switch (req.headers['x-auth']) {
      case 'allow':
        return true;
      case 'reveal':
        return { allowed: true, revealPii: true };
      case 'deny':
        return false;
      case 'string':
        return 'yes';
      case 'one':
        return 1;
      case 'object':
        return {};
      case 'allowed-string':
        return { allowed: 'true' };
      case 'reveal-string':
        return { allowed: true, revealPii: 'false' };
      case 'throw':
        throw new Error('boom');
      case 'hang':
        return new Promise(() => undefined);
      default:
        return undefined;
    }
  };

  const call = (
    path: string,
    opts: { method?: string; headers?: Record<string, string>; auth?: string } = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: opts.method ?? 'GET',
          headers: { ...(opts.auth === undefined ? {} : { 'x-auth': opts.auth }), ...opts.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            let parsed: Record<string, any> = {};
            try {
              parsed = JSON.parse(body) as Record<string, any>;
            } catch {
              // HTML or empty
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
              body,
              json: parsed,
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  const api = (p: string, auth = 'allow', headers?: Record<string, string>) =>
    call(`${BASE}${p}`, { auth, ...(headers === undefined ? {} : { headers }) });

  beforeAll(async () => {
    fx = await setupFixture(dialect, { customFields });
    dyn = await createDynalitics({
      adapter: ADAPTERS[dialect],
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      customFields,
      ip: { mode: 'raw' },
      logger: silent,
      onError: (e) => void errors.push(e),
    });
    // 5 visits: u_1 twice and u_2 (consented, identified), two declined. Hostile strings on purpose.
    await dyn.track({
      pageVisited: '/pricing',
      consent: true,
      userId: 'u_1',
      ip: CANARY_IP,
      username: 'jane',
      email: CANARY_EMAIL,
      custom: { plan: 'pro', campaign: 'secret-campaign' },
    });
    await dyn.track({
      pageVisited: '/pricing',
      consent: true,
      userId: 'u_1',
      ip: CANARY_IP,
      username: 'jane',
      email: CANARY_EMAIL,
      custom: { plan: 'pro' },
    });
    await dyn.track({
      pageVisited: `/${XSS}`,
      consent: true,
      userId: 'jane@corp.example',
      ip: '198.51.100.5',
      username: XSS,
      email: 'bob@example.com',
    });
    await dyn.track({
      pageVisited: '/pricing',
      consent: false,
      userId: 'u_9',
      ip: '192.0.2.9',
      email: 'nope@example.com',
      custom: { plan: 'free', campaign: 'x' },
    });
    await dyn.track({ pageVisited: '/', consent: false, ip: '192.0.2.10' });
    await dyn.flush();

    const handler = createHandler(dyn, {
      authorize: authorize as never,
      basePath: BASE,
      dashboardHtml: HTML,
      pii: { reveal: true },
      authorizeTimeoutMs: 200,
      onError: (e) => void errors.push(e),
    });
    nodeless = toFetchHandler(handler);
    server = createServer(toNodeListener(handler));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await dyn?.close();
    await fx.cleanup();
  });

  describe('authorize is the lock', () => {
    test('createHandler refuses to exist without a function authorize or without a reader credential', async () => {
      expect(() => createHandler(dyn, {} as never)).toThrow();
      expect(() => createHandler(dyn, { authorize: 'yes' as never })).toThrow();
      const writerOnly = await createDynalitics({
        adapter: ADAPTERS[dialect],
        connection: { writer: { connectionString: fx.writerUrl } },
        table: fx.table,
        customFields,
        logger: silent,
      });
      try {
        expect(() => createHandler(writerOnly, { authorize: () => true })).toThrow(/reader/i);
      } finally {
        await writerOnly.close();
      }
    });

    test.each([
      ['deny', 403],
      ['string', 403],
      ['one', 403],
      ['object', 403],
      ['allowed-string', 403],
      ['none', 403],
    ])('authorize result %s is refused with %i and no data', async (mode, status) => {
      const r = await api('/api/visits-over-time', mode);
      expect(r.status).toBe(status);
      expect(r.json['data']).toBeNull();
      expect(r.body).not.toContain('/pricing');
    });

    test('authorize throwing or never settling fails closed with 500 (never 200)', async () => {
      expect((await api('/api/meta', 'throw')).status).toBe(500);
      const started = Date.now();
      expect((await api('/api/meta', 'hang')).status).toBe(500);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    test('authorize runs first for every request, including unknown paths, bad methods and bad parameters', async () => {
      authorizeCalls.length = 0;
      const unknown = await api('/api/does-not-exist', 'deny');
      const badMethod = await call(`${BASE}/api/meta`, { method: 'POST', auth: 'deny' });
      const badParam = await api('/api/top-pages?limit=abc', 'deny');
      for (const r of [unknown, badMethod, badParam]) {
        expect(r.status).toBe(403); // a caller who may not enter learns nothing about routes
        expect(r.json['error']['code']).toBe('forbidden');
      }
      expect(authorizeCalls).toHaveLength(3);
    });

    test('allowed callers get 404 for unknown routes and 405 + Allow: GET for other methods', async () => {
      expect((await api('/api/does-not-exist')).status).toBe(404);
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
        const r = await call(`${BASE}/api/meta`, { method, auth: 'allow' });
        expect(r.status, method).toBe(405);
        expect(r.headers['allow']).toBe('GET');
      }
    });

    test('method-override headers and parameters cannot turn a GET into something else or skip the lock', async () => {
      const r = await api('/api/meta', 'deny', { 'x-http-method-override': 'GET' });
      expect(r.status).toBe(403);
      const q = await api('/api/meta?_method=POST');
      expect(q.status).toBe(400); // unknown parameter
    });

    test.each([
      '/admin/analytics//api/meta',
      '/admin/analytics/api/meta/',
      '/admin/analytics/API/meta',
      '/admin/analytics/api/%2e%2e/meta',
      '/admin/analytics/api/meta%00',
      '/admin/analytics/api%2Fmeta',
      '/admin/analyticsX/api/meta',
    ])(
      'path trick %s never reaches data without authorization and never returns data as 200 when unknown',
      async (p) => {
        const denied = await call(p, { auth: 'deny' });
        expect(denied.status).toBe(403);
        const allowed = await call(p, { auth: 'allow' });
        expect([404, 400, 403]).toContain(allowed.status);
        expect(allowed.json['data'] ?? null).toBeNull();
      },
    );

    test('a path WITHOUT the basePath prefix is answered (Express strips its mount path), but only behind authorize', async () => {
      // Documents current behaviour (QA-REVIEW-1 F-17): the adapter cannot tell "Express already stripped the
      // mount" from "request outside the mount", so /api/meta works on a bare server. The lock still holds.
      expect((await call('/api/meta', { auth: 'deny' })).status).toBe(403);
      expect((await call('/api/meta', { auth: 'string' })).status).toBe(403);
      expect((await call('/api/meta', { auth: 'allow' })).status).toBe(200);
    });

    test('no CORS headers ever, and a cross-origin Origin header changes nothing', async () => {
      const ok = await api('/api/meta', 'allow', { origin: 'https://evil.example' });
      const no = await api('/api/meta', 'deny', { origin: 'https://evil.example' });
      const pre = await call(`${BASE}/api/meta`, {
        method: 'OPTIONS',
        auth: 'allow',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
      });
      for (const r of [ok, no, pre]) {
        expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      }
      expect(no.status).toBe(403);
    });

    test('every response (success, error, 403) is no-store, nosniff and no-referrer', async () => {
      for (const r of [
        await api('/api/meta'),
        await api('/api/meta', 'deny'),
        await api('/nope'),
        await api('/api/top-pages?limit=zzz'),
        await call(`${BASE}/api/meta`, { method: 'POST', auth: 'allow' }),
      ]) {
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['x-content-type-options']).toBe('nosniff');
        expect(r.headers['referrer-policy']).toBe('no-referrer');
      }
    });

    test('Fetch adapter enforces the same lock (Next.js route handler path)', async () => {
      const mk = (auth: string) =>
        new Request(`http://localhost${BASE}/api/recent-visits`, { headers: { 'x-auth': auth } });
      expect((await nodeless(mk('deny'))).status).toBe(403);
      expect((await nodeless(mk('string'))).status).toBe(403);
      expect((await nodeless(mk('allow'))).status).toBe(200);
    });
  });

  describe('strict parameters and injection', () => {
    test.each([
      '/api/visits-over-time?from=2020-01-01&from=2020-01-02',
      '/api/visits-over-time?interval=minute',
      "/api/visits-over-time?interval=day'%20OR%201=1--",
      '/api/visits-over-time?breakdown=email',
      '/api/visits-over-time?breakdown=ip',
      '/api/visits-over-time?breakdown=custom',
      "/api/visits-over-time?breakdown=plan'%20OR%20'1'='1",
      '/api/visits-over-time?breakdown[]=plan',
      '/api/visits-over-time?__proto__=x',
      '/api/visits-over-time?constructor=x',
      '/api/top-pages?limit=0',
      '/api/top-pages?limit=-1',
      '/api/top-pages?limit=1e3',
      '/api/top-pages?limit=99999999999999999999',
      '/api/top-pages?limit=10;DROP%20TABLE%20x',
      '/api/top-pages?sort=visits',
      '/api/top-pages?orderBy=page',
      '/api/top-pages?where=1=1',
      '/api/recent-visits?cursor=%27%3B%20DROP%20TABLE%20x%3B--',
      '/api/recent-visits?cursor=AAAA',
      '/api/recent-visits?pii=true',
      '/api/consent-rate?pii=reveal',
      '/api/visits-over-time?from=not-a-date',
      '/api/visits-over-time?from=2026-02-30',
      `/api/visits-over-time?x=${'a'.repeat(2100)}`,
    ])('%s is a 400 and never reaches the database', async (p) => {
      const r = await api(p);
      expect(r.status).toBe(400);
      expect(r.json['error']['code']).toMatch(/invalid_parameter|range_too_large/);
    });

    test('range, bucket and size caps are enforced', async () => {
      const wide = await api('/api/visits-over-time?from=2000-01-01&to=2026-01-01');
      expect(wide.status).toBe(400);
      expect(wide.json['error']['code']).toBe('range_too_large');
      const buckets = await api(
        '/api/visits-over-time?from=2026-01-01&to=2026-03-01&interval=hour',
      );
      expect(buckets.status).toBe(400);
      const nvr = await api('/api/new-vs-returning?from=2026-01-01&to=2026-04-01');
      expect(nvr.status).toBe(400);
      expect((await api('/api/top-pages?limit=101')).status).toBe(400);
      expect((await api('/api/recent-visits?limit=101')).status).toBe(400);
      expect((await api('/api/visits-over-time?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    });

    test('errors never contain SQL, table names, driver text or the connection string', async () => {
      const texts = [
        (await api('/api/top-pages?limit=zzz')).body,
        (await api('/api/nope')).body,
        (await api('/api/meta', 'deny')).body,
        (await api('/api/meta', 'throw')).body,
      ].join('\n');
      expect(texts).not.toContain(fx.bareTable);
      expect(texts).not.toMatch(/SELECT|INSERT|127\.0\.0\.1|postgres:|mysql:/i);
    });
  });

  describe('data is correct and the table survives', () => {
    test('aggregates match what was tracked (5 visits, 3 consented)', async () => {
      const v = await api('/api/visits-over-time');
      expect(v.status).toBe(200);
      expect(v.json['data']['total']).toBe(5);
      const sum = (v.json['data']['points'] as { visits: number }[]).reduce(
        (a, p) => a + p.visits,
        0,
      );
      expect(sum).toBe(5);
      const c = await api('/api/consent-rate');
      expect(c.json['data']['totals']).toMatchObject({ granted: 3, denied: 2 });
      expect(c.json['data']['totals']['rate']).toBeCloseTo(0.6, 3);
      const t = await api('/api/top-pages');
      expect(t.json['data']['totalVisits']).toBe(5);
      expect(t.json['data']['pages'][0]).toMatchObject({ page: '/pricing', visits: 3 });
    });

    test('new + returning + unknown equals the visits total, with the expected split', async () => {
      const n = await api('/api/new-vs-returning');
      expect(n.status).toBe(200);
      expect(n.json['data']['totals']).toEqual({ new: 2, returning: 1, unknown: 2 });
      expect(n.json['data']['source']).toBe('computed');
      expect(n.json['data']['approximate']).toBe(true); // ip is part of the identity (ip.mode raw)
    });

    test('breakdown allows only declared non-personal fields and never leaks the personal one', async () => {
      const ok = await api('/api/visits-over-time?breakdown=plan');
      expect(ok.status).toBe(200);
      expect(ok.body).not.toContain('secret-campaign');
      expect((await api('/api/visits-over-time?breakdown=campaign')).status).toBe(400);
      const meta = await api('/api/meta');
      expect(meta.json['data']['breakdowns'].map((b: { key: string }) => b.key)).toEqual(
        expect.arrayContaining(['consent', 'plan']),
      );
      expect(JSON.stringify(meta.json['data']['breakdowns'])).not.toContain('campaign');
      expect(meta.body).not.toContain(fx.bareTable);
    });

    test('the table and its rows are untouched after the whole hostile corpus', async () => {
      expect((await fx.rows()).length).toBe(5);
    });
  });

  describe('PII masking', () => {
    const visits = async (auth: string, qs = '') =>
      (await api(`/api/recent-visits?limit=50${qs}`, auth)).json;

    test('masked by default: no canary email, ip, full username, or personal custom value anywhere in the body', async () => {
      const r = await api('/api/recent-visits?limit=50');
      expect(r.status).toBe(200);
      expect(r.json['meta']['piiMasked']).toBe(true);
      for (const secret of [
        CANARY_EMAIL,
        CANARY_IP,
        '198.51.100.5',
        'bob@example.com',
        'secret-campaign',
        'jane@corp.example',
      ]) {
        expect(r.body, secret).not.toContain(secret);
      }
      const rows = r.json['data']['visits'] as Record<string, any>[];
      // userId is masked by default too (F-06), so the row is found by its other masked values
      const first = rows.find(
        (x) => x['email'] === 'j***@example.com' && x['ipAddress'] === '203.0.x.x',
      )!;
      expect(first['ipAddress']).toBe('203.0.x.x');
      expect(first['email']).toBe('j***@example.com');
      expect(first['username']).toBe('j***');
      expect(first['custom']).toMatchObject({ plan: 'pro' });
      expect(JSON.stringify(rows)).toContain('"campaign":"***"');
    });

    test('a userId that is an email address is masked too (QA-REVIEW-1 F-06)', async () => {
      const rows = (await visits('allow')).data.visits as Record<string, any>[];
      expect(rows.map((x) => x['userId'])).not.toContain('jane@corp.example');
      expect(rows.some((x) => x['userId'] === 'j***@corp.example')).toBe(true);
    });

    test('declined rows carry no personal data at all, masked or revealed', async () => {
      for (const auth of ['allow', 'reveal']) {
        const rows = (await visits(auth, '&pii=reveal')).data.visits as Record<string, any>[];
        const denied = rows.filter((x) => x['consent'] === false);
        expect(denied).toHaveLength(2);
        for (const d of denied) {
          expect(d).toMatchObject({
            ipAddress: null,
            userId: null,
            username: null,
            email: null,
            isFirstVisit: null,
          });
        }
      }
    });

    test('hostile visitor strings come back as JSON text, never as markup, and the content type is JSON', async () => {
      const r = await call(`${BASE}/api/recent-visits?limit=50&pii=reveal`, { auth: 'reveal' });
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      const rows = r.json['data']['visits'] as Record<string, any>[];
      expect(rows.some((x) => x['pageVisited'] === `/${XSS}`)).toBe(true);
      expect(rows.some((x) => x['username'] === XSS)).toBe(true);
    });

    test('reveal needs ALL THREE: config, authorize revealPii === true, and ?pii=reveal', async () => {
      const full = await api('/api/recent-visits?limit=50&pii=reveal', 'reveal');
      expect(full.json['meta']['piiMasked']).toBe(false);
      expect(full.body).toContain(CANARY_EMAIL);
      expect(full.body).toContain(CANARY_IP);

      const noQuery = await api('/api/recent-visits?limit=50', 'reveal');
      const noAuthFlag = await api('/api/recent-visits?limit=50&pii=reveal', 'allow');
      const truthyFlag = await api('/api/recent-visits?limit=50&pii=reveal', 'reveal-string');
      for (const r of [noQuery, noAuthFlag, truthyFlag]) {
        expect(r.status).toBe(200); // masked, not an error
        expect(r.json['meta']['piiMasked']).toBe(true);
        expect(r.body).not.toContain(CANARY_EMAIL);
        expect(r.body).not.toContain(CANARY_IP);
      }
      const meta = await api('/api/meta', 'allow');
      expect(meta.json['data']['features']['piiRevealable']).toBe(false);
      expect((await api('/api/meta', 'reveal')).json['data']['features']['piiRevealable']).toBe(
        true,
      );
    });

    test('with pii.reveal disabled in config, revealPii from authorize is ignored', async () => {
      const h = toFetchHandler(
        createHandler(dyn, {
          authorize: () => ({ allowed: true, revealPii: true }),
          basePath: BASE,
        }),
      );
      const res = await h(new Request(`http://x${BASE}/api/recent-visits?pii=reveal&limit=50`));
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).not.toContain(CANARY_EMAIL);
      expect(JSON.parse(body).meta.piiMasked).toBe(true);
    });

    test('paging: a cursor walks every row exactly once, newest first, and never leaks past the mask', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const qs: string = `limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const r = await api(`/api/recent-visits?${qs}`);
        expect(r.status).toBe(200);
        for (const v of r.json['data']['visits']) seen.push(v['id'] as string);
        cursor = r.json['data']['nextCursor'] as string | null;
        if (cursor === null) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      const ids = seen.map((s) => BigInt(s));
      expect([...ids].sort((a, b) => (a < b ? 1 : -1))).toEqual(ids);
    });
  });

  describe('dashboard page', () => {
    test('is behind authorize, has a fresh nonce per request, a strict CSP and the right base', async () => {
      expect((await call(`${BASE}/`, { auth: 'deny' })).status).toBe(403);
      const a = await call(`${BASE}/`, { auth: 'allow' });
      const b = await call(`${BASE}/`, { auth: 'allow' });
      expect(a.status).toBe(200);
      expect(a.headers['content-type']).toMatch(/^text\/html/);
      const nonce = (h: Reply) =>
        /nonce-([A-Za-z0-9_-]+)/.exec(h.headers['content-security-policy'] ?? '')?.[1];
      expect(nonce(a)).toBeTruthy();
      expect(nonce(a)).not.toBe(nonce(b));
      expect(a.body).toContain(`nonce="${nonce(a)}"`);
      expect(a.body).toContain(`content="${BASE}"`);
      const csp = a.headers['content-security-policy']!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(a.headers['x-frame-options']).toBe('DENY');
      expect(a.headers['cache-control']).toBe('no-store');
    });

    test('mounted at the root, the client base is empty so the dashboard never requests //api/meta (QA-REVIEW-1 F-07)', async () => {
      const h = toFetchHandler(createHandler(dyn, { authorize: () => true, dashboardHtml: HTML }));
      const res = await h(new Request('http://x/'));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="dynalitics-base" content=""');
    });

    test.each(['//evil.example', '/a//b', 'admin', '/a b', '/<x>'])(
      'basePath %j is refused at creation',
      (basePath) => {
        expect(() =>
          createHandler(dyn, { authorize: () => true, scope: 'none', basePath }),
        ).toThrow();
      },
    );

    test('basePath "/admin/" is accepted and normalised to "/admin" (decision on F-07)', () => {
      expect(
        createHandler(dyn, { authorize: () => true, scope: 'none', basePath: '/admin/' }).basePath,
      ).toBe('/admin');
    });
  });
});

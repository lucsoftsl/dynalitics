import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { toFetchHandler, toNodeListener } from '../../src/read/adapters.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsRequest } from '../../src/read/types.js';
import { readFixture } from '../helpers/read-fixture.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function build(options: Record<string, unknown> = {}) {
  const seen: DynaliticsRequest[] = [];
  const f = readFixture({ top: [{ page: '/a', n: 1 }], topTotal: [{ n: 1 }] });
  const handler = createHandler(f.dyn, {
    authorize: (r: DynaliticsRequest) => (seen.push(r), true),
    ...options,
  });
  return { handler, seen, f };
}
async function listen(listener: (req: IncomingMessage, res: never) => void): Promise<string> {
  const server = createServer(listener as never);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('toNodeListener', () => {
  test('serves the API over a plain node:http server, passing headers (lower-cased) and the raw request to authorize', async () => {
    const { handler, seen } = build({ basePath: '/admin/analytics' });
    const base = await listen(toNodeListener(handler));
    const res = await fetch(`${base}/admin/analytics/api/top-pages?limit=1`, {
      headers: { Authorization: 'Bearer t', 'X-Custom': 'v' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ success: true, data: { totalVisits: 1 } });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/api/top-pages',
      query: { limit: '1' },
      headers: { authorization: 'Bearer t', 'x-custom': 'v' },
    });
    expect((seen[0]?.raw as IncomingMessage).url).toBe('/admin/analytics/api/top-pages?limit=1');
  });

  test('also works when a framework already stripped its mount path (Express app.use(base, listener))', async () => {
    const { handler, seen } = build({ basePath: '/admin/analytics' });
    const listener = toNodeListener(handler);
    const base = await listen((req, res) => {
      req.url = req.url?.replace('/admin/analytics', '') || '/'; // what Express does for app.use('/admin/analytics', ...)
      listener(req, res);
    });
    expect((await fetch(`${base}/admin/analytics/api/meta`)).status).toBe(200);
    expect(seen[0]?.path).toBe('/api/meta');
  });

  test('repeated parameters arrive as arrays and are rejected; __proto__ is just an unknown parameter', async () => {
    const { handler } = build();
    const base = await listen(toNodeListener(handler));
    expect((await fetch(`${base}/api/consent-rate?interval=day&interval=week`)).status).toBe(400);
    const res = await fetch(`${base}/api/consent-rate?__proto__=x`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid_parameter');
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  test('refusals and 405s are written correctly; nothing leaks when authorize throws', async () => {
    const denied = build({ authorize: () => false });
    const base = await listen(toNodeListener(denied.handler));
    expect((await fetch(`${base}/api/meta`)).status).toBe(403);
    const ok = build();
    const base2 = await listen(toNodeListener(ok.handler));
    const post = await fetch(`${base2}/api/meta`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
    const boom = build({
      authorize: () => {
        throw new Error('secret detail');
      },
    });
    const base3 = await listen(toNodeListener(boom.handler));
    const r = await fetch(`${base3}/api/meta`);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('secret detail');
  });

  test('serves the dashboard page with its CSP header', async () => {
    const { handler } = build({ dashboardHtml: '<script nonce="%%DYNALITICS_NONCE%%"></script>' });
    const base = await listen(toNodeListener(handler));
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('toFetchHandler', () => {
  test('maps a Request to the handler and back, stripping basePath (Next.js route handler style)', async () => {
    const { handler, seen } = build({ basePath: '/admin/analytics' });
    const GET = toFetchHandler(handler);
    const res = await GET(
      new Request('https://example.com/admin/analytics/api/top-pages?limit=1', {
        headers: { Cookie: 'a=b' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(seen[0]).toMatchObject({ path: '/api/top-pages', headers: { cookie: 'a=b' } });
    expect(seen[0]?.raw).toBeInstanceOf(Request);
  });

  test('base path "/" and the root page', async () => {
    const { handler } = build({ dashboardHtml: '<p>%%DYNALITICS_BASE%%</p>' });
    const res = await toFetchHandler(handler)(new Request('https://example.com/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p></p>');
  });

  test('a path that merely starts with the base path is not stripped', async () => {
    const { handler, seen } = build({ basePath: '/admin' });
    await toFetchHandler(handler)(new Request('https://example.com/administrator/api/meta'));
    expect(seen[0]?.path).toBe('/administrator/api/meta');
  });

  test('errors become a generic 500 JSON response', async () => {
    const { handler } = build();
    const GET = toFetchHandler({
      ...handler,
      handle: () => Promise.reject(new Error('internal secret')),
    });
    const res = await GET(new Request('https://example.com/api/meta'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal secret');
  });
});

describe('F-17: the mount path is removed exactly once', () => {
  test('behind Express (req.baseUrl is set) the adapter does not strip a second time', async () => {
    const { handler, seen } = build({ basePath: '/admin/analytics' });
    const listener = toNodeListener(handler);
    const base = await listen((req, res) => {
      // what Express does for app.use('/admin/analytics', listener): sets baseUrl and strips it from url
      (req as unknown as { baseUrl: string }).baseUrl = '/admin/analytics';
      req.url = (req.url ?? '/').replace('/admin/analytics', '') || '/';
      listener(req, res);
    });
    expect((await fetch(`${base}/admin/analytics/api/meta`)).status).toBe(200);
    expect(seen[0]?.path).toBe('/api/meta');
    // a request that repeats the prefix must NOT be routed as /api/meta
    const doubled = await fetch(`${base}/admin/analytics/admin/analytics/api/meta`);
    expect(doubled.status).toBe(404);
    expect(seen[1]?.path).toBe('/admin/analytics/api/meta');
  });

  test('for a Fetch route the prefix is stripped once, so a repeated prefix is a 404', async () => {
    const { handler, seen } = build({ basePath: '/admin/analytics' });
    const GET = toFetchHandler(handler);
    const res = await GET(
      new Request('https://example.com/admin/analytics/admin/analytics/api/meta'),
    );
    expect(res.status).toBe(404);
    expect(seen[0]?.path).toBe('/admin/analytics/api/meta');
  });

  test('the root base path strips nothing; the normalised base path is exposed', async () => {
    const root = build();
    expect(root.handler.basePath).toBe('');
    await toFetchHandler(root.handler)(new Request('https://example.com/api/meta'));
    expect(root.seen[0]?.path).toBe('/api/meta');
    expect(build({ basePath: '/admin/' }).handler.basePath).toBe('/admin');
  });

  test('percent-encoded separators are never decoded into a route', async () => {
    const { handler } = build();
    const base = await listen(toNodeListener(handler));
    for (const path of ['/api%2Fmeta', '/api/%6Deta', '/api/meta%00', '//api/meta']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });
});

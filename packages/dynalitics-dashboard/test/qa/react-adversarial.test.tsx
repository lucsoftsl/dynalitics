// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-redundant-type-constituents -- these tests build deliberately malformed, untyped API replies */
// QA-REVIEW-2: adversarial tests written independently of the component authors.
import { afterEach, describe, expect, test } from 'vitest';
import { DynaliticsDashboard } from '../../src/react/index.js';
import { HOSTILE_PAGES, mockReply, type Scenario } from '../fixtures/api.js';
import { mountReact, settleReact, q, qa, type Mounted } from '../react/render.js';

type Mutate = (path: string, body: any) => any | undefined;
interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that serves the 'ok' fixture, optionally rewriting each reply, and records every call. */
function qaFetch(mutate?: Mutate, scenario: Scenario = 'ok') {
  const calls: Call[] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init });
    const url = new URL(input, 'https://app.test');
    const path = url.pathname.replace(/^.*\/api\//, '');
    const reply = mockReply(scenario, path, url.searchParams);
    const body = (mutate ? mutate(path, reply.body) : undefined) ?? reply.body;
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(
      new Response(reply.text ?? JSON.stringify(body), { status: reply.status }),
    );
  };
  return { fetch, calls };
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
const show = async (props: Record<string, unknown>): Promise<HTMLElement> => {
  mounted = await mountReact(<DynaliticsDashboard {...props} />);
  await settleReact();
  return mounted.container;
};

const INERT =
  'script, iframe, object, embed, img, svg image, link, base, [onerror], [onload], [onclick]';
/** Our own skip link is the only anchor with an href. */
const badAnchors = (root: ParentNode): Element[] =>
  qa(root, 'a[href]').filter((a) => !(a.getAttribute('href') ?? '').startsWith('#'));

describe('endpoint and getRequestInit: a hostile endpoint never receives host headers or credentials', () => {
  const HOSTILE = [
    '//evil',
    '//evil.example',
    '///evil',
    'https://evil.example',
    'http://evil',
    '\\\\evil',
    '/\\evil',
    '/a//b',
    '/a/../b',
    '/..%2f',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    '/a b',
    '/a?x=1',
    '/a#frag',
  ];

  test.each(HOSTILE)(
    'endpoint %j: every request stays on this origin, with a single leading slash',
    async (endpoint) => {
      const { fetch, calls } = qaFetch();
      await show({
        endpoint,
        fetch,
        getRequestInit: () => ({ headers: { Authorization: 'Bearer SECRET' } }),
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.url.startsWith('/'), c.url).toBe(true);
        expect(c.url.startsWith('//'), c.url).toBe(false);
        expect(new URL(c.url, 'https://app.test').origin).toBe('https://app.test');
      }
    },
  );

  test('requests are always GET, redirect manual, no body, and the host cannot override that', async () => {
    const { fetch, calls } = qaFetch();
    await show({
      endpoint: '/admin/analytics',
      fetch,
      getRequestInit: () =>
        ({
          method: 'POST',
          body: 'x',
          redirect: 'follow',
          credentials: 'same-origin',
        }) as RequestInit,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.init?.method).toBe('GET');
      expect(c.init?.redirect).toBe('manual');
      expect(c.init?.body).toBeUndefined();
    }
  });

  test('a host getRequestInit that throws yields "not authorised" and its error text is never rendered', async () => {
    const { fetch, calls } = qaFetch();
    const root = await show({
      endpoint: '/x',
      fetch,
      getRequestInit: () => {
        throw new Error('TOKEN-STORE-PASSWORD=hunter2');
      },
    });
    expect(root.textContent).toContain('NOT AUTHORISED');
    expect(root.textContent).not.toContain('hunter2');
    expect(calls.length).toBe(0); // the wrapper answers 401 itself: no request is ever sent without the host's init
  });

  test('our accept header wins over a host-supplied one', async () => {
    const { fetch, calls } = qaFetch();
    await show({
      endpoint: '/x',
      fetch,
      getRequestInit: () => ({ headers: { accept: 'text/html' } }),
    });
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe('application/json');
  });
});

describe('what the server (or something in front of it) can send back', () => {
  test.each([401, 403])(
    'HTTP %i on /api/meta stops everything: one request, no retry button',
    async (status) => {
      const { fetch, calls } = qaFetch(() => new Response('{}', { status }));
      const root = await show({ endpoint: '/x', fetch });
      expect(root.textContent).toContain('NOT AUTHORISED');
      expect(calls.length).toBe(1);
      expect(qa(root, 'button').map((b) => b.textContent)).not.toContain('Retry');
    },
  );

  test('a redirect (redirected flag) is an UNEXPECTED REPLY and the body is never parsed or shown', async () => {
    const { fetch } = qaFetch(() => {
      const r = new Response(JSON.stringify({ success: true, data: {}, meta: {} }), {
        status: 200,
      });
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    });
    const root = await show({ endpoint: '/x', fetch });
    expect(root.textContent).toContain('UNEXPECTED REPLY');
  });

  test('an opaque redirect (redirect: manual) is an UNEXPECTED REPLY', async () => {
    const { fetch } = qaFetch(() => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
      return r;
    });
    expect((await show({ endpoint: '/x', fetch })).textContent).toContain('UNEXPECTED REPLY');
  });

  test('a 200 HTML login page with a script is never rendered, only reported', async () => {
    const page = '<html><script>window.__pwned=1</script><h1>LOGIN-PAGE-CANARY</h1></html>';
    const { fetch } = qaFetch(
      () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const root = await show({ endpoint: '/x', fetch });
    expect(root.textContent).toContain('UNEXPECTED REPLY');
    expect(root.textContent).not.toContain('LOGIN-PAGE-CANARY');
    expect((globalThis as any).__pwned).toBeUndefined();
    expect(root.querySelectorAll(INERT).length).toBe(0);
  });

  test('a hostile error envelope: server message and param text never reach the DOM as markup or copy', async () => {
    const env = {
      success: false,
      data: null,
      unavailable: null,
      error: {
        code: 'invalid_parameter',
        message: '<img src=x onerror=alert(1)>MSG-CANARY',
        param: '<script>1</script>',
      },
    };
    const { fetch } = qaFetch((path) =>
      path === 'meta' ? undefined : new Response(JSON.stringify(env), { status: 400 }),
    );
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelectorAll(INERT).length).toBe(0);
    expect(root.textContent).not.toContain('MSG-CANARY');
  });

  test('a hostile "unavailable" message is shown as text only', async () => {
    const un = { reason: 'x', message: '<img src=x onerror=alert(1)> UN-CANARY' };
    const { fetch } = qaFetch((path, body) =>
      path === 'new-vs-returning'
        ? new Response(
            JSON.stringify({
              success: true,
              data: null,
              unavailable: un,
              error: null,
              meta: body?.meta ?? { generatedAt: 'x', piiMasked: true, cached: false },
            }),
            { status: 200 },
          )
        : undefined,
    );
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelectorAll(INERT).length).toBe(0);
    expect(badAnchors(root)).toEqual([]);
  });
});

describe('meta with missing or wrong fields never crashes the page or fires other requests', () => {
  const BROKEN: [string, (m: any) => any][] = [
    ['empty object', () => ({})],
    ['no widgets', (m) => ({ ...m, widgets: undefined })],
    ['no fields', (m) => ({ ...m, fields: undefined })],
    ['no limits', (m) => ({ ...m, limits: undefined })],
    ['limits as a string', (m) => ({ ...m, limits: 'x' })],
    ['intervals not an array', (m) => ({ ...m, intervals: 'day' })],
    ['defaults null', (m) => ({ ...m, defaults: null })],
    ['now is garbage', (m) => ({ ...m, now: 'not-a-date' })],
    ['data is an array', () => []],
  ];
  test.each(BROKEN)('meta: %s', async (_name, rewrite) => {
    const { fetch, calls } = qaFetch((path, body) =>
      path === 'meta' ? { ...body, data: rewrite(body.data) } : undefined,
    );
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelector('.dy-root')).not.toBeNull(); // still rendered, no white screen
    expect(root.querySelectorAll(INERT).length).toBe(0);
    expect(root.textContent).toMatch(/UNEXPECTED REPLY|NOT AUTHORISED|ERROR|dynalitics/);
    expect(calls.length).toBeLessThan(12);
  });
});

describe('hostile visitor data in every panel', () => {
  const PAYLOADS = [
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    '</script><script>alert(1)</script>',
    'javascript:alert(1)',
    "'; DROP TABLE x; --",
    '${7*7} {{7*7}} <%= 7*7 %>',
    '‮evil‬ /admin⁦x⁩',
    '\u0000\u0001\uD800',
    '__proto__',
    'constructor',
  ];

  test('page, username, email, userId, ip, custom values and series labels render as inert text', async () => {
    const { fetch } = qaFetch((path, body) => {
      if (path === 'recent-visits') {
        return {
          ...body,
          data: {
            ...body.data,
            visits: PAYLOADS.map((p, i) => ({
              id: String(i + 1),
              timestamp: '2026-10-30T12:01:44.120Z',
              pageVisited: p,
              consent: true,
              isFirstVisit: false,
              ipAddress: p,
              userId: p,
              username: p,
              email: p,
              custom: { plan: p, [p]: p },
            })),
            nextCursor: null,
          },
        };
      }
      if (path === 'top-pages') {
        return {
          ...body,
          data: {
            totalVisits: 10,
            otherVisits: 0,
            pages: PAYLOADS.map((p) => ({ page: p, visits: 1, share: 0.1 })),
          },
        };
      }
      return undefined;
    });
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelectorAll(INERT).length).toBe(0);
    expect(badAnchors(root)).toEqual([]);
    for (const node of qa(root, '*')) {
      for (const a of node.getAttributeNames())
        expect(a.startsWith('on'), `${node.tagName}.${a}`).toBe(false);
    }
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>'); // shown literally, as text
    expect(({} as any).polluted).toBeUndefined();
  });

  test('the shared hostile fixture also renders inert (control)', async () => {
    const { fetch } = qaFetch(undefined, 'hostile');
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelectorAll(INERT).length).toBe(0);
    expect(HOSTILE_PAGES.length).toBeGreaterThan(3);
  });

  test('visitor strings are bidi-isolated (class v) so a right-to-left override cannot reorder neighbours', async () => {
    const rtl = '/admin‮nigol';
    const { fetch } = qaFetch((path, body) =>
      path === 'top-pages'
        ? {
            ...body,
            data: { totalVisits: 1, otherVisits: 0, pages: [{ page: rtl, visits: 1, share: 1 }] },
          }
        : undefined,
    );
    const root = await show({ endpoint: '/x', fetch });
    const holder = qa(root, '.dy-page').find((n) => n.textContent === rtl);
    expect(holder, 'page string must be rendered in its own element').toBeDefined();
    expect(holder!.classList.contains('v') || holder!.getAttribute('dir') === 'auto').toBe(true);
  });
});

describe('prototype-pollution-looking JSON and huge values', () => {
  test('__proto__ / constructor keys anywhere in the JSON do not pollute and do not crash', async () => {
    const text = (path: string, base: any): string => {
      const evil = '"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}';
      return (
        JSON.stringify(base)
          .replace(/^\{/, `{${evil},`)
          .replace(/"data":\{/, `"data":{${evil},`) + (path ? '' : '')
      );
    };
    const { fetch } = qaFetch((path, body) => new Response(text(path, body), { status: 200 }));
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelector('.dy-root')).not.toBeNull();
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).polluted2).toBeUndefined();
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  test('a 1 MB page string, a 20 000 character username and absurd numbers render without throwing, fast', async () => {
    const big = '/' + 'a'.repeat(1_000_000);
    const { fetch } = qaFetch((path, body) => {
      if (path === 'top-pages')
        return {
          ...body,
          data: {
            totalVisits: 1e21,
            otherVisits: -5,
            pages: [{ page: big, visits: 1e21, share: 7 }],
          },
        };
      if (path === 'recent-visits')
        return {
          ...body,
          data: {
            ...body.data,
            visits: [{ ...body.data.visits[0], username: 'u'.repeat(20_000), pageVisited: big }],
            nextCursor: null,
          },
        };
      return undefined;
    });
    const t0 = Date.now();
    const root = await show({ endpoint: '/x', fetch });
    expect(root.querySelector('.dy-root')).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  // KNOWN DEFECT (QA-REVIEW-2 F-03): VisitsOverTime.tsx:79 does `data.points.map((p) => p.bucket)` and throws on a
  // null element; there is no error boundary, so one malformed panel unmounts the whole dashboard.
  // test.fails keeps CI green and starts failing the moment the defect is fixed (then change it to `test`).
  test.fails(
    'wrong types where numbers or strings are expected (null, strings, NaN-like) do not blank the page',
    async () => {
      const { fetch } = qaFetch((path, body) => {
        if (path === 'top-pages')
          return {
            ...body,
            data: {
              totalVisits: 'many',
              otherVisits: null,
              pages: [null, 5, { page: 123, visits: 'x', share: {} }],
            },
          };
        if (path === 'visits-over-time')
          return {
            ...body,
            data: { ...body.data, total: 'x', points: [null, { bucket: 5, visits: 'y' }] },
          };
        return undefined;
      });
      const root = await show({ endpoint: '/x', fetch });
      expect(root.querySelector('.dy-root')).not.toBeNull();
      // the unaffected panels still render
      expect(q(root, '.p-table')).not.toBeNull();
    },
  );
});

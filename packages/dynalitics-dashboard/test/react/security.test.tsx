// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DynaliticsDashboard } from '../../src/react/index.js';
import { HOSTILE_PAGES, mockFetch, makeMeta } from '../fixtures/api.js';
import { click, inAct, mountReact, press, q, qa, settleReact, type Mounted } from './render.js';

const SRC = join(import.meta.dirname, '../../src/react');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('source rules (docs/DESIGN.md section 10)', () => {
  const sources = files(SRC).map(
    (p) => [p.slice(SRC.length + 1), readFileSync(p, 'utf8')] as const,
  );

  test.each([
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    [
      'innerHTML / outerHTML / insertAdjacentHTML / document.write',
      /\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/,
    ],
    [
      'eval / new Function / setTimeout with a string',
      /\beval\s*\(|new Function\s*\(|set(Timeout|Interval)\(\s*['"`]/,
    ],
    [
      'inline event handler strings or setAttribute(on...)',
      /\bon[a-z]+\s*=\s*["'`]|setAttribute\(\s*['"]on/i,
    ],
    ['string-built src', /\bsrc=\{/],
  ])('no %s in src/react', (_name, pattern) => {
    const offenders = sources
      .filter(([, text]) => pattern.test(text.replace(/\/\/.*$/gm, '')))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  test('the only href is the skip link and it points at an id we generate', () => {
    const hrefs = sources.flatMap(([f, t]) =>
      [...t.matchAll(/href=\{?[^\s>]+/g)].map((m) => `${f}: ${m[0]}`),
    );
    expect(hrefs).toEqual(['DynaliticsDashboard.tsx: href={`#${mainId}`}']);
  });

  test('inline style is only ever built with cssVars() or numeric flex-grow', () => {
    const offenders = sources
      .flatMap(([f, t]) => [...t.matchAll(/style=\{[^}]*\}?\}?/g)].map((m) => `${f}: ${m[0]}`))
      .filter((s) => !/cssVars\(|flexGrow|undefined/.test(s));
    expect(offenders).toEqual([]);
  });
});

let mounted: Mounted | null = null;
let problems: string[] = [];
beforeEach(() => {
  problems = [];
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void problems.push(a.join(' ')),
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
  expect(problems).toEqual([]);
});

/** Only our own numbers may reach an inline style (CSS custom properties, flex-grow, the tooltip transform). */
const NUMERIC_STYLE =
  /^(?:\s*(?:--[\w-]+|flex-grow|transform):\s*(?:-?[\d.]+(?:px|%)?|translate\([-\d.]+px, [-\d.]+px\));?)+\s*$/;

function expectInert(root: ParentNode): void {
  expect(
    root.querySelectorAll(
      'img, script, iframe, object, embed, svg image, style, link, base, a[href^="javascript:"]',
    ),
  ).toHaveLength(0);
  const all = [...root.querySelectorAll('*')];
  for (const el of all) {
    for (const a of el.getAttributeNames())
      expect(a.startsWith('on'), `${el.tagName} ${a}`).toBe(false);
    const style = el.getAttribute('style');
    if (style) expect(style, el.outerHTML.slice(0, 120)).toMatch(NUMERIC_STYLE);
  }
  expect(qa(root as HTMLElement, 'a')).toHaveLength(1); // the skip link, nothing from the data
}

describe('hostile data from the API', () => {
  test('page urls, usernames and user ids are inert text everywhere they appear', async () => {
    mounted = await mountReact(
      <DynaliticsDashboard endpoint="/s/x" fetch={mockFetch('hostile')} />,
    );
    await settleReact();
    const root = mounted.container;
    expectInert(root);
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.textContent).toContain('"><script>alert(1)</script>');
    expect(root.textContent).toContain('javascript:alert(document.domain)');
    expect(root.textContent).toContain("'; DROP TABLE visits;--");
    // visitor strings sit in bidi-isolated, wrappable text nodes
    const pageCells = qa(root, '.p-pages .dy-page.v, .p-table td.c-page');
    expect(pageCells.length).toBeGreaterThan(8);
    expect(
      pageCells.every((c) => c.classList.contains('v') && c.getAttribute('dir') === 'auto'),
    ).toBe(true);
    // the top-pages list shows them all, none became markup
    const texts = qa(root, '.p-pages .dy-page.v').map((n) => n.textContent);
    for (const hostile of HOSTILE_PAGES.slice(0, 4)) expect(texts).toContain(hostile);
    // exploring the charts and revealing values (more hostile text) stays inert
    await press(q(root, '.p-hero .dy-chart'), 'ArrowRight');
    await click(q(root, '.p-table .dy-tools button'));
    await settleReact();
    expectInert(root);
  });

  test('server error text and unavailable messages are never markup; error copy is fixed', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const base = mockFetch('ok');
    mounted = await mountReact(
      <DynaliticsDashboard
        endpoint="/s/x"
        fetch={(url, init) => {
          if (url.includes('consent-rate'))
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  success: false,
                  data: null,
                  unavailable: null,
                  error: {
                    code: 'internal',
                    message: `MESSAGE-NEVER-SHOWN ${hostile}`,
                    param: `PARAM ${hostile}`,
                  },
                }),
                { status: 500 },
              ),
            );
          if (url.endsWith('/api/meta'))
            return base(url, init).then(async (r) => {
              const body = (await r.json()) as { data: ReturnType<typeof makeMeta> };
              body.data.widgets.newVsReturning = {
                available: false,
                reason: 'no_identity_column',
                message: hostile,
              };
              return new Response(JSON.stringify(body), { status: 200 });
            });
          return base(url, init);
        }}
      />,
    );
    await settleReact();
    const root = mounted.container;
    expectInert(root);
    const consent = q(root, '.p-consent') as HTMLElement;
    expect(consent.textContent).toContain('Something went wrong on the server.'); // fixed copy, not the server message
    expect(consent.textContent).not.toContain('MESSAGE-NEVER-SHOWN'); // the server's message is never shown
    expect(consent.textContent).toContain('PARAM <img src=x'); // the parameter name is shown, as inert text (DESIGN 8.3)
    expect(q(root, '.p-nvr .dy-na-state')?.textContent).toContain(hostile); // unavailable.message IS shown, as text
  });

  test('breakdown values and series labels from the API are text', async () => {
    const base = mockFetch('ok');
    mounted = await mountReact(
      <DynaliticsDashboard
        endpoint="/s/x"
        fetch={(url, init) =>
          url.includes('breakdown=plan')
            ? base(url, init).then(async (r) => {
                const body = (await r.json()) as {
                  data: { breakdown: { series: { value: string | null }[] } };
                };
                body.data.breakdown.series.forEach((s, i) => {
                  if (s.value !== null) s.value = `<b onmouseover=alert(${i})>${s.value}</b>`;
                });
                return new Response(JSON.stringify(body), { status: 200 });
              })
            : base(url, init)
        }
      />,
    );
    await settleReact();
    const select = q(mounted.container, '.p-hero select') as HTMLSelectElement;
    await inAct(() => {
      select.value = 'plan';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleReact();
    expectInert(mounted.container);
    expect(q(mounted.container, '.p-hero .dy-legend')?.textContent).toContain(
      '<b onmouseover=alert(',
    );
  });
});

describe('redirects and request failures', () => {
  const failing = (make: () => Response) => (): Promise<Response> => Promise.resolve(make());

  test('a redirected response (login page, single sign-on) is "unexpected reply", never parsed as data', async () => {
    mounted = await mountReact(
      <DynaliticsDashboard
        endpoint="/s/x"
        fetch={failing(() =>
          Object.defineProperty(new Response('{"success":true}', { status: 200 }), 'redirected', {
            value: true,
          }),
        )}
      />,
    );
    await settleReact();
    expect(q(mounted.container, '.dy-err .dy-stamp')?.textContent).toBe('UNEXPECTED REPLY');
  });

  test('an opaque redirect (redirect: manual) is "unexpected reply"', async () => {
    mounted = await mountReact(
      <DynaliticsDashboard
        endpoint="/s/x"
        fetch={failing(() =>
          Object.defineProperty(new Response(null, { status: 200 }), 'type', {
            value: 'opaqueredirect',
          }),
        )}
      />,
    );
    await settleReact();
    expect(q(mounted.container, '.dy-err .dy-stamp')?.textContent).toBe('UNEXPECTED REPLY');
  });

  test('401 and 403 are "not authorised" with a reload button and no retry', async () => {
    for (const status of [401, 403]) {
      const m = await mountReact(
        <DynaliticsDashboard
          endpoint="/s/x"
          fetch={failing(
            () =>
              new Response('{"success":false,"error":{"code":"forbidden","message":"x"}}', {
                status,
              }),
          )}
        />,
      );
      await settleReact();
      expect(q(m.container, '.dy-err .dy-stamp')?.textContent).toBe('NOT AUTHORISED');
      expect(qa(m.container, '.dy-err button').map((b) => b.textContent)).toEqual(['Reload page']);
      await m.unmount();
    }
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { createApi } from '../../src/ui/api.js';
import { drawColumns } from '../../src/ui/charts/columns.js';
import { drawLineArea } from '../../src/ui/charts/line-area.js';
import { timeLabels } from '../../src/ui/charts/labels.js';
import { createFormatters } from '../../src/ui/format.js';
import { mockFetch } from '../fixtures/api.js';
import { mount, settle } from './harness.js';

const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createApi transport', () => {
  const ok = JSON.stringify({
    success: true,
    data: { a: 1 },
    unavailable: null,
    error: null,
    meta: { generatedAt: 'x', piiMasked: true, cached: false },
  });
  test('builds same-origin URLs with params and credentials', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const api = createApi('/admin', (url, init) => {
      seen = { url, init };
      return Promise.resolve(new Response(ok));
    });
    const r = await api.get('top-pages', { limit: '10' });
    expect(r.kind).toBe('data');
    expect(seen!.url).toBe('/admin/api/top-pages?limit=10');
    expect(seen!.init?.credentials).toBe('same-origin');
  });
  test('network failure is unreachable; an abort is silent', async () => {
    const down = createApi('', () => Promise.reject(new TypeError('x')));
    expect(await down.get('meta', {})).toMatchObject({
      kind: 'error',
      failure: { kind: 'unreachable' },
    });
    const ctl = new AbortController();
    ctl.abort();
    expect(await down.get('meta', {}, ctl.signal)).toEqual({ kind: 'aborted' });
  });
  test('redirects and non-JSON bodies are unexpected; 403 HTML is forbidden', async () => {
    const redirected = {
      ok: true,
      status: 200,
      redirected: true,
      json: () => Promise.resolve({}),
    } as unknown as Response;
    expect(await createApi('', () => Promise.resolve(redirected)).get('meta', {})).toMatchObject({
      failure: { kind: 'unexpected' },
    });
    expect(
      await createApi('', () => Promise.resolve(new Response('<html>', { status: 200 }))).get(
        'meta',
        {},
      ),
    ).toMatchObject({ failure: { kind: 'unexpected' } });
    expect(
      await createApi('', () => Promise.resolve(new Response('<html>', { status: 403 }))).get(
        'meta',
        {},
      ),
    ).toMatchObject({ failure: { kind: 'forbidden' } });
  });
  test('abort during the body read is silent', async () => {
    const ctl = new AbortController();
    const slow = {
      ok: true,
      status: 200,
      redirected: false,
      json: () => {
        ctl.abort();
        return Promise.reject(new Error('aborted'));
      },
    } as unknown as Response;
    expect(await createApi('', () => Promise.resolve(slow)).get('meta', {}, ctl.signal)).toEqual({
      kind: 'aborted',
    });
  });
});

describe('chart drawing edge cases', () => {
  const f = createFormatters('en-GB');
  test('single point draws a dot, empty percent bucket draws a stub, month labels work', () => {
    const t = Date.UTC(2026, 9, 1);
    const one = drawLineArea(300, 200, {
      values: [5],
      xLabels: timeLabels(f, [t], 'month'),
      inProgressLast: false,
      compact: f.compact,
    });
    expect(one.svg.querySelectorAll('circle').length).toBe(1);
    expect(one.svg.querySelector('text.ax:last-of-type')?.textContent).toBe('Oct');
    const cols = drawColumns(300, 200, {
      series: [
        { fill: 'f-a', values: [0, 3] },
        { fill: 'f-b', values: [0, 1] },
      ],
      percent: true,
      xLabels: timeLabels(f, [t, t + 864e5], 'hour'),
      compact: f.compact,
    });
    expect(cols.svg.querySelectorAll('line.stub').length).toBe(1);
    expect(cols.svg.querySelectorAll('rect').length).toBe(2);
  });
});

describe('dashboard interactions', () => {
  test('24h range uses hourly buckets and 30d daily', async () => {
    const { calls } = mount('ok');
    await settle();
    (q('#dy-range input[value="24h"]') as HTMLInputElement).click();
    await settle();
    const hero = (n: string) =>
      new URL(calls.filter((c) => c.includes(n)).pop()!, 'http://x').searchParams;
    expect(hero('visits-over-time').get('interval')).toBe('hour');
    expect(q('.p-hero .dy-hero-wrap')).not.toBeNull();
    (q('#dy-range input[value="30d"]') as HTMLInputElement).click();
    await settle();
    expect(hero('visits-over-time').get('interval')).toBe('day');
    expect(location.hash).toBe('#range=30d');
  });
  test('top pages limit select refetches only that panel', async () => {
    const { calls } = mount('ok');
    await settle();
    const before = calls.length;
    const select = q('.p-pages select') as HTMLSelectElement;
    select.value = '25';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)).toContain('limit=25');
  });
  test('Try 90 days from the empty hero switches range; 90d empty offers refresh', async () => {
    const { calls } = mount('empty');
    await settle();
    qa('.p-hero .dy-state button')
      .find((b) => b.textContent === 'Try 90 days')!
      .click();
    await settle();
    expect((q('#dy-range input[value="90d"]') as HTMLInputElement).checked).toBe(true);
    expect(q('.p-hero .dy-state h3')?.textContent).toBe('Nothing recorded yet.');
    expect(q('.p-hero code')?.textContent).toBe('track()');
    const before = calls.length;
    qa('.p-hero .dy-state button')
      .find((b) => b.textContent === 'Refresh')!
      .click();
    await settle();
    expect(calls.length).toBeGreaterThan(before);
  });
  test('every chart is explorable by keyboard and shows its own tooltip lines', async () => {
    mount('ok');
    await settle();
    for (const cls of ['.p-nvr', '.p-consent']) {
      const chart = q(`${cls} .dy-chart`)!;
      key(chart, 'ArrowRight');
      key(chart, 'ArrowRight');
      key(chart, 'End');
      key(chart, 'Home');
      expect(q(`${cls} .dy-tip`)?.querySelectorAll('div').length).toBeGreaterThanOrEqual(2);
      expect(q(`${cls} [role="status"]`)?.textContent).toMatch(/Oct/);
    }
    expect(q('.p-nvr [role="status"]')?.textContent).toMatch(/returning \d+, new \d+, unknown \d+/);
  });
  test('pointer exploration moves the crosshair', async () => {
    mount('ok');
    await settle();
    const chart = q('.p-hero .dy-chart')!;
    chart.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, bubbles: true }));
    expect(q('.p-hero .dy-tip')?.classList.contains('on')).toBe(true);
    chart.dispatchEvent(new MouseEvent('pointerleave'));
    expect(q('.p-hero .dy-tip')?.classList.contains('on')).toBe(true); // jsdom has no pointerType: touch-like, stays
  });
  test('table twins carry real headers and the consent twin says share of visits', async () => {
    mount('ok');
    await settle();
    qa('.p-consent .dy-toggle button')[1]!.click();
    const heads = qa('.p-consent table.dy-twin th[scope="col"]').map((h) => h.textContent);
    expect(heads).toContain('Share of visits');
    expect(qa('.p-consent table.dy-twin tbody th[scope="row"]').length).toBeGreaterThan(5);
  });
  test('stale data stays visible when a refresh fails, with a retry notice', async () => {
    let fail = false;
    mount(
      'ok',
      (f) => (input, init) =>
        fail && input.includes('top-pages')
          ? Promise.reject(new TypeError('offline'))
          : f(input, init),
    );
    await settle();
    fail = true;
    (q('#dy-refresh') as HTMLButtonElement).click();
    await settle();
    expect(q('.p-pages .dy-pages')).not.toBeNull();
    expect(q('.p-pages .dy-stale .dy-stamp')?.textContent).toBe('UNREACHABLE');
    expect(q('.p-pages .dy-stale')?.textContent).toContain('Showing data from 12:05:00 UTC');
  });
  test('load more failure keeps rows and offers another try', async () => {
    let fail = false;
    mount(
      'ok',
      (f) => (input, init) =>
        fail && input.includes('cursor=') ? Promise.reject(new TypeError('x')) : f(input, init),
    );
    await settle();
    fail = true;
    qa('.p-table .dy-more button')[0]!.click();
    await settle();
    expect(qa('.p-table tbody tr').length).toBe(25);
    expect(q('.p-table .dy-more')?.textContent).toContain('Could not load more');
    expect(q('.p-table .dy-more button')).not.toBeNull();
  });
  test('a failed meta refresh after a good load keeps the old page', async () => {
    let fail = false;
    mount(
      'ok',
      (f) => (input, init) =>
        fail && input.includes('/api/meta') ? Promise.reject(new TypeError('x')) : f(input, init),
    );
    await settle();
    fail = true;
    (q('#dy-refresh') as HTMLButtonElement).click();
    await settle();
    expect(qa('.dy-panel').length).toBe(5);
    expect(q('.dy-hero-num')).not.toBeNull();
  });
  test('unavailable meta widget: server answered 200 unavailable on the route itself', async () => {
    mount(
      'ok',
      (f) => (input, init) =>
        input.includes('consent-rate')
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  success: true,
                  data: null,
                  error: null,
                  unavailable: { reason: 'disabled_by_host', message: 'Off <b>x</b>' },
                  meta: { generatedAt: 'x', piiMasked: true, cached: false },
                }),
              ),
            )
          : f(input, init),
    );
    await settle();
    expect(q('.p-consent .dy-na-state')?.textContent).toContain('Off <b>x</b>');
    expect(q('.p-consent .dy-na-state b')).toBeNull();
    expect(q('.p-consent .dy-err')).toBeNull();
  });
});

describe('mock fetch honours abort', () => {
  test('rejects when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(mockFetch('ok')('/x/api/meta', { signal: ctl.signal })).rejects.toThrow();
  });
});

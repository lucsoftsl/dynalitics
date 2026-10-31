// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FetchFn } from '../../src/ui/api.js';
import { NOW } from '../fixtures/api.js';
import { mount, settle } from './harness.js';

const q = (s: string) => document.querySelector<HTMLElement>(s);
const meta = { generatedAt: NOW, piiMasked: true, cached: false };

/** Replace one route's data; everything else comes from the normal mock. */
const override =
  (path: string, data: unknown) =>
  (f: FetchFn): FetchFn =>
  (input, init) =>
    input.includes(`/api/${path}`)
      ? Promise.resolve(
          new Response(
            JSON.stringify({ success: true, data, unavailable: null, error: null, meta }),
          ),
        )
      : f(input, init);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('edge data shapes', () => {
  test('consent: all declined shows 0%, empty buckets say "No visits"', async () => {
    const b = (d: string, granted: number, denied: number) => ({
      bucket: d,
      granted,
      denied,
      rate: granted + denied ? granted / (granted + denied) : null,
    });
    mount(
      'ok',
      override('consent-rate', {
        interval: 'day',
        points: [b('2026-10-29T00:00:00.000Z', 0, 4), b('2026-10-30T00:00:00.000Z', 0, 0)],
        totals: { granted: 0, denied: 4, rate: 0 },
      }),
    );
    await settle();
    expect(q('.p-consent .dy-kpi-num')?.textContent).toContain('0%');
    const chart = q('.p-consent .dy-chart')!;
    chart.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    expect(q('.p-consent .dy-tip')?.textContent).toContain('No visits');
  });
  test('consent: rate null renders a dash, never NaN', async () => {
    mount(
      'ok',
      override('consent-rate', {
        interval: 'day',
        points: [{ bucket: '2026-10-30T00:00:00.000Z', granted: 1, denied: 0, rate: null }],
        totals: { granted: 1, denied: 0, rate: null },
      }),
    );
    await settle();
    expect(q('.p-consent .dy-kpi-num')?.textContent).toContain('—');
    expect(q('.p-consent')?.textContent).not.toContain('NaN');
  });
  test('new vs returning: only unknown visits says nobody could be classified', async () => {
    mount(
      'ok',
      override('new-vs-returning', {
        interval: 'day',
        source: 'computed',
        basis: 'ip',
        approximate: true,
        points: [{ bucket: '2026-10-30T00:00:00.000Z', new: 0, returning: 0, unknown: 5 }],
        totals: { new: 0, returning: 0, unknown: 5 },
      }),
    );
    await settle();
    expect(q('.p-nvr .dy-kpi-num')?.textContent).toContain('—');
    expect(q('.p-nvr .dy-kpi-sub')?.textContent).toBe('No visitors could be classified yet.');
  });
  test('hero with one bucket and weekly interval still draws and describes itself', async () => {
    mount(
      'ok',
      override('visits-over-time', {
        interval: 'week',
        points: [{ bucket: '2026-10-26T00:00:00.000Z', visits: 7 }],
        total: 7,
      }),
    );
    await settle();
    expect(q('.p-hero .dy-chart')?.getAttribute('aria-label')).toContain('Visits per week');
    expect(q('.p-hero svg circle')).not.toBeNull();
  });
  test('top pages: tiny share shows <1% and other-pages row is hatched', async () => {
    mount(
      'ok',
      override('top-pages', {
        totalVisits: 1000,
        pages: [
          { page: '/a', visits: 990, share: 0.99 },
          { page: '/b', visits: 2, share: 0.002 },
        ],
        otherVisits: 8,
      }),
    );
    await settle();
    expect(q('.p-pages')?.textContent).toContain('<1%');
    expect(q('.p-pages .dy-page-row--other')?.textContent).toContain('Other pages');
  });
});

describe('browser entry', () => {
  test('main.ts reads the base from the meta tag and starts', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.reject(new TypeError('offline'));
    });
    mount('ok'); // builds the page chrome
    document.head.innerHTML = '<meta name="dynalitics-base" content="/admin/analytics">';
    calls.length = 0;
    await import('../../src/ui/main.js');
    await settle(5);
    expect(calls[0]).toBe('/admin/analytics/api/meta');
    vi.unstubAllGlobals();
  });
});

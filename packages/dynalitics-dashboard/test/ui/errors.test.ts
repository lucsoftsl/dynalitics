// @vitest-environment jsdom
// docs/DESIGN.md 15: HTTP status in the HTML dashboard (Errors panel, status column, explorer filters and split).
import { afterEach, describe, expect, test } from 'vitest';
import { statusBadge, statusClass } from '../../src/ui/panels/status.js';
import { buildSplit } from '../../src/ui/panels/hero-split.js';
import { mount, settle } from './harness.js';

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const n = document.querySelector<T>(sel);
  if (!n) throw new Error(`missing ${sel}`);
  return n;
};
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
const route = (calls: string[], name: string) =>
  calls.filter((c) => new URL(c, 'http://x').pathname.endsWith(`/api/${name}`));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('status classes and badges', () => {
  test('1xx/2xx ok, 3xx redirect, 4xx client, 5xx server', () => {
    expect([101, 200, 204, 301, 399, 400, 404, 499, 500, 503, 599].map(statusClass)).toEqual([
      'ok',
      'ok',
      'ok',
      'redirect',
      'redirect',
      'client',
      'client',
      'client',
      'server',
      'server',
      'server',
    ]);
  });
  test('the badge prints the code and speaks the class: colour is never the only signal', () => {
    const b = statusBadge(503);
    expect(b.className).toBe('dy-status dy-status--server');
    expect(b.textContent).toBe('503 server error');
    expect(b.querySelector('.vh')?.textContent).toBe(' server error');
  });
  test('a statusClass split gets the semantic swatches, never categorical ones', () => {
    const pts = [{ bucket: 'b', visits: 1 }];
    const split = buildSplit('statusClass', [
      { value: '2xx', isOther: false, points: pts },
      { value: '4xx', isOther: false, points: pts },
      { value: '5xx', isOther: false, points: pts },
      { value: null, isOther: false, points: pts },
    ]);
    expect(split.map((s) => [s.name, s.swatch, s.fill])).toEqual([
      ['2xx success', 'ok', 'f-ok'],
      ['4xx client error', 'client', 'f-client'],
      ['5xx server error', 'server', 'f-server'],
      ['No value', 'unknown', 'f-none'],
    ]);
  });
});

describe('overview', () => {
  test('no status column on the server: no Errors panel, no /api/errors call, table stays No. 5', async () => {
    const { calls } = mount('ok');
    await settle();
    expect(document.querySelector('.p-errors')).toBeNull();
    expect(route(calls, 'errors')).toEqual([]);
    expect($('.p-table .dy-eyebrow').textContent).toBe('No. 5');
    expect($$('.p-table th').map((t) => t.textContent)).not.toContain('Status');
  });

  test('the Errors panel: rate, split bar, chart, failing pages and reasons', async () => {
    const { calls } = mount('errors');
    await settle();
    const p = $('.p-errors');
    expect(route(calls, 'errors')).toHaveLength(1);
    expect(p.querySelector('.dy-kpi-num')?.textContent).toMatch(/^\d+(\.\d)?%failed$/);
    expect(p.querySelector('.dy-kpi-num small')?.className).toBe('c-server');
    expect(p.querySelector('.dy-bar-split')?.getAttribute('aria-label')).toMatch(
      /succeeded, \d+ client errors, \d+ server errors/,
    );
    expect(p.querySelector('.dy-chart, table')).not.toBeNull();
    const pages = [...p.querySelectorAll('.dy-err-pages li')];
    expect(pages.map((li) => li.querySelector('.dy-page')?.textContent)).toEqual([
      '/checkout',
      '/api/cart',
      '/wp-login.php',
    ]);
    expect(pages[0]?.className).toContain('dy-err-row--server');
    expect(pages[2]?.className).toContain('dy-err-row--client');
    expect(pages[0]?.querySelector('.dy-count')?.textContent).toBe('41 · 29 5xx');
    const reasons = [...p.querySelectorAll('.dy-err-reasons li')].map((li) => li.textContent);
    expect(reasons[0]).toBe('404 client errorno reason given31');
    expect(reasons[1]).toBe('503 server errorECONNREFUSED24');
  });

  test('panel order and numbering: Errors is No. 5, the table No. 6', async () => {
    mount('errors');
    await settle();
    const order = $$('.dy-grid > .dy-panel').map((el) =>
      ['p-hero', 'p-pages', 'p-nvr', 'p-consent', 'p-errors', 'p-table'].find((c) =>
        el.classList.contains(c),
      ),
    );
    expect(order).toEqual(['p-hero', 'p-pages', 'p-nvr', 'p-consent', 'p-errors', 'p-table']);
    expect($('.p-errors .dy-eyebrow').textContent).toBe('No. 5');
    expect($('.p-table .dy-eyebrow').textContent).toBe('No. 6');
  });

  test('the table gets a Status column: badge, reason on line two, a dash when none; kept on declined rows', async () => {
    mount('errors');
    await settle();
    expect($$('.p-table th').map((t) => t.textContent)).toContain('Status');
    const cells = $$('.p-table td.c-status');
    expect(cells.length).toBeGreaterThan(0);
    const texts = cells.map((c) => c.textContent);
    expect(texts).toContain('503 server errorECONNREFUSED');
    expect(texts).toContain('200 success');
    expect(cells.some((c) => c.querySelector('.dash') !== null)).toBe(true);
    // Row 1 of the mock (i % 4 === 1) is declined and has status 200: the status cell is still there.
    const declined = $$('.p-table tbody tr').find((tr) => tr.querySelector('td.na') !== null);
    expect(declined?.querySelector('td.c-status')).not.toBeNull();
  });
});

describe('explorer', () => {
  test('quick filters write the query, toggle off on a second click, and show aria-pressed', async () => {
    const { calls } = mount('errors', undefined, '#view=explorer');
    await settle();
    const buttons = $$('.dy-xquick button');
    expect(buttons.map((b) => b.textContent)).toEqual(['5xx', '4xx', 'All errors']);
    buttons[0]?.click();
    await settle();
    expect($<HTMLInputElement>('#dy-q').value).toBe('statusClass:5xx');
    const last = route(calls, 'search').at(-1) ?? '';
    expect(new URL(last, 'http://x').searchParams.get('q')).toBe('statusClass:5xx');
    expect($$('.dy-xquick button')[0]?.getAttribute('aria-pressed')).toBe('true');
    $$('.dy-xquick button')[0]?.click();
    await settle();
    expect($<HTMLInputElement>('#dy-q').value).toBe('');
  });

  test('no status field: no quick filters', async () => {
    mount('ok', undefined, '#view=explorer');
    await settle();
    expect(document.querySelector('.dy-xquick')).toBeNull();
  });

  test('split by statusClass uses the error colours in the legend', async () => {
    mount('errors', undefined, '#view=explorer&split=statusClass');
    await settle();
    const swatches = $$('.p-xhist .dy-legend .dy-sw').map((s) => s.className);
    expect(swatches).toEqual(
      expect.arrayContaining(['dy-sw dy-sw-ok', 'dy-sw dy-sw-client', 'dy-sw dy-sw-server']),
    );
  });
});

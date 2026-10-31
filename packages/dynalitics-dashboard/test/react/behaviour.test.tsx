// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ConsentRate,
  DynaliticsDashboard,
  DynaliticsProvider,
  NewVsReturning,
  RangeSelector,
  RecentVisits,
  TopPages,
  useDynalitics,
  VisitsOverTime,
  type DashboardProps,
} from '../../src/react/index.js';
import { mockFetch, type Scenario } from '../fixtures/api.js';
import {
  click,
  fetchFor,
  inAct,
  mountReact,
  press,
  q,
  qa,
  settleReact,
  type Mounted,
} from './render.js';

let mounted: Mounted | null = null;
let consoleProblems: string[] = [];

beforeEach(() => {
  consoleProblems = [];
  vi.spyOn(console, 'error').mockImplementation(
    (...a: unknown[]) => void consoleProblems.push(a.join(' ')),
  );
  vi.spyOn(console, 'warn').mockImplementation(
    (...a: unknown[]) => void consoleProblems.push(a.join(' ')),
  );
  localStorage.clear();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
  // React warnings (keys, act, hydration, unknown props) are test failures.
  expect(consoleProblems).toEqual([]);
});

/** `mockFetch` answers at once; this one makes every data route (not meta) take `ms`, like a slow database. */
function slowFetch(ms: number) {
  const base = mockFetch('ok');
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      if (url.endsWith('/api/meta')) return base(url, init);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(base(url, init)), ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    },
  };
}

async function open(scenario: Scenario, props: Partial<DashboardProps> = {}) {
  const f = fetchFor(scenario);
  mounted = await mountReact(
    <DynaliticsDashboard endpoint="/s/x" fetch={f.fetch} locale="en-GB" {...props} />,
  );
  await settleReact();
  return { ...f, root: mounted.container };
}

const text = (n: Element | null): string => n?.textContent ?? '';
const urlsOf = (calls: { url: string }[]): string[] => calls.map((c) => c.url);
const panel = (root: ParentNode, cls: string): HTMLElement =>
  q(root, `.dy-panel.${cls}`) as HTMLElement;

describe('structure and requests', () => {
  test('renders the masthead, five panels and one request per route', async () => {
    const { root, calls } = await open('ok');
    expect(text(q(root, 'h1'))).toBe('dynalitics');
    expect(qa(root, '.dy-panel h2').map(text)).toEqual([
      'Visits over time',
      'Top pages',
      'New vs returning',
      'Consent',
      'Recent visits',
    ]);
    const paths = urlsOf(calls).map((u) =>
      new URL(u, 'http://x').pathname.replace('/s/x/api/', ''),
    );
    expect(paths.sort()).toEqual(
      [
        'consent-rate',
        'meta',
        'new-vs-returning',
        'recent-visits',
        'top-pages',
        'visits-over-time',
      ].sort(),
    );
    expect(text(panel(root, 'p-hero').querySelector('.dy-eyebrow'))).toBe('No. 1 · LAST 7 DAYS');
    expect(text(panel(root, 'p-nvr').querySelector('.dy-eyebrow'))).toBe('No. 3 · LAST 7 DAYS');
  });

  test.each([
    ['/admin/analytics', '/admin/analytics/api/meta'],
    ['/admin/analytics/', '/admin/analytics/api/meta'],
    ['/', '/api/meta'],
    ['', '/api/meta'],
    ['https://evil.example/x', '/api/meta'],
    ['//evil.example', '/api/meta'],
    ['//host', '/api/meta'], // protocol-relative: would be another origin
    ['/a//b', '/api/meta'],
    ['/a/../b', '/api/meta'],
    ['/a b', '/api/meta'],
  ])('endpoint %j is normalised to %s', async (endpoint, expected) => {
    const { calls } = await open('ok', { endpoint });
    expect(urlsOf(calls)[0]).toBe(expected);
  });

  test('a protocol-relative endpoint never receives the request options', async () => {
    const getRequestInit = vi.fn(() => ({ headers: { authorization: 'Bearer test-token' } }));
    const { calls } = await open('ok', { endpoint: '//host', getRequestInit });
    expect(calls.length).toBeGreaterThan(5);
    for (const { url } of calls) expect(url.startsWith('/api/')).toBe(true);
  });

  test('the first range is the server default unless the host asks for another offered one', async () => {
    const a = await open('ok');
    expect(text(q(a.root, '.dy-range input:checked + span'))).toBe('7d');
    await mounted?.unmount();
    mounted = null;
    const b = await open('ok', { defaultRange: '30d' });
    expect(text(q(b.root, '.dy-range input:checked + span'))).toBe('30d');
    expect(
      b.calls.some((c) => c.url.includes('visits-over-time') && c.url.includes('from=2026-09-30')),
    ).toBe(true);
  });
});

describe('range selector and the new-vs-returning cap (DESIGN 6.4.1)', () => {
  test('choosing a range re-reads meta, reloads every panel and tells the host', async () => {
    const onRangeChange = vi.fn();
    const { root, calls } = await open('ok', { onRangeChange });
    const before = calls.length;
    await click(q(root, '.dy-range input[value="30d"]'));
    await settleReact();
    expect(onRangeChange).toHaveBeenCalledWith('30d');
    const fresh = urlsOf(calls.slice(before));
    expect(fresh[0]).toMatch(/\/api\/meta$/);
    expect(fresh.filter((u) => u.includes('/api/visits-over-time')).length).toBe(1);
    expect(text(panel(root, 'p-hero').querySelector('.dy-eyebrow'))).toBe('No. 1 · LAST 30 DAYS');
  });

  test('90d: the other panels keep 90 days, new vs returning is clamped to 31 and says so, with no error', async () => {
    const { root, calls } = await open('ok');
    await click(q(root, '.dy-range input[value="90d"]'));
    await settleReact();
    const nvr = panel(root, 'p-nvr');
    expect(text(nvr.querySelector('.dy-eyebrow'))).toBe('No. 3 · LAST 31 DAYS');
    expect(text(panel(root, 'p-hero').querySelector('.dy-eyebrow'))).toBe('No. 1 · LAST 90 DAYS');
    expect(qa(nvr, '.dy-note').map(text)).toContain(
      'Showing the last 31 days: this widget is capped at 31 days.',
    );
    expect(nvr.querySelector('.dy-err')).toBeNull();
    const nvrUrl =
      urlsOf(calls)
        .filter((u) => u.includes('new-vs-returning'))
        .pop() ?? '';
    const p = new URL(nvrUrl, 'http://x').searchParams;
    expect(
      (Date.parse(p.get('to') ?? '') - Date.parse(p.get('from') ?? '')) / 86_400_000,
    ).toBeCloseTo(31, 5);
    expect(p.get('interval')).toBe('day');
    expect(text(nvr.querySelector('caption'))).toContain('last 31 days');
  });
});

describe('widget availability and meta-driven columns', () => {
  test('an unavailable widget is a calm block: no request, no red, no retry', async () => {
    const { root, calls } = await open('nvr-unavailable');
    const nvr = panel(root, 'p-nvr');
    const block = q(nvr, '.dy-na-state');
    expect(block?.getAttribute('role')).toBe('status');
    expect(text(block)).toContain('Not available');
    expect(text(block)).toContain('reason: identity_not_reliable');
    expect(nvr.querySelector('.dy-err, button.dy-btn--text')).toBeNull();
    expect(urlsOf(calls).some((u) => u.includes('new-vs-returning'))).toBe(false);
  });

  test('columns follow meta.fields: no column for an unmapped role', async () => {
    const { root } = await open('sparse-fields');
    expect(qa(q(root, '.p-table thead') as HTMLElement, 'th').map((t) => t.textContent)).toEqual([
      'Time (UTC)',
      'Page',
      'Consent',
      'First visit',
      'User ID (masked)',
    ]);
  });

  test('approximate new-vs-returning shows the ESTIMATE tag and the caveat; exact identity does not', async () => {
    const a = await open('ok');
    expect(text(q(a.root, '.p-nvr .dy-estimate'))).toBe('Estimate');
    expect(text(q(a.root, '.p-nvr'))).toContain('Read these as estimates');
    await mounted?.unmount();
    mounted = null;
    const b = await open('nvr-exact');
    expect(q(b.root, '.p-nvr .dy-estimate')).toBeNull();
  });
});

describe('request options (getRequestInit)', () => {
  test('merges headers, keeps redirect manual and GET, and lets our signal and accept header win', async () => {
    const getRequestInit = vi.fn(() => ({
      headers: { authorization: 'Bearer test-token', accept: 'text/html' },
      method: 'POST',
      redirect: 'follow' as const,
      body: 'x',
      credentials: 'include' as const,
    }));
    const { calls } = await open('ok', { getRequestInit });
    expect(calls.length).toBeGreaterThan(5);
    for (const { init } of calls) {
      const h = new Headers(init?.headers);
      expect(h.get('authorization')).toBe('Bearer test-token');
      expect(h.get('accept')).toBe('application/json');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      expect(init?.body).toBeUndefined();
      expect(init?.credentials).toBe('include');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(getRequestInit.mock.calls.length).toBe(calls.length);
  });

  test('defaults to same-origin credentials', async () => {
    const { calls } = await open('ok');
    expect(new Set(calls.map((c) => c.init?.credentials))).toEqual(new Set(['same-origin']));
  });

  test('a callback that throws shows "not authorised" and never leaks its message', async () => {
    const getRequestInit = (): never => {
      throw new Error('secret-token-lookup-failed');
    };
    const { root } = await open('ok', { getRequestInit });
    expect(text(q(root, '.dy-err'))).toContain('NOT AUTHORISED');
    expect(root.textContent).not.toContain('secret-token');
    expect(qa(root, '.dy-panel')).toHaveLength(0);
  });

  test('an async callback is awaited', async () => {
    const { calls } = await open('ok', {
      getRequestInit: () => Promise.resolve({ headers: { 'x-tenant': 'a' } }),
    });
    expect(new Headers(calls[0]?.init?.headers).get('x-tenant')).toBe('a');
  });
});

describe('page-level and panel errors', () => {
  test.each([
    ['meta-forbidden', 'NOT AUTHORISED', true],
    ['unreachable', 'UNREACHABLE', false],
    ['html-reply', 'UNEXPECTED REPLY', false],
  ] as const)(
    '/api/meta failing (%s) shows one error and asks no other route',
    async (scenario, stamp, reload) => {
      const reloadPage = vi.fn();
      const { root, calls } = await open(scenario, { reloadPage });
      expect(qa(root, '.dy-err')).toHaveLength(1);
      expect(text(q(root, '.dy-err .dy-stamp'))).toBe(stamp);
      expect(q(root, '.dy-err')?.getAttribute('role')).toBe('alert');
      expect(urlsOf(calls).every((u) => u.endsWith('/api/meta'))).toBe(true);
      if (reload) {
        await click(
          qa(root, '.dy-err button').find((b) => b.textContent === 'Reload page') ?? null,
        );
        expect(reloadPage).toHaveBeenCalledTimes(1);
      }
      if (scenario === 'unreachable') expect(text(q(root, '.dy-err'))).toContain('single sign-on');
    },
  );

  test('only the first panel error is an alert; Retry has a 2 s cooldown and no automatic retries', async () => {
    const { root, calls } = await open('timeout');
    const errors = qa(root, '.dy-err');
    expect(errors.length).toBeGreaterThan(1);
    expect(errors.filter((e) => e.getAttribute('role') === 'alert')).toHaveLength(1);
    const count = calls.length;
    const retry = qa(root, '.p-hero .dy-err button').find(
      (b) => b.textContent === 'Retry',
    ) as HTMLButtonElement;
    await click(retry);
    await settleReact(20, 4);
    const again = qa(root, '.p-hero .dy-err button').find((b) =>
      /Retry/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(again.textContent).toBe('Retrying...');
    expect(again.disabled).toBe(true);
    expect(calls.length - count).toBe(1); // exactly the one requested retry
  });

  test('"Try 7 days" on a timeout switches the range', async () => {
    const { root } = await open('timeout', { defaultRange: '30d' });
    await click(
      qa(root, '.p-hero .dy-err button').find((b) => b.textContent === 'Try 7 days') ?? null,
    );
    await settleReact();
    expect(text(q(root, '.dy-range input:checked + span'))).toBe('7d');
  });

  test('a failed refresh keeps the old data and says so', async () => {
    let down = false;
    const base = mockFetch('ok');
    const calls: string[] = [];
    mounted = await mountReact(
      <DynaliticsDashboard
        endpoint="/s/x"
        locale="en-GB"
        fetch={(url, init) => {
          calls.push(url);
          return down ? Promise.reject(new TypeError('offline')) : base(url, init);
        }}
      />,
    );
    await settleReact();
    const root = mounted.container;
    expect(q(root, '.p-hero .dy-hero-num')).not.toBeNull();
    down = true;
    await click(qa(root, '.dy-mast-btns button').find((b) => b.textContent === 'Refresh') ?? null);
    await settleReact();
    expect(q(root, '.p-hero .dy-stale')).not.toBeNull();
    expect(text(q(root, '.p-hero .dy-stale'))).toContain('UNREACHABLE');
    expect(q(root, '.p-hero .dy-hero-num')).not.toBeNull();
  });

  test('skeletons appear only after 200 ms', async () => {
    const f = slowFetch(700);
    mounted = await mountReact(<DynaliticsDashboard endpoint="/s/x" fetch={f.fetch} />);
    await settleReact(20, 5); // about 100 ms: meta arrived, panels loading
    const loading = q(mounted.container, '.p-pages .dy-loading');
    expect(loading?.classList.contains('dy-loading--wait')).toBe(true);
    await settleReact(40, 6); // past 200 ms
    expect(
      q(mounted.container, '.p-pages .dy-loading')?.classList.contains('dy-loading--wait'),
    ).toBe(false);
    expect(q(mounted.container, '.p-pages [aria-busy="true"]')).not.toBeNull();
    expect(text(q(mounted.container, '.p-pages [role="status"].vh'))).toBe('Loading Top pages');
  });
});

describe('charts: keyboard, table twin, split by', () => {
  test('arrow keys explore the chart, announce each period and Escape closes the tooltip', async () => {
    const { root } = await open('ok');
    const chart = q(panel(root, 'p-hero'), '.dy-chart') as HTMLElement;
    expect(chart.getAttribute('aria-roledescription')).toBe('chart');
    expect(chart.getAttribute('aria-describedby')).toBeTruthy();
    expect(text(q(root, `[id="${chart.getAttribute('aria-describedby')}"]`))).toContain(
      'left and right arrow keys',
    );
    expect(q(chart, '.dy-tip')?.classList.contains('on')).toBe(false);
    await press(chart, 'ArrowRight');
    const tip = q(chart, '.dy-tip') as HTMLElement;
    expect(tip.classList.contains('on')).toBe(true);
    const first = text(tip);
    expect(first).toMatch(/visits/);
    await press(chart, 'ArrowRight');
    expect(text(tip)).not.toBe(first);
    const live = q(panel(root, 'p-hero'), '[role="status"].vh') as HTMLElement;
    expect(text(live)).toMatch(/\d+ visits$/);
    await press(chart, 'End');
    expect(text(tip)).toContain('(so far)');
    await press(chart, 'Escape');
    expect(tip.classList.contains('on')).toBe(false);
    await press(chart, 'ArrowLeft'); // from nothing, ArrowLeft goes to the last period
    expect(text(tip)).toContain('(so far)');
  });

  test('the Table toggle swaps the chart for its real table twin', async () => {
    const { root } = await open('ok');
    const hero = panel(root, 'p-hero');
    const [chartBtn, tableBtn] = qa(hero, '.dy-toggle button');
    expect(chartBtn?.getAttribute('aria-pressed')).toBe('true');
    await click(tableBtn ?? null);
    expect(tableBtn?.getAttribute('aria-pressed')).toBe('true');
    expect((q(hero, '.dy-chart-wrap') as HTMLElement).hidden).toBe(true);
    const twin = q(hero, '.dy-table-wrap') as HTMLElement;
    expect(twin.hidden).toBe(false);
    expect(qa(twin, 'th[scope="col"]').map(text)).toEqual(['Period (UTC)', 'Visits']);
    expect(qa(twin, 'tbody tr').length).toBe(8);
    expect(q(twin, 'caption')?.textContent).toContain('7 days');
  });

  test('split by plan requests the breakdown and shows a stack-ordered legend with notes', async () => {
    const { root, calls } = await open('ok');
    const select = q(panel(root, 'p-hero'), 'select.dy-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'consent', 'plan']);
    await inAct(() => {
      select.value = 'plan';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleReact();
    expect(
      urlsOf(calls).some((u) => u.includes('visits-over-time') && u.includes('breakdown=plan')),
    ).toBe(true);
    const items = qa(panel(root, 'p-hero'), '.dy-legend li');
    expect(items.length).toBeGreaterThan(3);
    expect(
      items.some((li) => li.getAttribute('title') === 'Rows without a value for this field.'),
    ).toBe(true);
    expect(text(q(panel(root, 'p-hero'), '.dy-chart'))).not.toBe('');
  });

  test('the chart redraws at the measured width', async () => {
    const observers: { cb: () => void }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push({ cb });
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      fn();
      return 1;
    });
    const widthOf = (): string | null =>
      q(panel(mounted?.container as HTMLElement, 'p-consent'), '.dy-chart svg')?.getAttribute(
        'viewBox',
      ) ?? null;
    await open('ok');
    expect(widthOf()).toMatch(/^0 0 320 /);
    const host = q(
      panel(mounted?.container as HTMLElement, 'p-consent'),
      '.dy-chart',
    ) as HTMLElement;
    Object.defineProperty(host, 'clientWidth', { value: 700, configurable: true });
    await inAct(() => {
      observers.forEach((o) => o.cb());
    });
    expect(widthOf()).toMatch(/^0 0 700 /);
    vi.unstubAllGlobals();
  });
});

describe('recent visits', () => {
  test('values are masked as the server sends them; declined rows have one "not collected" cell', async () => {
    const { root } = await open('ok');
    const table = q(root, '.p-table table') as HTMLElement;
    expect(
      qa(table, 'th').every(
        (t) => /\(masked\)$/.test(t.textContent ?? '') || !t.classList.contains('th-lock'),
      ),
    ).toBe(true);
    expect(text(table)).toContain('203.0.x.x');
    expect(text(table)).toContain('u_***');
    const declined = qa(table, 'tbody tr').filter((r) => r.textContent?.includes('Declined'));
    expect(declined.length).toBeGreaterThan(3);
    for (const row of declined) {
      expect(qa(row, 'td.na')).toHaveLength(1);
      expect(row.textContent).toContain('Not collected: visitor declined consent');
    }
    expect(qa(table, 'tbody tr')).toHaveLength(25);
  });

  test('reveal is offered only when the server allows it, asks for ?pii=reveal and warns on screen', async () => {
    const a = await open('ok');
    const button = q(panel(a.root, 'p-table'), '.dy-tools button') as HTMLButtonElement;
    expect(button.textContent).toBe('Show full values');
    await click(button);
    await settleReact();
    expect(
      a.calls.some((c) => c.url.includes('recent-visits') && c.url.includes('pii=reveal')),
    ).toBe(true);
    expect(text(q(a.root, '.p-table'))).toContain(
      'Showing personal data. Hide when sharing your screen.',
    );
    expect(text(q(a.root, '.p-table'))).toContain('203.0.113.77');
    expect(q(a.root, '.p-table .dy-revealed')).not.toBeNull();
    expect(button.textContent).toBe('Hide full values');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await click(button);
    await settleReact();
    expect(text(q(a.root, '.p-table'))).not.toContain('203.0.113.77');
    await mounted?.unmount();
    mounted = null;
    const b = await open('sparse-fields'); // piiRevealable false
    expect(q(panel(b.root, 'p-table'), '.dy-tools button')).toBeNull();
  });

  test('"Load more" appends the next page, moves focus to the first new row and announces it', async () => {
    const { root, calls } = await open('ok');
    const more = qa(q(root, '.p-table .dy-more') as HTMLElement, 'button')[0] as HTMLButtonElement;
    expect(more.textContent).toBe('Load 25 more');
    await click(more);
    await settleReact();
    expect(calls.some((c) => c.url.includes('cursor=p25'))).toBe(true);
    const rows = qa(root, '.p-table tbody tr');
    expect(rows).toHaveLength(50);
    expect(document.activeElement).toBe(rows[25]?.querySelector('td'));
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
    expect(text(q(root, '.p-table [role="status"].vh'))).toBe('25 more visits loaded');
  });

  test('without a cursor the footer does not claim the range ended', async () => {
    const { root } = await open('no-cursor');
    expect(text(q(root, '.p-table .dy-more'))).toMatch(/^Showing the latest \d+ visits\.$/);
    const end = await open('ok');
    expect(end.root).toBeTruthy();
  });
});

describe('theme and standalone use', () => {
  test('system theme: one constant label, aria-pressed toggles, choice is stored', async () => {
    const { root } = await open('ok');
    const rootEl = q(root, '.dy-root') as HTMLElement;
    const button = qa(root, '.dy-mast-btns button').find(
      (b) => b.textContent === 'Dark theme',
    ) as HTMLButtonElement;
    expect(rootEl.hasAttribute('data-theme')).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await click(button);
    expect(rootEl.getAttribute('data-theme')).toBe('dark');
    expect(button.textContent).toBe('Dark theme');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('dynalitics-theme')).toBe('dark');
    await click(button);
    expect(rootEl.getAttribute('data-theme')).toBe('light');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  test('a stored choice is picked up after mount; fixed themes hide the toggle', async () => {
    localStorage.setItem('dynalitics-theme', 'dark');
    const a = await open('ok');
    expect((q(a.root, '.dy-root') as HTMLElement).getAttribute('data-theme')).toBe('dark');
    await mounted?.unmount();
    mounted = null;
    const b = await open('ok', { theme: 'light' });
    expect((q(b.root, '.dy-root') as HTMLElement).getAttribute('data-theme')).toBe('light');
    expect(qa(b.root, '.dy-mast-btns button').map(text)).toEqual(['Refresh']);
  });

  test('widgets work on their own inside the provider; only their routes are requested', async () => {
    const f = fetchFor('ok');
    mounted = await mountReact(
      <DynaliticsProvider endpoint="/s/x" fetch={f.fetch}>
        <RangeSelector />
        <VisitsOverTime />
        <TopPages />
        <NewVsReturning />
        <ConsentRate />
        <RecentVisits />
      </DynaliticsProvider>,
    );
    await settleReact();
    expect(qa(mounted.container, '.dy-panel')).toHaveLength(5);
    expect(q(mounted.container, '.dy-root')?.getAttribute('class')).toBe('dy-root');
    await mounted.unmount();
    mounted = null;
    const g = fetchFor('ok');
    mounted = await mountReact(
      <DynaliticsProvider endpoint="/s/x" fetch={g.fetch}>
        <TopPages />
      </DynaliticsProvider>,
    );
    await settleReact();
    const paths = g.calls.map((c) => new URL(c.url, 'http://x').pathname.replace('/s/x/api/', ''));
    expect(paths.sort()).toEqual(['meta', 'top-pages']);
  });

  test('a widget outside the provider explains itself', async () => {
    const boom = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(mountReact(<TopPages />)).rejects.toThrow(/inside <DynaliticsProvider>/);
    boom.mockRestore();
    consoleProblems = [];
  });

  test('unmounting aborts requests that are still in flight', async () => {
    const f = slowFetch(700);
    mounted = await mountReact(<DynaliticsDashboard endpoint="/s/x" fetch={f.fetch} />);
    await settleReact(20, 3);
    const signals = f.calls.map((c) => c.init?.signal).filter((s): s is AbortSignal => !!s);
    expect(signals.length).toBeGreaterThan(0);
    await mounted.unmount();
    mounted = null;
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(f.calls.filter((c) => !c.url.endsWith('/api/meta')).length).toBeGreaterThan(0); // they really were in flight
  });

  test('landmark="region" avoids a second <main> on pages that already have one', async () => {
    const { root } = await open('ok', { landmark: 'region' });
    expect(q(root, 'main')).toBeNull();
    expect(q(root, '[role="region"][aria-label="Analytics"]')).not.toBeNull();
    const skip = q(root, '.dy-skip') as HTMLAnchorElement;
    expect(q(root, `[id="${skip.getAttribute('href')?.slice(1)}"]`)).not.toBeNull();
  });
});

describe('useDynalitics() for custom layouts', () => {
  function Probe(): ReactElement {
    const d = useDynalitics();
    return (
      <div id="probe">
        <output data-status>{d.status}</output>
        <output data-range>{d.range ?? 'none'}</output>
        <output data-ranges>{d.ranges.join(',')}</output>
        <output data-updated>{d.updatedAt === null ? 'never' : 'set'}</output>
        <output data-dark>{String(d.isDark)}</output>
        <button type="button" data-refresh onClick={d.refresh} />
        <button type="button" data-30d onClick={() => d.setRange('30d')} />
      </div>
    );
  }

  test('reports status, offered ranges and lets a custom layout drive the range and refresh', async () => {
    const f = fetchFor('ok');
    const onRangeChange = vi.fn();
    mounted = await mountReact(
      <DynaliticsProvider
        endpoint="/s/x"
        fetch={f.fetch}
        theme="dark"
        onRangeChange={onRangeChange}
      >
        <Probe />
        <VisitsOverTime />
      </DynaliticsProvider>,
    );
    const root = mounted.container;
    const read = (name: string): string => q(root, `[data-${name}]`)?.textContent ?? '';
    await settleReact();
    expect(read('status')).toBe('ready');
    expect(read('range')).toBe('7d');
    expect(read('ranges')).toBe('24h,7d,30d,90d');
    expect(read('updated')).toBe('set'); // the hero reported its generation time
    expect(read('dark')).toBe('true');
    const metaCalls = (): number => f.calls.filter((c) => c.url.endsWith('/api/meta')).length;
    const before = metaCalls();
    await click(q(root, '[data-refresh]'));
    await settleReact();
    expect(metaCalls()).toBe(before + 1);
    await click(q(root, '[data-30d]'));
    await settleReact();
    expect(read('range')).toBe('30d');
    expect(onRangeChange).toHaveBeenCalledWith('30d');
    expect(text(q(root, '.p-hero .dy-eyebrow'))).toBe('No. 1 · LAST 30 DAYS');
  });

  test('reports an error status when /api/meta fails', async () => {
    mounted = await mountReact(
      <DynaliticsProvider endpoint="/s/x" fetch={mockFetch('meta-forbidden')}>
        <Probe />
      </DynaliticsProvider>,
    );
    await settleReact();
    expect(q(mounted.container, '[data-status]')?.textContent).toBe('error');
  });
});

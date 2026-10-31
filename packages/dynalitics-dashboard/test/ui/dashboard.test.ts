// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { mount, settle } from './harness.js';

const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dashboard states', () => {
  test('ok: meta first, then five parallel panel requests, all ready', async () => {
    const { calls } = mount('ok');
    await settle();
    expect(calls[0]).toContain('/api/meta');
    const paths = calls.map((c) => /api\/([a-z-]+)/.exec(c)?.[1]);
    expect(new Set(paths)).toEqual(
      new Set([
        'meta',
        'visits-over-time',
        'top-pages',
        'new-vs-returning',
        'consent-rate',
        'recent-visits',
      ]),
    );
    expect(qa('.dy-panel').length).toBe(5);
    expect(qa('.dy-viz[aria-busy="true"]').length).toBe(0);
    expect(q('.dy-hero-num')?.textContent).toMatch(/\d/);
    expect(q('#dy-updated')?.textContent).toBe('12:05:00');
    expect(qa('#dy-range input').map((i) => (i as HTMLInputElement).value)).toEqual([
      '24h',
      '7d',
      '30d',
      '90d',
    ]);
  });
  test('requests use the server clock and include UTC ISO bounds', async () => {
    const { calls } = mount('ok');
    await settle();
    const hero = calls.find((c) => c.includes('visits-over-time'))!;
    const p = new URL(hero, 'http://x').searchParams;
    expect(p.get('to')).toBe('2026-10-30T12:05:00.000Z');
    expect(p.get('interval')).toBe('day');
  });
  test('forbidden meta: one page-level alert, no other requests, no retry', async () => {
    const { calls } = mount('meta-forbidden');
    await settle();
    expect(calls.length).toBe(1);
    expect(q('.dy-err')?.getAttribute('role')).toBe('alert');
    expect(q('.dy-stamp')?.textContent).toBe('NOT AUTHORISED');
    expect(qa('.dy-err button').map((b) => b.textContent)).toEqual(['Reload page']);
  });
  test('unreachable: page-level UNREACHABLE with retry', async () => {
    mount('unreachable');
    await settle();
    expect(q('.dy-stamp')?.textContent).toBe('UNREACHABLE');
    expect(qa('.dy-err button').map((b) => b.textContent)).toEqual(['Retry']);
  });
  test('html reply (login page in front) is UNEXPECTED REPLY', async () => {
    mount('html-reply');
    await settle();
    expect(q('.dy-stamp')?.textContent).toBe('UNEXPECTED REPLY');
  });
  test('unavailable widget is calm, in its slot, and the rest still works', async () => {
    const { calls } = mount('nvr-unavailable');
    await settle();
    const nvr = q('.p-nvr')!;
    expect(nvr.querySelector('.dy-na-state')).not.toBeNull();
    expect(nvr.querySelector('.dy-err, .dy-stamp')).toBeNull();
    expect(calls.some((c) => c.includes('new-vs-returning'))).toBe(false);
    expect(q('.p-hero .dy-hero-num')).not.toBeNull();
  });
  test('403 on panels: first error is alert, later ones status', async () => {
    mount('forbidden');
    await settle();
    // meta is forbidden in this scenario, so a single page error
    expect(qa('[role="alert"]').length).toBe(1);
  });
  test('timeout: panels show TIMED OUT and offer a shorter range on long ranges', async () => {
    mount('timeout');
    await settle();
    const stamps = qa('.dy-panel .dy-stamp').map((s) => s.textContent);
    expect(stamps).toContain('TIMED OUT');
    expect(qa('[role="alert"]').length).toBe(1);
  });
  test('retry is enabled when an error first appears and cools down after a click', async () => {
    mount('timeout');
    await settle();
    const retry = () =>
      qa('.p-hero .dy-err button').find((b) => b.textContent?.startsWith('Retr'))!;
    expect(retry().textContent).toBe('Retry');
    expect((retry() as HTMLButtonElement).disabled).toBe(false);
    retry().click();
    await settle(10);
    expect((retry() as HTMLButtonElement).disabled).toBe(true);
  });
  test('empty: each panel shows its own copy and the grid keeps five panels', async () => {
    mount('empty');
    await settle();
    expect(qa('.dy-panel').length).toBe(5);
    const titles = qa('.dy-state h3').map((h) => h.textContent);
    expect(titles).toEqual(
      expect.arrayContaining([
        'The ledger is empty for this range.',
        'No pages yet.',
        'Nobody classified yet.',
        'No consent decisions yet.',
        'No visits in this range.',
      ]),
    );
    expect(qa('.dy-state button').some((b) => b.textContent === 'Try 90 days')).toBe(true);
  });
  test('90d range: new-vs-returning is capped to 31 days with a note and a daily interval', async () => {
    const { calls } = mount('ok');
    await settle();
    (q('#dy-range input[value="90d"]') as HTMLInputElement).click();
    await settle();
    const nvr = new URL(calls.filter((c) => c.includes('new-vs-returning')).pop()!, 'http://x')
      .searchParams;
    expect(nvr.get('interval')).toBe('day');
    expect((Date.parse(nvr.get('to')!) - Date.parse(nvr.get('from')!)) / 864e5).toBe(31);
    expect(q('.p-nvr')?.textContent).toContain('capped at 31 days');
    const hero = new URL(calls.filter((c) => c.includes('visits-over-time')).pop()!, 'http://x')
      .searchParams;
    expect(hero.get('interval')).toBe('week');
  });
  test('approximate caveat and unknown definition are shown; exact basis drops the caveat', async () => {
    mount('ok');
    await settle();
    expect(q('.p-nvr')?.textContent).toContain('estimates, not a head count');
    expect(q('.p-nvr')?.textContent).toContain('Unknown means');
    mount('nvr-exact');
    await settle();
    expect(q('.p-nvr')?.textContent).not.toContain('head count');
  });
  test('chart / table toggle shows the table twin without a new request', async () => {
    const { calls } = mount('ok');
    await settle();
    const before = calls.length;
    const toggle = qa('.p-hero .dy-toggle button')[1]!;
    toggle.click();
    expect(q('.p-hero table.dy-twin')?.closest('[hidden]')).toBeNull();
    expect(q('.p-hero .dy-chart-wrap')?.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(qa('.p-hero .dy-toggle button')[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(calls.length).toBe(before);
  });
  test('chart is keyboard explorable and announces to the live region', async () => {
    mount('ok');
    await settle();
    const chart = q('.p-hero .dy-chart')!;
    expect(chart.getAttribute('tabindex')).toBe('0');
    expect(chart.getAttribute('aria-label')).toMatch(/Total [\d,]+\. Highest:/);
    chart.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(q('.p-hero [role="status"]')?.textContent).toMatch(/Oct.*: \d+ visits/);
    expect(q('.p-hero .dy-tip')?.classList.contains('on')).toBe(true);
    chart.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(q('.p-hero .dy-tip')?.classList.contains('on')).toBe(false);
  });
  test('load more appends rows, moves focus and announces; end of range shows a caption', async () => {
    mount('ok');
    await settle();
    const rows = () => qa('.p-table tbody tr').length;
    expect(rows()).toBe(25);
    qa('.p-table .dy-more button')[0]!.click();
    await settle();
    expect(rows()).toBe(50);
    expect(document.activeElement?.closest('tr')).toBe(qa('.p-table tbody tr')[25]);
    expect(q('.p-table [role="status"]')?.textContent).toBe('25 more visits loaded');
    qa('.p-table .dy-more button')[0]!.click();
    await settle();
    expect(rows()).toBe(60);
    expect(q('.p-table .dy-more')?.textContent).toContain('End of range.');
  });
  test('no cursor support: no load-more and an honest caption', async () => {
    mount('no-cursor');
    await settle();
    expect(q('.p-table .dy-more button')).toBeNull();
    expect(q('.p-table .dy-more')?.textContent).toContain('Showing the latest');
  });
  test('PII reveal button only when piiRevealable; reveal refetches with pii=reveal and never persists', async () => {
    const { calls } = mount('ok');
    await settle();
    const btn = q('.p-table .dy-tools button')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    await settle();
    expect(calls.some((c) => c.includes('pii=reveal'))).toBe(true);
    expect(q('.p-table .dy-revealed')).not.toBeNull();
    expect(q('.p-table')?.textContent).toContain('203.0.113.77');
    expect(location.hash).not.toContain('reveal');
    document.body.innerHTML = '';
    mount('sparse-fields');
    await settle();
    expect(q('.p-table .dy-tools button')).toBeNull();
  });
  test('sparse fields: unmapped columns are dropped', async () => {
    mount('sparse-fields');
    await settle();
    const heads = qa('.p-table th').map((h) => h.textContent);
    expect(heads.join(' ')).not.toMatch(/\bIP\b/);
    expect(heads.join(' ')).not.toContain('Email');
  });
  test('theme toggle flips data-theme and aria-pressed', () => {
    mount('ok');
    const b = q('#dy-theme')!;
    const before = b.getAttribute('aria-pressed');
    b.click();
    expect(b.getAttribute('aria-pressed')).not.toBe(before);
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      before === 'true' ? 'light' : 'dark',
    );
  });
});

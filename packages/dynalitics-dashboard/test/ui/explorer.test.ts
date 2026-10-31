// @vitest-environment jsdom
// docs/DESIGN.md 14: the explorer view of the HTML dashboard, against the typed mock API.
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addClause,
  ANY_VALUE,
  explorerFromHash,
  explorerHash,
  tailOf,
  zoomInto,
} from '../../src/ui/explorer/state.js';
import { makeMeta, HOSTILE_PAGES } from '../fixtures/api.js';
import { mount, settle } from './harness.js';

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const n = document.querySelector<T>(sel);
  if (!n) throw new Error(`missing ${sel}`);
  return n;
};
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
const apiCalls = (calls: string[], route: string) =>
  calls.filter((c) => new URL(c, 'http://x').pathname.endsWith(`/api/${route}`));
const paramOf = (call: string, key: string) => new URL(call, 'http://x').searchParams.get(key);

async function search(q: string): Promise<void> {
  $<HTMLInputElement>('#dy-q').value = q;
  $<HTMLFormElement>('form.dy-query').requestSubmit();
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('pure state helpers', () => {
  const meta = makeMeta('ok');

  test('hash round trip keeps q, split and tail; unknown values are dropped', () => {
    const s = { q: 'pricing -consent:false "a b"', split: 'plan', tail: 15 as const, zoom: null };
    const hash = explorerHash('7d', s);
    expect(hash).toMatch(/^#view=explorer&range=7d&q=/);
    expect(explorerFromHash(hash, meta)).toEqual(s);
    expect(explorerFromHash('#view=explorer&split=email&tail=1', meta)).toEqual({
      q: '',
      split: null,
      tail: 0,
      zoom: null,
    });
    expect(explorerFromHash('#view=explorer&q=%E0%A4%A', meta).q).toBe(''); // malformed escape
  });

  test('tail choices respect tailMinIntervalMs', () => {
    expect(tailOf(5, meta)).toBe(5);
    const slow = {
      ...meta,
      explorer: {
        ...meta.explorer!,
        limits: { ...meta.explorer!.limits, tailMinIntervalMs: 15000 },
      },
    };
    expect(tailOf(5, slow)).toBe(0);
    expect(tailOf(30, slow)).toBe(30);
  });

  test('addClause quotes what needs quoting and refuses a value with a double quote', () => {
    expect(addClause('', 'plan', 'pro', false)).toBe('plan:pro');
    expect(addClause('x', 'page', '/a b', true)).toBe('x -page:"/a b"');
    expect(addClause('', 'plan', '*', false)).toBe('plan:"*"'); // a literal star value
    expect(addClause('', 'plan', ANY_VALUE, true)).toBe('-plan:*');
    expect(addClause('plan:pro', 'plan', 'pro', false)).toBe('plan:pro'); // not added twice
    expect(addClause('', 'page', 'say "hi"', false)).toBeNull();
  });

  test('zoom: a day becomes its hours, an hour does not zoom, the window clips it', () => {
    const day = Date.parse('2026-10-29T00:00:00.000Z');
    const win = {
      from: '',
      to: '',
      fromMs: day + 3_600_000,
      toMs: day + 86_400_000 * 3,
      interval: 'day' as const,
    };
    expect(zoomInto(day, 'day', win)).toEqual({
      fromMs: day + 3_600_000,
      toMs: day + 86_400_000,
      interval: 'hour',
    });
    expect(zoomInto(day, 'hour', win)).toBeNull();
  });
});

describe('navigation', () => {
  test('Overview/Explorer buttons appear, switching writes the hash and clamps 90d to 30d', async () => {
    mount('ok');
    await settle();
    const nav = $$('#dy-views button');
    expect(nav.map((b) => b.textContent)).toEqual(['Overview', 'Explorer']);
    expect(nav[0]?.getAttribute('aria-current')).toBe('page');
    $<HTMLInputElement>('#dy-range input[value="90d"]').click();
    await settle();
    nav[1]?.click();
    await settle();
    expect(location.hash).toMatch(/^#view=explorer&range=30d/);
    expect($$('#dy-range input').map((i) => (i as HTMLInputElement).value)).toEqual([
      '24h',
      '7d',
      '30d',
    ]);
    expect($('.p-xhist')).toBeTruthy();
    expect($$('.p-hero')).toHaveLength(0);
    $$('#dy-views button')[0]?.click();
    await settle();
    expect(location.hash).toBe('#range=30d');
    expect($('.p-hero')).toBeTruthy();
  });

  test('no explorer button when the server switched it off', async () => {
    mount('explorer-off', undefined, '#view=explorer');
    await settle();
    expect($('#dy-views').hidden).toBe(true);
    expect($('.p-hero')).toBeTruthy();
  });
});

describe('search', () => {
  test('a shared hash restores the query and every panel requests with it', async () => {
    const { calls } = mount('ok', undefined, '#view=explorer&range=7d&q=pricing&split=plan');
    await settle();
    expect($<HTMLInputElement>('#dy-q').value).toBe('pricing');
    for (const route of ['search', 'search/histogram', 'search/fields']) {
      const last = apiCalls(calls, route).at(-1)!;
      expect(paramOf(last, 'q'), route).toBe('pricing');
    }
    expect(paramOf(apiCalls(calls, 'search/histogram').at(-1)!, 'split')).toBe('plan');
    expect($('.dy-xmatched').textContent).toMatch(/^\d+ match(es)?$/);
    expect($$('.p-xresults tbody tr').length).toBeGreaterThan(0);
  });

  test('a refused query shows the fixed message and marks the position; panels keep their data', async () => {
    mount('ok', undefined, '#view=explorer');
    await settle();
    const rowsBefore = $$('.p-xresults tbody tr').length;
    expect(rowsBefore).toBeGreaterThan(0);
    await search('pricing email:x');
    const err = $('#dy-q-err');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('Unknown field, or a field that cannot be searched.');
    expect($('.dy-q-at').textContent).toBe('e');
    expect($('#dy-q').getAttribute('aria-invalid')).toBe('true');
    expect($$('.p-xresults tbody tr')).toHaveLength(rowsBefore);
    expect($$('.p-xresults .dy-err')).toHaveLength(0);
    await search('pricing');
    expect(err.hidden).toBe(true);
  });

  test('no matches is a calm empty state', async () => {
    mount('ok', undefined, '#view=explorer');
    await settle();
    await search('zzz');
    expect($('.p-xresults').textContent).toContain('No visits match this search.');
    expect($('.dy-xmatched').textContent).toBe('0 matches');
  });

  test('clicking a field value adds it to the query; minus excludes; No value excludes rows that have one', async () => {
    const { calls } = mount('ok', undefined, '#view=explorer');
    await settle();
    const first = $$('.p-xfields .dy-xval-add')[0]!;
    first.click();
    await settle();
    expect($<HTMLInputElement>('#dy-q').value).toMatch(/^page:/);
    $$('.p-xfields .dy-xval-drop')
      .find((b) => b.getAttribute('aria-label') === 'Exclude consent = false')
      ?.click();
    await settle();
    expect($<HTMLInputElement>('#dy-q').value).toMatch(/ -consent:false$/);
    $$('.p-xfields .dy-xval-add')
      .find((b) => b.getAttribute('aria-label') === 'Only visits without a plan value')
      ?.click();
    await settle();
    expect($<HTMLInputElement>('#dy-q').value).toMatch(/ -plan:\*$/);
    expect(paramOf(apiCalls(calls, 'search').at(-1)!, 'q')).toMatch(/-plan:\*$/);
    expect(location.hash).toContain(encodeURIComponent('-plan:*'));
  });

  test('hostile values are text, and a value with a double quote offers no buttons', async () => {
    mount('hostile', undefined, '#view=explorer');
    await settle();
    expect(document.querySelector('.p-xfields script, .p-xfields img, .p-xresults img')).toBeNull();
    const shown = $$('.p-xfields .dy-xval-v').map((n) => n.textContent);
    expect(shown.some((t) => HOSTILE_PAGES.includes(t ?? ''))).toBe(true);
    for (const li of $$('.p-xfields .dy-xval')) {
      const v = li.querySelector('.dy-xval-v')?.textContent ?? '';
      if (v.includes('"')) expect(li.querySelector('button')).toBeNull();
    }
  });

  test('split by re-requests only the histogram', async () => {
    const { calls } = mount('ok', undefined, '#view=explorer');
    await settle();
    const before = calls.length;
    const sel = $$('.dy-xctl select')[0] as HTMLSelectElement;
    sel.value = 'consent';
    sel.dispatchEvent(new Event('change'));
    await settle();
    const after = calls.slice(before).filter((c) => c.includes('/api/search'));
    expect(after.map((c) => new URL(c, 'http://x').pathname)).toEqual([
      '/s/x/api/search/histogram',
    ]);
    expect(paramOf(after[0]!, 'split')).toBe('consent');
    expect(location.hash).toContain('split=consent');
  });
});

describe('live tail', () => {
  test('polls at the chosen interval, pauses while hidden, never below the minimum', async () => {
    const { calls } = mount('ok', undefined, '#view=explorer&tail=5');
    await settle();
    const live = $$('.dy-xctl select')[1] as HTMLSelectElement;
    expect([...live.options].map((o) => o.value)).toEqual(['0', '5', '15', '30']);
    expect(live.value).toBe('5');
    const count = () => apiCalls(calls, 'search').length;
    const before = count();
    await new Promise((r) => setTimeout(r, 5300));
    await settle();
    expect(count()).toBe(before + 1);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await new Promise((r) => setTimeout(r, 5300));
    expect(count()).toBe(before + 1);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    live.value = '0';
    live.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 5300));
    expect(count()).toBe(before + 1);
  }, 20_000);
});

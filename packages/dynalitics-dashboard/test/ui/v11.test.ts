// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { createApi } from '../../src/ui/api.js';
import { drawStackedAreas, ellipsize } from '../../src/ui/charts/stacked-area.js';
import { buildSplit } from '../../src/ui/panels/hero-split.js';
import { windowLabel, rangeByKey } from '../../src/ui/ranges.js';
import { errorBlock, unavailableBlock } from '../../src/ui/states.js';
import type { BreakdownSeries } from '../../src/protocol.js';
import { mount, settle } from './harness.js';

const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const pts = (...v: number[]) =>
  v.map((visits, i) => ({ bucket: `2026-10-0${i + 1}T00:00:00.000Z`, visits }));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('D10 redirects and SSO', () => {
  test('requests are made with redirect: manual and an opaque redirect is UNEXPECTED REPLY', async () => {
    let init: RequestInit | undefined;
    const opaque = {
      ok: false,
      status: 0,
      type: 'opaqueredirect',
      redirected: false,
      json: () => Promise.reject(new Error('x')),
    } as unknown as Response;
    const api = createApi('', (_u, i) => {
      init = i;
      return Promise.resolve(opaque);
    });
    expect(await api.get('meta', {})).toMatchObject({
      kind: 'error',
      failure: { kind: 'unexpected' },
    });
    expect(init?.redirect).toBe('manual');
  });
  test('first /api/meta network failure adds the single sign-on sentence; panel errors do not', async () => {
    mount('unreachable');
    await settle();
    expect(q('.dy-err')?.textContent).toContain('single sign-on, your sign-in may have expired');
    const noHint = errorBlock(
      { kind: 'unreachable', status: 0 },
      {
        role: 'status',
        cooldownLeftMs: 0,
        onRetry: () => {},
        onReload: () => {},
        onTrySevenDays: null,
      },
    );
    expect(noHint.textContent).not.toContain('single sign-on, your sign-in');
  });
  test('unexpected-reply copy mentions redirects and single sign-on', () => {
    const node = errorBlock(
      { kind: 'unexpected', status: 200 },
      {
        role: 'status',
        cooldownLeftMs: 0,
        onRetry: () => {},
        onReload: () => {},
        onTrySevenDays: null,
      },
    );
    expect(node.textContent).toContain('redirected somewhere else');
  });
});

describe('D11 accessibility details', () => {
  test('theme button has one constant label and aria-pressed', () => {
    mount('ok');
    const b = q('#dy-theme')!;
    expect(b.textContent).toBe('Dark theme');
    b.click();
    expect(b.textContent).toBe('Dark theme');
  });
  test('charts are described by a hint and carry a reserved visible caption', async () => {
    mount('ok');
    await settle();
    const chart = q('.p-hero .dy-chart')!;
    const hint = document.getElementById(chart.getAttribute('aria-describedby')!);
    expect(hint?.textContent).toContain('left and right arrow keys');
    expect(q('.p-hero .dy-kbd-hint')?.textContent).toBe('← → explore · Esc close');
    expect(q('.p-hero .dy-kbd-hint')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('D6 unavailable block', () => {
  test('calm block: dashed label, panel title, verbatim message, reason line, status role, no actions', async () => {
    mount('nvr-unavailable');
    await settle();
    const block = q('.p-nvr .dy-na-state')!;
    expect(block.getAttribute('role')).toBe('status');
    expect(block.querySelector('.dy-na-label')?.textContent).toBe('Not available');
    expect(block.querySelector('h3')?.textContent).toBe("New vs returning isn't available here.");
    expect(block.querySelector('.dy-ref')?.textContent).toBe('reason: identity_not_reliable');
    expect(block.querySelectorAll('button, svg').length).toBe(0);
    expect(q('.p-nvr .dy-eyebrow')?.textContent).toMatch(/^No\. 3 · LAST 7 DAYS$/);
    expect(q('.p-table')?.textContent).not.toContain('First visit');
  });
  test('hostile panel title and message stay text', () => {
    const node = unavailableBlock({ reason: 'disabled_by_host', message: '<b>x</b>' }, '<i>T</i>');
    expect(node.querySelector('b, i')).toBeNull();
  });
});

describe('D1 new vs returning window', () => {
  test('eyebrow names the window in every state; hero eyebrow names the range', async () => {
    mount('ok');
    await settle();
    expect(q('.p-hero .dy-eyebrow')?.textContent).toBe('No. 1 · LAST 7 DAYS');
    expect(q('.p-nvr .dy-eyebrow')?.textContent).toBe('No. 3 · LAST 7 DAYS');
    (q('#dy-range input[value="90d"]') as HTMLInputElement).click();
    await settle();
    expect(q('.p-hero .dy-eyebrow')?.textContent).toBe('No. 1 · LAST 90 DAYS');
    expect(q('.p-nvr .dy-eyebrow')?.textContent).toBe('No. 3 · LAST 31 DAYS');
  });
  test('capped window is named in the caption, chart label and live summary', async () => {
    mount('ok');
    await settle();
    (q('#dy-range input[value="90d"]') as HTMLInputElement).click();
    await settle();
    expect(q('.p-nvr .dy-chart')?.getAttribute('aria-label')).toMatch(/Window: last 31 days\.$/);
    expect(q('.p-nvr table caption')?.textContent).toBe(
      'New vs returning visits per day, last 31 days (UTC)',
    );
    expect(q('.p-nvr [role="status"]')?.textContent).toContain(
      'New vs returning loaded (last 31 days)',
    );
  });
  test('empty capped panel keeps the cap note below the empty block', async () => {
    mount('empty');
    await settle();
    (q('#dy-range input[value="90d"]') as HTMLInputElement).click();
    await settle();
    expect(q('.p-nvr .dy-state h3')?.textContent).toBe('Nobody classified yet.');
    expect(q('.p-nvr .dy-state .dy-note')?.textContent).toContain('capped at 31 days');
  });
  test('cap wording and labels, including a cap of one day', () => {
    expect(windowLabel(rangeByKey('7d')!, 31)).toMatchObject({
      capped: false,
      upper: 'LAST 7 DAYS',
    });
    expect(windowLabel(rangeByKey('30d')!, 14)).toMatchObject({
      capped: true,
      upper: 'LAST 14 DAYS',
    });
    expect(windowLabel(rangeByKey('7d')!, 1)).toMatchObject({ capped: true, lower: 'last day' });
  });
  test('a 400 on the clamped panel means stale meta: Reload page, never Try 7 days', () => {
    const node = errorBlock(
      { kind: 'bad_request', status: 400, code: 'range_too_large' },
      {
        role: 'status',
        cooldownLeftMs: 0,
        onRetry: () => {},
        onReload: () => {},
        onTrySevenDays: () => {},
        reloadOnBadRequest: true,
      },
    );
    expect([...node.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Reload page']);
  });
  test('ESTIMATE tag only when the data is approximate', async () => {
    mount('ok');
    await settle();
    expect(q('.p-nvr .dy-estimate')?.textContent).toBe('Estimate');
    mount('nvr-exact');
    await settle();
    expect(q('.p-nvr .dy-estimate')).toBeNull();
  });
});

describe('D3 / D2 copy and user id', () => {
  test('consent sub-line is the v1.1 wording', async () => {
    mount('ok');
    await settle();
    expect(q('.p-consent .dy-kpi-sub')?.textContent).toMatch(
      /^[\d,]+ visits declined\. Declined visits store only the page and the time\. No IP, user id, name or email is kept, and they are never counted as new or returning\.$/,
    );
  });
  test('user id is shown as the server sent it (masked) and unmasked only after reveal; header carries (masked)', async () => {
    mount('ok');
    await settle();
    expect(q('.p-table .c-user .dy-t2')?.textContent).toMatch(/^u_\*\*\*\d+$/);
    expect(q('.p-table th.c-user')?.textContent).toContain('(masked)');
    q('.p-table .dy-tools button')!.click();
    await settle();
    expect(q('.p-table .c-user .dy-t2')?.textContent).toMatch(/^u_\d+$/);
    expect(q('.p-table th.c-user')?.textContent).not.toContain('(masked)');
  });
  test('only userId mapped: the column is "User ID" and shows the id as its main line', async () => {
    mount('sparse-fields');
    await settle();
    expect(q('.p-table th.c-user')?.textContent).toContain('User ID');
    expect(q('.p-table th.c-user')?.textContent).not.toContain('Username');
    const cell = qa('.p-table td.c-user')[0]!;
    expect(cell.querySelector('.dy-t2')).toBeNull();
    expect(cell.textContent).toMatch(/u_\*\*\*\d+|not provided/);
  });
});

describe('D4 split by', () => {
  const series = (
    over: Partial<BreakdownSeries> & { value: string | null },
    ...v: number[]
  ): BreakdownSeries => ({ isOther: false, points: pts(...v), ...over });

  test('server order is stack order; first five named values get cat1..5; the rest fold into Other', () => {
    const named = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((value, i) =>
      series({ value }, i + 1, i + 1),
    );
    const out = buildSplit('plan', [
      ...named,
      series({ value: null }, 1, 1),
      series({ value: null, isOther: true }, 2, 2),
    ]);
    expect(out.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'No value', 'Other']);
    expect(out.slice(0, 5).map((s) => s.swatch)).toEqual(['cat1', 'cat2', 'cat3', 'cat4', 'cat5']);
    expect(out.at(-1)?.values).toEqual([2 + 6 + 7, 2 + 6 + 7]);
    expect(new Set(out.map((s) => s.swatch)).size).toBe(out.length);
  });
  test('spill creates Other when the server sent none; consent maps to solid/hatched; no value is dotted with a neutral note', () => {
    const out = buildSplit(
      'plan',
      ['a', 'b', 'c', 'd', 'e', 'f'].map((value) => series({ value }, 1)),
    );
    expect(out.at(-1)).toMatchObject({ name: 'Other', fill: 'f-other', labelClass: null });
    const consent = buildSplit('consent', [
      series({ value: 'true' }, 1),
      series({ value: 'false' }, 1),
      series({ value: null }, 1),
    ]);
    expect(consent.map((s) => [s.name, s.fill])).toEqual([
      ['Granted', 'f-granted'],
      ['Declined', 'f-declined'],
      ['No value', 'f-none'],
    ]);
    expect(consent[2]?.note).toBe('Rows without a value for this field.');
    expect(consent[2]?.note).not.toMatch(/denied|declined/i);
  });
  test('direct labels: only solid bands >= 20 px tall, at the last complete bucket, ellipsised', () => {
    const fx = () => (xs: readonly number[]) => xs.map((x) => ({ x, text: 'x' }));
    const result = drawStackedAreas(600, 400, {
      series: [
        {
          fill: 'f-cat1',
          labelClass: 'on-cat1',
          label: 'a-very-long-series-name',
          values: [100, 100, 100],
        },
        { fill: 'f-cat2', labelClass: 'on-cat2', label: 'thin', values: [1, 1, 1] },
        { fill: 'f-other', labelClass: null, label: 'Other', values: [100, 100, 100] },
      ],
      xLabels: fx(),
      compact: String,
      labelIndex: 1,
    });
    const labels = [...result.svg.querySelectorAll('text.band-label')];
    expect(labels.map((l) => l.textContent)).toEqual(['a-very-long…']);
    expect(labels[0]?.getAttribute('class')).toContain('on-cat1');
    expect(ellipsize('short')).toBe('short');
    expect([...ellipsize('x'.repeat(30))].length).toBe(12);
  });
  test('split select is shown from meta.breakdowns; choosing consent refetches only the hero with breakdown', async () => {
    const { calls } = mount('ok');
    await settle();
    const select = q('.p-hero select')!;
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'None',
      'consent',
      'plan',
    ]);
    const before = calls.length;
    (select as HTMLSelectElement).value = 'consent';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)).toContain('breakdown=consent');
    expect(q('.p-hero svg polygon.f-granted')).not.toBeNull();
    const legendItems = qa('.p-hero .dy-legend li').map(
      (li) => li.textContent?.trim().split(' ')[0],
    );
    expect(legendItems).toEqual(['Declined', 'Granted']); // top to bottom = reverse stack order
    const heads = qa('.p-hero table.dy-twin th[scope="col"]').map((h) => h.textContent);
    expect(heads).toEqual(['Period (UTC)', 'Visits', 'Declined', 'Granted']);
    expect(q('.p-hero .dy-chart')?.getAttribute('aria-label')).toContain(
      'Split by consent: Declined',
    );
  });
  test('plan split: legend explains "No value" without mentioning denied consent', async () => {
    mount('ok');
    await settle();
    const select = q('.p-hero select') as HTMLSelectElement;
    select.value = 'plan';
    select.dispatchEvent(new Event('change'));
    await settle();
    const noValue = qa('.p-hero .dy-legend li').find((li) => li.textContent?.includes('No value'))!;
    expect(noValue.getAttribute('title')).toBe('Rows without a value for this field.');
    expect(noValue.textContent).not.toMatch(/denied/i);
    expect(qa('.p-hero .dy-legend .dy-sw').length).toBe(7);
  });
  test('without breakdowns in meta there is no split control', async () => {
    mount(
      'ok',
      (f) => (input, init) =>
        input.includes('/api/meta')
          ? f(input, init).then(async (r) => {
              const body = (await r.json()) as { data: { breakdowns: unknown[] } };
              body.data.breakdowns = [];
              return new Response(JSON.stringify(body));
            })
          : f(input, init),
    );
    await settle();
    expect(q('.p-hero select')).toBeNull();
  });
});

describe('D7 hero numeral in the DOM', () => {
  test('with no usable measurement (jsdom has no layout) the numeral is stacked, never overlapping', async () => {
    mount('ok');
    await settle();
    expect(q('.p-hero .dy-hero-wrap')?.classList.contains('dy-hero--stacked')).toBe(true);
  });
});

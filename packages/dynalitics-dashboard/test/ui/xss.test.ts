// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest';
import { errorBlock, unavailableBlock } from '../../src/ui/states.js';
import { createFormatters } from '../../src/ui/format.js';
import { columnsFor, headerRow, visitRow } from '../../src/ui/panels/visit-row.js';
import { HOSTILE_PAGES, makeMeta } from '../fixtures/api.js';
import { mount, settle } from './harness.js';

const f = createFormatters('en-GB');

/** CSSOM writes serialise to a style attribute; they may only ever hold our own numbers. */
const NUMERIC_STYLE =
  /^(?:\s*(?:--[\w-]+|flex-grow|transform|--h|--w|--r|--i|--n):\s*(?:-?[\d.]+(?:px|%)?|translate\([-\d.]+px, [-\d.]+px\));?)+\s*$/;

/** Nothing the visitor controls may become markup: no new elements, attributes or scripts. */
function expectInert(root: ParentNode): void {
  expect(
    root.querySelectorAll('img, script, iframe, object, embed, svg image, style, link, base')
      .length,
  ).toBe(0);
  const all = root.querySelectorAll('*');
  for (const node of all) {
    for (const attr of node.getAttributeNames()) {
      expect(attr.startsWith('on'), `${node.tagName} has ${attr}`).toBe(false);
      if (attr === 'style')
        expect(node.getAttribute('style'), `${node.tagName} style`).toMatch(NUMERIC_STYLE);
    }
  }
}

describe('hostile strings in table rows', () => {
  const columns = columnsFor(makeMeta('ok').fields);
  test.each(HOSTILE_PAGES.map((p) => [p.slice(0, 30), p]))(
    'page %s renders as exact text',
    (_n, page) => {
      const tr = visitRow(
        {
          id: '1',
          timestamp: '2026-10-30T12:00:00.000Z',
          pageVisited: page,
          consent: true,
          isFirstVisit: true,
          ipAddress: page,
          userId: page,
          username: page,
          email: page,
          custom: null,
        },
        columns,
        f,
      );
      expectInert(tr);
      const cell = tr.querySelector('.c-page');
      expect(cell?.textContent).toBe(page);
      expect(cell?.getAttribute('dir')).toBe('auto');
      expect(cell?.classList.contains('v')).toBe(true);
      expect(tr.querySelectorAll('a[href]').length).toBe(0);
    },
  );
  test('hostile timestamp falls back to text', () => {
    const tr = visitRow(
      {
        id: null,
        timestamp: '<img src=x onerror=1>',
        pageVisited: '/',
        consent: false,
        isFirstVisit: null,
        ipAddress: null,
        userId: null,
        username: null,
        email: null,
        custom: null,
      },
      columns,
      f,
    );
    expectInert(tr);
    expect(tr.textContent).toContain('<img src=x onerror=1>');
  });
  test('declined row has one merged not-collected cell and no dashes', () => {
    const tr = visitRow(
      {
        id: '2',
        timestamp: '2026-10-30T12:00:00.000Z',
        pageVisited: '/',
        consent: false,
        isFirstVisit: null,
        ipAddress: null,
        userId: null,
        username: null,
        email: null,
        custom: null,
      },
      columns,
      f,
    );
    const na = tr.querySelectorAll('td.na');
    expect(na.length).toBe(1);
    expect(na[0]?.getAttribute('colspan')).toBe(String(columns.filter((c) => c.pii).length));
    expect(tr.querySelector('.c-ip, .c-email, .c-user')).toBeNull();
  });
  test('granted row with null IP shows a dash with a text alternative', () => {
    const tr = visitRow(
      {
        id: '3',
        timestamp: '2026-10-30T12:00:00.000Z',
        pageVisited: '/',
        consent: true,
        isFirstVisit: null,
        ipAddress: null,
        userId: null,
        username: null,
        email: null,
        custom: null,
      },
      columns,
      f,
    );
    expect(tr.querySelector('.c-ip .vh')?.textContent).toBe('not provided');
  });
  test('header marks masked PII columns', () => {
    expect(headerRow(columns, true).querySelectorAll('.th-lock').length).toBe(
      columns.filter((c) => c.pii).length,
    );
    expect(headerRow(columns, false).querySelectorAll('.th-lock').length).toBe(0);
  });
  test('columns follow meta.fields', () => {
    const keys = columnsFor(makeMeta('sparse-fields').fields).map((c) => c.key);
    expect(keys).toContain('user');
    expect(keys).not.toContain('ip');
    expect(keys).not.toContain('email');
  });
});

describe('server text in blocks', () => {
  test('unavailable message is text, never markup', () => {
    const node = unavailableBlock(
      { reason: 'disabled_by_host', message: '<img src=x onerror=alert(1)> <b>bold</b>' },
      '<b>Title</b>',
    );
    expectInert(node);
    expect(node.querySelector('b')).toBeNull();
    expect(node.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  test('error block shows fixed copy and a hostile param only as text', () => {
    const node = errorBlock(
      { kind: 'bad_request', status: 400, code: 'invalid_parameter', param: '<script>x</script>' },
      {
        role: 'alert',
        cooldownLeftMs: 0,
        onRetry: () => {},
        onReload: () => {},
        onTrySevenDays: () => {},
      },
    );
    expectInert(node);
    expect(node.getAttribute('role')).toBe('alert');
  });
  test('403 offers reload but no retry; timeout offers 7 days and retry', () => {
    const labels = (n: HTMLElement) => [...n.querySelectorAll('button')].map((b) => b.textContent);
    const noop = {
      role: 'status' as const,
      cooldownLeftMs: 0,
      onRetry: () => {},
      onReload: () => {},
      onTrySevenDays: () => {},
    };
    expect(labels(errorBlock({ kind: 'forbidden', status: 403 }, noop))).toEqual(['Reload page']);
    expect(labels(errorBlock({ kind: 'timeout', status: 504 }, noop))).toEqual([
      'Try 7 days',
      'Retry',
    ]);
    expect(
      labels(errorBlock({ kind: 'unreachable', status: 0 }, { ...noop, cooldownLeftMs: 1000 })),
    ).toEqual(['Retrying...']);
  });
});

describe('whole page with hostile API data', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  test('top pages, table and tooltips contain only text', async () => {
    mount('hostile');
    await settle();
    const grid = document.getElementById('dy-grid')!;
    expect(grid.querySelectorAll('.dy-panel').length).toBe(5);
    expectInert(grid);
    const pages = [...grid.querySelectorAll('.dy-pages .dy-page.v')].map((n) => n.textContent);
    expect(pages).toContain('<img src=x onerror=alert(1)>');
    expect(pages).toContain('javascript:alert(document.domain)');
    expect(pages.some((p) => p?.length === 5001)).toBe(true);
    expect(grid.querySelectorAll('a').length).toBe(0);
    expect(grid.querySelectorAll('.dy-table td.c-page').length).toBeGreaterThan(0);
  });
});

// @vitest-environment jsdom
// docs/DESIGN.md 16: the country map in the HTML dashboard.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  MAX_ZOOM,
  canFilterByCountry,
  countryQuery,
  fitView,
  flagOf,
  fullView,
  listedRows,
  panView,
  safeShapes,
  shadeStep,
  viewBox,
  zoomView,
} from '../../src/ui/geo.js';
import { resetMapCache } from '../../src/ui/panels/countries.js';
import { makeMeta } from '../fixtures/api.js';
import { mount, settle } from './harness.js';

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const n = document.querySelector<T>(sel);
  if (!n) throw new Error(`missing ${sel}`);
  return n;
};
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
const route = (calls: string[], name: string) =>
  calls.filter((c) => new URL(c, 'http://x').pathname.endsWith(`/api/${name}`));

beforeEach(() => resetMapCache());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('pure parts', () => {
  test('flags from the letters, nothing for anything else', () => {
    expect(flagOf('ES')).toBe('🇪🇸');
    expect(flagOf('es')).toBe('');
    expect(flagOf('<b')).toBe('');
  });

  test('four shades relative to the busiest; 0 for none', () => {
    expect([0, 1, 25, 26, 50, 99, 100].map((v) => shadeStep(v, 100))).toEqual([
      0, 1, 1, 2, 2, 4, 4,
    ]);
  });

  test('explorer queries: a code, or "no stored value" for unknown', () => {
    expect(countryQuery('country', 'US')).toBe('country:US');
    expect(countryQuery('country', null)).toBe('-country:*');
  });

  test('a country is clickable only when the explorer is on and allows the field', () => {
    expect(canFilterByCountry(makeMeta('countries'))).toBe(true);
    expect(canFilterByCountry(makeMeta('countries-no-explorer'))).toBe(false);
    expect(canFilterByCountry(makeMeta('ok'))).toBe(false);
  });

  test('top 8, the selected one past the cut, unknown last', () => {
    const countries = 'ABCDEFGHIJ'.split('').map((l, i) => ({ code: `${l}A`, visits: 20 - i }));
    const data = { total: 200, countries, unknown: 45 };
    expect(listedRows(data).map((r) => r.code)).toEqual([
      'AA',
      'BA',
      'CA',
      'DA',
      'EA',
      'FA',
      'GA',
      'HA',
      null,
    ]);
    expect(listedRows(data, 'JA').map((r) => r.code)).toContain('JA');
  });

  test('hostile shapes are dropped before they reach the DOM', () => {
    const shapes = safeShapes({
      width: 10,
      height: 10,
      countries: [
        { code: 'ES', d: 'M1 2l3-4z' },
        { code: 'US', d: 'M0 0 url(javascript:alert(1))' },
        { code: 'x', d: 'M1 1z' },
      ],
    });
    expect(shapes.map((s) => s.code)).toEqual(['ES']);
  });

  test('zoom stays in range and the view inside the map; panning is clamped', () => {
    const map = { width: 1000, height: 500 };
    let v = fullView(map);
    expect(viewBox(map, v)).toBe('0 0 1000 500');
    for (let i = 0; i < 20; i++) v = zoomView(map, v, 2);
    expect(v.zoom).toBe(MAX_ZOOM);
    const corner = zoomView(map, fullView(map), 2, { x: 0, y: 0 });
    expect(viewBox(map, corner)).toBe('0 0 500 250');
    expect(panView(map, corner, 10_000, 10_000, 500)).toEqual(
      fitView(map, { zoom: 2, x: 0, y: 0 }),
    );
    expect(zoomView(map, corner, 0.01)).toEqual(fullView(map));
  });
});

describe('overview', () => {
  test('server without the map: no panel, no requests, table stays No. 5', async () => {
    const { calls } = mount('ok');
    await settle();
    expect(document.querySelector('.p-geo')).toBeNull();
    expect(route(calls, 'countries')).toEqual([]);
    expect(route(calls, 'world-map')).toEqual([]);
    expect($('.p-table .dy-eyebrow').textContent).toBe('No. 5');
  });

  test('the panel: shaded shapes, a ranked list with names and flags, recent visits become No. 6', async () => {
    const { calls } = mount('countries');
    await settle();
    const p = $('.p-geo');
    expect(p.querySelector('h2')?.textContent).toBe('Where visitors come from');
    expect(route(calls, 'countries')).toHaveLength(1);
    expect(route(calls, 'world-map')).toHaveLength(1);
    expect(p.querySelectorAll('.dy-geo-c').length).toBeGreaterThan(170);
    const spain = p.querySelector('.dy-geo-c[data-code="ES"]');
    expect(spain?.getAttribute('class')).toContain('dy-geo-s4');
    expect(spain?.querySelector('title')?.textContent).toMatch(/^Spain: [\d,]+ visits$/);
    expect(p.querySelector('.dy-geo-c[data-code="CN"]')).toBeNull(); // no visits: not interactive
    const rows = [...p.querySelectorAll('.dy-geo-row')];
    expect(rows[0]?.querySelector('.dy-geo-name')?.textContent).toBe('Spain');
    expect(rows[0]?.querySelector('.dy-geo-flag')?.textContent).toBe('🇪🇸');
    expect(rows.at(-1)?.querySelector('.dy-geo-name')?.textContent).toBe('Unknown country');
    expect(p.querySelector('.dy-geo-more')?.textContent).toBe('+ 2 more countries');
    expect($('.p-table .dy-eyebrow').textContent).toBe('No. 6');
  });

  test('the shapes are fetched once; a range change only refetches the counts', async () => {
    const { calls } = mount('countries');
    await settle();
    $$('#dy-range input')
      .find((i) => (i as HTMLInputElement).value === '30d')
      ?.click();
    await settle();
    expect(route(calls, 'countries')).toHaveLength(2);
    expect(route(calls, 'world-map')).toHaveLength(1);
  });

  test('zoom buttons change the viewBox; reset appears only when zoomed', async () => {
    mount('countries');
    await settle();
    const svg = $('.dy-geo-map');
    const before = svg.getAttribute('viewBox');
    const [zin, zout, reset] = $$('.dy-geo-zbtn') as HTMLButtonElement[];
    expect(zout?.disabled).toBe(true);
    expect(reset?.hidden).toBe(true);
    zin?.click();
    expect(svg.getAttribute('viewBox')).not.toBe(before);
    expect(reset?.hidden).toBe(false);
    reset?.click();
    expect(svg.getAttribute('viewBox')).toBe(before);
  });

  test('clicking a country (map or list) opens the explorer filtered to it', async () => {
    const { calls } = mount('countries');
    await settle();
    $('.dy-geo-c[data-code="US"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(location.hash).toContain('view=explorer');
    expect(decodeURIComponent(location.hash)).toContain('q=country:US');
    expect(route(calls, 'search').some((c) => c.includes('q=country%3AUS'))).toBe(true);
  });

  test('the unknown row opens the explorer with "no country stored"', async () => {
    mount('countries');
    await settle();
    $$('.dy-geo-row--unknown button')[0]?.click();
    await settle();
    expect(decodeURIComponent(location.hash)).toContain('q=-country:*');
  });

  test('keyboard: Enter on a shaded country opens the explorer', async () => {
    mount('countries');
    await settle();
    const de = $('.dy-geo-c[data-code="DE"]');
    expect(de.getAttribute('tabindex')).toBe('0');
    expect(de.getAttribute('role')).toBe('button');
    de.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(decodeURIComponent(location.hash)).toContain('q=country:DE');
  });

  test('without the explorer the map is read-only: no buttons, no tab stops', async () => {
    mount('countries-no-explorer');
    await settle();
    expect(document.querySelector('.p-geo')).not.toBeNull();
    expect(document.querySelector('.dy-geo-row button')).toBeNull();
    expect(document.querySelector('.dy-geo-c[tabindex]')).toBeNull();
    expect($('.dy-geo-hint').textContent).not.toContain('explorer');
  });
});

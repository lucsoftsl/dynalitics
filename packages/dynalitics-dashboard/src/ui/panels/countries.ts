import type { CountriesData, Unavailable, WorldMapData } from '../../protocol.js';
import type { ApiResult } from '../api.js';
import type { Ctx, Host } from '../context.js';
import { append, el, svg } from '../dom.js';
import { clamp01 } from '../format.js';
import {
  DRAG_THRESHOLD,
  MAX_ZOOM,
  MIN_ZOOM,
  WHEEL_ZOOM_SPEED,
  ZOOM_STEP,
  canFilterByCountry,
  countryLabel,
  countryQuery,
  flagOf,
  fullView,
  hiddenCount,
  listedRows,
  panView,
  pointAt,
  safeShapes,
  shadeStep,
  validMap,
  viewBox,
  zoomView,
  type ListedRow,
  type MapView,
} from '../geo.js';
import { createPanel, type Panel, type PanelSpec } from '../panel.js';
import { requestWindow } from '../request.js';
import { emptyBlock, skeletonChart } from '../states.js';

// "Where visitors come from" (docs/DESIGN.md section 16, SPEC section 21).

export interface CountriesView {
  readonly countries: CountriesData;
  readonly map: WorldMapData;
}

export const COUNTRIES_COPY = {
  title: 'Where visitors come from',
  hint: 'Stronger colour means more visits. Zoom with + and −, or pinch; drag to move.',
  hintFilter: 'Click a country to see its visits in the explorer.',
  unknown: 'Unknown country',
  more: (n: number) => `+ ${n} more ${n === 1 ? 'country' : 'countries'}`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Show the whole map',
  mapLabel: 'World map of visits by country',
  listLabel: 'Visits by country',
} as const;

export const COUNTRIES_EMPTY = {
  title: 'No visits in this range.',
  body: 'Countries appear once visits with a country code are recorded.',
} as const;

export function countriesAvailability(ctx: Ctx): Unavailable | null {
  const w = ctx.meta.widgets.countryMap;
  if (w === undefined)
    return { reason: 'disabled_by_host', message: 'The server does not offer the country map.' };
  return w.available ? null : { reason: w.reason, message: w.message };
}

export const countriesSummary = (d: CountriesView, ctx: Ctx): string =>
  `Countries loaded: ${d.countries.countries.length} countries, ${ctx.fmt.num(d.countries.total)} visits`;

/** The hint under the title: the filter sentence only when a click does something. */
export const countriesHint = (filter: boolean): string =>
  filter ? `${COUNTRIES_COPY.hint} ${COUNTRIES_COPY.hintFilter}` : COUNTRIES_COPY.hint;

/** The shapes never change: fetched once per page, only when the panel first loads. */
let mapCache: Promise<ApiResult<WorldMapData>> | null = null;

async function loadMap(ctx: Ctx, signal: AbortSignal): Promise<ApiResult<WorldMapData>> {
  if (!mapCache) {
    // Not tied to this request's signal: an aborted range change must not poison the cache.
    mapCache = ctx.api.get<WorldMapData>('world-map', {}).then((r) => {
      if (r.kind !== 'data' || !validMap(r.data)) mapCache = null;
      return r;
    });
  }
  const result = await mapCache;
  return signal.aborted ? { kind: 'aborted' } : result;
}

/** For tests: forget the cached shapes. */
export function resetMapCache(): void {
  mapCache = null;
}

export async function requestCountries(
  ctx: Ctx,
  signal: AbortSignal,
): Promise<ApiResult<CountriesView>> {
  const [map, countries] = await Promise.all([
    loadMap(ctx, signal),
    requestWindow<CountriesData>(ctx, 'countries', signal, (w) => ({ from: w.from, to: w.to })),
  ]);
  if (map.kind !== 'data') return map;
  if (!validMap(map.data)) return { kind: 'error', failure: { kind: 'unexpected', status: 200 } };
  if (countries.kind !== 'data') return countries;
  return { ...countries, data: { countries: countries.data, map: map.data } };
}

function zoomButtons(onZoom: (factor: number | null) => void): {
  box: HTMLElement;
  sync: (view: MapView) => void;
} {
  const box = el('div', 'dy-geo-zoom');
  const make = (text: string, label: string, factor: number | null): HTMLButtonElement => {
    const b = el('button', 'dy-geo-zbtn', text, {
      type: 'button',
      'aria-label': label,
      title: label,
    });
    b.addEventListener('click', () => onZoom(factor));
    return b;
  };
  const zin = make('+', COUNTRIES_COPY.zoomIn, ZOOM_STEP);
  const zout = make('−', COUNTRIES_COPY.zoomOut, 1 / ZOOM_STEP);
  const reset = make('⤢', COUNTRIES_COPY.zoomReset, null);
  append(box, zin, zout, reset);
  return {
    box,
    sync: (view) => {
      zin.disabled = view.zoom >= MAX_ZOOM;
      zout.disabled = view.zoom <= MIN_ZOOM;
      reset.hidden = view.zoom <= MIN_ZOOM;
    },
  };
}

function buildMap(
  data: CountriesView,
  ctx: Ctx,
  onPick: ((code: string) => void) | null,
): HTMLElement {
  const { map } = data;
  const byCode = new Map(data.countries.countries.map((c) => [c.code, c.visits]));
  const max = Math.max(1, ...data.countries.countries.map((c) => c.visits));
  let view = fullView(map);
  const frame = el('div', 'dy-geo-frame');
  const root = svg('svg', {
    class: 'dy-geo-map',
    viewBox: viewBox(map, view),
    role: 'group',
    'aria-label': COUNTRIES_COPY.mapLabel,
  });
  for (const shape of safeShapes(map)) {
    const visits = byCode.get(shape.code) ?? 0;
    const step = shadeStep(visits, max);
    const path = svg('path', { d: shape.d, class: `dy-geo-c dy-geo-s${step}` }, root);
    if (step === 0) continue;
    const label = countryLabel(ctx.fmt.country(shape.code), ctx.fmt.num(visits), visits === 1);
    svg('title', {}, path).textContent = label;
    path.dataset['code'] = shape.code;
    if (!onPick) continue;
    path.setAttribute('role', 'button');
    path.setAttribute('tabindex', '0');
    path.setAttribute('aria-label', label);
    path.classList.add('is-pickable');
    path.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onPick(shape.code);
    });
  }

  const zoom = zoomButtons((factor) =>
    setView(factor === null ? fullView(map) : zoomView(map, view, factor)),
  );
  function setView(next: MapView): void {
    view = next;
    root.setAttribute('viewBox', viewBox(map, view));
    frame.classList.toggle('is-zoomed', view.zoom > MIN_ZOOM);
    zoom.sync(view);
  }
  zoom.sync(view);

  // Pinch on a trackpad, or Ctrl/⌘ + wheel, zooms towards the pointer; a plain wheel keeps scrolling the page.
  root.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = root.getBoundingClientRect();
      const anchor = pointAt(
        map,
        view,
        (e.clientX - box.left) / box.width,
        (e.clientY - box.top) / box.height,
      );
      setView(zoomView(map, view, Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED), anchor));
    },
    { passive: false },
  );
  let drag: { x: number; y: number; view: MapView; moved: boolean } | null = null;
  let dragged = false;
  root.addEventListener('pointerdown', (e) => {
    dragged = false;
    if (view.zoom > MIN_ZOOM) drag = { x: e.clientX, y: e.clientY, view, moved: false };
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag = { ...drag, moved: true };
      dragged = true;
      root.setPointerCapture?.(e.pointerId);
    }
    setView(panView(map, drag.view, dx, dy, root.getBoundingClientRect().width));
  });
  const end = (): void => {
    drag = null;
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('dblclick', () => setView(zoomView(map, view, ZOOM_STEP)));
  if (onPick)
    root.addEventListener('click', (e) => {
      // Letting go after dragging the map across a country is not a click on it.
      if (dragged) return;
      const code = (e.target as Element | null)?.getAttribute?.('data-code');
      if (code) onPick(code);
    });

  append(frame, root, zoom.box);
  return frame;
}

function listRow(
  r: ListedRow,
  ctx: Ctx,
  max: number,
  onPick: ((code: string | null) => void) | null,
): HTMLElement {
  const name = r.code === null ? COUNTRIES_COPY.unknown : ctx.fmt.country(r.code);
  const li = el('li', `dy-geo-row${r.code === null ? ' dy-geo-row--unknown' : ''}`);
  const inner = onPick
    ? el('button', 'dy-geo-item', null, {
        type: 'button',
        'aria-label': `${countryLabel(name, ctx.fmt.num(r.visits), r.visits === 1)}. Open in the explorer`,
      })
    : el('span', 'dy-geo-item');
  if (onPick) inner.addEventListener('click', () => onPick(r.code));
  const bar = el('span', 'dy-bar', null, { 'aria-hidden': 'true' });
  bar.style.setProperty('--r', String(clamp01(r.visits / max)));
  append(
    inner,
    bar,
    el('span', 'dy-geo-flag', r.code === null ? '?' : flagOf(r.code), { 'aria-hidden': 'true' }),
    el('span', 'dy-geo-name', name),
    el('span', 'dy-count', ctx.fmt.num(r.visits)),
  );
  li.appendChild(inner);
  return li;
}

function buildReady(data: CountriesView, ctx: Ctx, host: Host): HTMLElement {
  const field = ctx.meta.countryMap?.field;
  const filter = field !== undefined && canFilterByCountry(ctx.meta);
  const pick = filter
    ? (code: string | null) => host.openExplorer(countryQuery(field, code))
    : null;
  const wrap = el('div', 'dy-geo');
  const { countries } = data;
  wrap.appendChild(
    el(
      'p',
      'dy-kpi-sub dy-geo-hint',
      filter ? `${COUNTRIES_COPY.hint} ${COUNTRIES_COPY.hintFilter}` : COUNTRIES_COPY.hint,
    ),
  );
  const listed = listedRows(countries);
  const max = Math.max(1, ...listed.map((r) => r.visits));
  const list = el('ol', 'dy-geo-list', null, { 'aria-label': COUNTRIES_COPY.listLabel });
  for (const r of listed) list.appendChild(listRow(r, ctx, max, pick));
  const hidden = hiddenCount(countries, listed);
  if (hidden > 0) list.appendChild(el('li', 'dy-geo-more', COUNTRIES_COPY.more(hidden)));
  const body = el('div', 'dy-geo-body');
  append(body, buildMap(data, ctx, pick), list);
  wrap.appendChild(body);
  return wrap;
}

export function createCountriesPanel(getCtx: () => Ctx, host: Host, no: number): Panel {
  const spec: PanelSpec<CountriesView> = {
    id: 'countries',
    no,
    title: COUNTRIES_COPY.title,
    className: 'p-geo',
    availability: countriesAvailability,
    request: (ctx, signal) => requestCountries(ctx, signal),
    isEmpty: (d) => d.countries.total === 0,
    skeleton: () => skeletonChart(240),
    empty: () => emptyBlock(COUNTRIES_EMPTY),
    ready: (data, ctx) => buildReady(data, ctx, host),
    summary: countriesSummary,
  };
  return createPanel(spec, getCtx, host);
}

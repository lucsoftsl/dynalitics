import type { CountriesData, CountryShape, MetaData, WorldMapData } from '../protocol.js';
import { addClause } from './explorer/state.js';

// The country map's pure parts (docs/DESIGN.md section 16, SPEC section 21), shared by the HTML page and React.

/** Darker = more visits, relative to the busiest country. Four steps, CSS classes `dy-geo-s1`..`dy-geo-s4`. */
export const SHADE_STEPS = 4;
export const MAX_LISTED = 8;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 12;
export const ZOOM_STEP = 1.6;
/** A pointer that moved less than this (px) was a click, not a drag. */
export const DRAG_THRESHOLD = 4;
export const WHEEL_ZOOM_SPEED = 0.01;

const CODE = /^[A-Z]{2}$/;
/** SPEC 21.4: path data is used only if it is made of M, l, z and integers. */
const PATH = /^[MlzZ0-9 -]*$/;
const REGIONAL_INDICATOR_OFFSET = 0x1f1e6 - 'A'.charCodeAt(0);

export const countryMapOn = (meta: MetaData): boolean =>
  meta.widgets.countryMap?.available === true && meta.countryMap !== undefined;

/** The explorer can filter by the geo field: it is on and the field is in its allow-list. */
export function canFilterByCountry(meta: MetaData): boolean {
  const field = meta.countryMap?.field;
  return (
    field !== undefined &&
    meta.widgets.explorer?.available === true &&
    meta.explorer?.fields.some((f) => f.key === field) === true
  );
}

/** `country:ES`, or `-country:*` (no stored value) for the unknown row. */
export function countryQuery(field: string, code: string | null): string {
  return code === null ? `-${field}:*` : (addClause('', field, code, false) ?? `${field}:${code}`);
}

export function flagOf(code: string): string {
  return CODE.test(code)
    ? String.fromCodePoint(...[...code].map((c) => c.charCodeAt(0) + REGIONAL_INDICATOR_OFFSET))
    : '';
}

/** 1..SHADE_STEPS; 0 for no visits. */
export function shadeStep(visits: number, max: number): number {
  if (visits <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(SHADE_STEPS, Math.ceil((visits / max) * SHADE_STEPS)));
}

/** Untrusted map data, checked shape by shape (SPEC 10.9 rule 9): bad entries are dropped, never rendered. */
export function safeShapes(map: WorldMapData): CountryShape[] {
  const list: unknown = map.countries;
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter((c): c is CountryShape => {
    if (typeof c !== 'object' || c === null) return false;
    const { code, d } = c as Record<string, unknown>;
    return typeof code === 'string' && CODE.test(code) && typeof d === 'string' && PATH.test(d);
  });
}

export function validMap(map: unknown): map is WorldMapData {
  if (typeof map !== 'object' || map === null) return false;
  const m = map as Record<string, unknown>;
  const ok = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return ok(m['width']) && ok(m['height']) && Array.isArray(m['countries']);
}

export interface ListedRow {
  /** null: the unknown row. */
  readonly code: string | null;
  readonly visits: number;
}

/** The busiest countries, the selected one even past the cut, then unknown. */
export function listedRows(data: CountriesData, selected: string | null = null): ListedRow[] {
  const rows: ListedRow[] = data.countries.filter((c, i) => i < MAX_LISTED || c.code === selected);
  return data.unknown > 0 ? [...rows, { code: null, visits: data.unknown }] : rows;
}

export const hiddenCount = (data: CountriesData, listed: readonly ListedRow[]): number =>
  data.countries.length - listed.filter((r) => r.code !== null).length;

// --- zoom and pan ------------------------------------------------------------------------------------------------------

/** What part of the map is in view: how far in, and the map point at the middle. */
export interface MapView {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const fullView = (map: Pick<WorldMapData, 'width' | 'height'>): MapView => ({
  zoom: MIN_ZOOM,
  x: map.width / 2,
  y: map.height / 2,
});

/** Keeps the zoom in range and the visible window inside the map. */
export function fitView(map: Pick<WorldMapData, 'width' | 'height'>, view: MapView): MapView {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const hw = map.width / zoom / 2;
  const hh = map.height / zoom / 2;
  return {
    zoom,
    x: clamp(view.x, hw, map.width - hw),
    y: clamp(view.y, hh, map.height - hh),
  };
}

/** Zooms by `factor`, keeping the map point `anchor` where it is on screen (the middle when there is none). */
export function zoomView(
  map: Pick<WorldMapData, 'width' | 'height'>,
  view: MapView,
  factor: number,
  anchor?: { readonly x: number; readonly y: number },
): MapView {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (!anchor) return fitView(map, { ...view, zoom });
  const ratio = view.zoom / zoom;
  return fitView(map, {
    zoom,
    x: anchor.x + (view.x - anchor.x) * ratio,
    y: anchor.y + (view.y - anchor.y) * ratio,
  });
}

/** The map point under a pointer at fraction (fx, fy) of the element. */
export function pointAt(
  map: Pick<WorldMapData, 'width' | 'height'>,
  view: MapView,
  fx: number,
  fy: number,
): { x: number; y: number } {
  const w = map.width / view.zoom;
  const h = map.height / view.zoom;
  return { x: view.x - w / 2 + fx * w, y: view.y - h / 2 + fy * h };
}

/** Moves the view by a drag of (dx, dy) screen pixels on an element `elementWidth` pixels wide. */
export function panView(
  map: Pick<WorldMapData, 'width' | 'height'>,
  start: MapView,
  dx: number,
  dy: number,
  elementWidth: number,
): MapView {
  const scale = map.width / start.zoom / Math.max(1, elementWidth);
  return fitView(map, { zoom: start.zoom, x: start.x - dx * scale, y: start.y - dy * scale });
}

export function viewBox(map: Pick<WorldMapData, 'width' | 'height'>, view: MapView): string {
  const w = map.width / view.zoom;
  const h = map.height / view.zoom;
  const r = (n: number): number => Math.round(n * 100) / 100;
  return `${r(view.x - w / 2)} ${r(view.y - h / 2)} ${r(w)} ${r(h)}`;
}

export function countryLabel(name: string, visits: string, single: boolean): string {
  return `${name}: ${visits} ${single ? 'visit' : 'visits'}`;
}

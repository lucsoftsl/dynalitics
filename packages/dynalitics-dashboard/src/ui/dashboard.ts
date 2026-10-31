import { createApi, normalizeBase, type Api, type FetchFn } from './api.js';
import type { Ctx, Host } from './context.js';
import { append, clear, el } from './dom.js';
import { createFormatters, parseInstant } from './format.js';
import { parseMeta } from './meta.js';
import type { Panel } from './panel.js';
import { createConsentPanel } from './panels/consent.js';
import { createHeroPanel } from './panels/hero.js';
import { createNvrPanel } from './panels/nvr.js';
import { createPagesPanel } from './panels/pages.js';
import { createVisitsPanel } from './panels/visits.js';
import { initialRange, offeredRanges, rangeByKey, type RangeDef, type RangeKey } from './ranges.js';
import {
  EMPTY_EXPLORER,
  explorerFromHash,
  explorerHash,
  explorerRanges,
  isExplorerHash,
} from './explorer/state.js';
import { createExplorer, type ExplorerView } from './explorer/view.js';
import { errorBlock } from './states.js';
import type { MetaData } from '../protocol.js';

export interface DashboardOptions {
  /** Same-origin path prefix of the read endpoint (`<meta name="dynalitics-base">`). */
  readonly base: string;
  readonly fetchFn?: FetchFn;
  readonly locale?: string;
  readonly now?: () => number;
  readonly reloadPage?: () => void;
}

export interface Dashboard {
  readonly refresh: () => void;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`dynalitics: missing #${id}`);
  return node as T;
}

function setupTheme(button: HTMLElement): void {
  const root = document.documentElement;
  // theme-boot.js always sets data-theme (stored choice, else the OS preference) before first paint.
  const isDark = () => root.getAttribute('data-theme') === 'dark';
  button.setAttribute('aria-pressed', String(isDark()));
  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    button.setAttribute('aria-pressed', String(next === 'dark'));
    try {
      localStorage.setItem('dynalitics-theme', next);
    } catch {
      /* storage blocked: the choice just does not persist */
    }
  });
}

function syncRangeControl(fieldset: HTMLElement, key: RangeKey): void {
  const inputs = [...fieldset.querySelectorAll<HTMLInputElement>('input')];
  inputs.forEach((input) => {
    input.checked = input.value === key;
  });
  const index = Math.max(
    0,
    inputs.findIndex((input) => input.value === key),
  );
  fieldset.querySelector<HTMLElement>('.dy-pill')?.style.setProperty('--i', String(index));
}

type ViewName = 'overview' | 'explorer';

const explorerOn = (meta: MetaData): boolean =>
  meta.widgets.explorer?.available === true && meta.explorer !== undefined;

/** Ranges for the view: the explorer routes are capped lower (SPEC 18.3, DESIGN 14.1). */
const rangesFor = (meta: MetaData, view: ViewName): readonly RangeDef[] =>
  view === 'explorer' ? explorerRanges(meta, offeredRanges(meta)) : offeredRanges(meta);

function buildViewNav(nav: HTMLElement, current: ViewName, onChange: (v: ViewName) => void): void {
  clear(nav);
  nav.hidden = false;
  for (const [view, label] of [
    ['overview', 'Overview'],
    ['explorer', 'Explorer'],
  ] as const) {
    const b = el('button', 'dy-btn dy-view-btn', label, { type: 'button' });
    if (view === current) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', () => onChange(view));
    nav.appendChild(b);
  }
}

function buildRangeControl(
  fieldset: HTMLElement,
  ranges: readonly RangeDef[],
  selected: RangeKey,
  onChange: (k: RangeKey) => void,
): void {
  clear(fieldset);
  append(
    fieldset,
    el('legend', 'vh', 'Date range'),
    el('span', 'dy-pill', null, { 'aria-hidden': 'true' }),
  );
  fieldset.style.setProperty('--n', String(ranges.length));
  for (const r of ranges) {
    const label = el('label');
    const input = el('input', undefined, null, { type: 'radio', name: 'dy-range', value: r.key });
    input.addEventListener('change', () => onChange(r.key));
    append(label, input, el('span', undefined, r.key));
    fieldset.appendChild(label);
  }
  syncRangeControl(fieldset, selected);
}

export function startDashboard(options: DashboardOptions): Dashboard {
  const base = normalizeBase(options.base);
  const fetchFn: FetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const api: Api = createApi(base, fetchFn);
  const fmt = createFormatters(options.locale);
  const grid = byId('dy-grid');
  const fieldset = byId('dy-range');
  const nav = byId('dy-views');
  const updated = byId('dy-updated');
  let view: ViewName = 'overview';
  let explorer: ExplorerView | null = null;
  const clock = options.now ?? (() => Date.now());
  let ctx: Ctx | null = null;
  let panels: readonly Panel[] = [];
  let errorShown = false;
  let metaToken = 0;
  let metaAbort: AbortController | null = null;

  const host: Host = {
    now: clock,
    setRange: (key) => selectRange(key),
    reloadPage: options.reloadPage ?? (() => location.reload()),
    refresh: () => void refreshAll(),
    claimErrorRole: () => {
      const role = errorShown ? 'status' : 'alert';
      errorShown = true;
      return role;
    },
    touchUpdated: (iso) => {
      const t = parseInstant(iso);
      if (!Number.isNaN(t)) updated.textContent = fmt.time(t);
    },
  };
  const getCtx = (): Ctx => {
    if (!ctx) throw new Error('dynalitics: panel used before /api/meta');
    return ctx;
  };

  function showPageError(failure: Parameters<typeof errorBlock>[0]): void {
    clear(grid);
    grid.appendChild(
      errorBlock(failure, {
        role: host.claimErrorRole(),
        cooldownLeftMs: 0,
        onRetry: () => void refreshAll(),
        onReload: host.reloadPage,
        onTrySevenDays: null,
        ssoHint: true, // only ever shown for the first /api/meta request
      }),
    );
    panels = [];
  }

  function writeHash(): void {
    if (!ctx) return;
    const key = ctx.range.key;
    const hash =
      view === 'explorer' && explorer ? explorerHash(key, explorer.state()) : `#range=${key}`;
    try {
      history.replaceState(null, '', hash);
    } catch {
      /* sandboxed frame: the hash simply is not mirrored */
    }
  }

  function mountPanels(hash: string): void {
    explorer?.stop();
    explorer = null;
    clear(grid);
    grid.classList.toggle('dy-grid--explorer', view === 'explorer');
    if (view === 'explorer' && ctx) {
      explorer = createExplorer(getCtx, host, {
        initial: hash ? explorerFromHash(hash, ctx.meta) : EMPTY_EXPLORER,
        onChange: writeHash,
      });
      panels = explorer.panels;
      grid.appendChild(explorer.element);
      return;
    }
    panels = [
      createHeroPanel(getCtx, host),
      createPagesPanel(getCtx, host),
      createNvrPanel(getCtx, host),
      createConsentPanel(getCtx, host),
      createVisitsPanel(getCtx, host),
    ];
    append(grid, ...panels.map((p) => p.element));
  }

  function selectRange(key: RangeKey): void {
    const range = rangeByKey(key);
    if (!range || !ctx) return;
    ctx = { ...ctx, range };
    syncRangeControl(fieldset, key);
    explorer?.resetZoom();
    writeHash();
    void refreshAll();
  }

  /** Overview <-> Explorer (DESIGN 14.1). The explorer offers only ranges its routes accept. */
  function switchView(next: ViewName, hash = ''): void {
    if (!ctx) return;
    view = next;
    const ranges = rangesFor(ctx.meta, view);
    if (!ranges.some((r) => r.key === ctx?.range.key)) {
      const fallback = ranges[ranges.length - 1];
      if (fallback) ctx = { ...ctx, range: fallback };
    }
    buildRangeControl(fieldset, ranges, ctx.range.key, (k) => selectRange(k));
    buildViewNav(nav, view, (v) => {
      if (v !== view) switchView(v);
    });
    mountPanels(hash);
    writeHash();
    panels.forEach((p) => p.refreshTools());
    explorer?.refreshTools();
    panels.forEach((p) => p.load());
  }

  async function refreshAll(): Promise<void> {
    const token = ++metaToken;
    metaAbort?.abort();
    metaAbort = new AbortController();
    const result = await api.get<unknown>('meta', {}, metaAbort.signal);
    if (token !== metaToken || result.kind === 'aborted') return;
    const meta = result.kind === 'data' ? parseMeta(result.data) : null;
    if (!meta) {
      if (ctx) {
        panels.forEach((p) => p.load()); // keep the old meta; panels report their own failures
        return;
      }
      showPageError(result.kind === 'error' ? result.failure : { kind: 'unexpected', status: 0 });
      return;
    }
    const first = !ctx;
    const hash = first ? location.hash : '';
    const range = rangeByKey(initialRange(meta, first ? hash : `#range=${ctx?.range.key}`));
    if (!range) return;
    ctx = {
      api,
      fmt,
      meta,
      range: ctx && offeredRanges(meta).some((r) => r.key === ctx?.range.key) ? ctx.range : range,
    };
    if (first) {
      if (explorerOn(meta)) return switchView(isExplorerHash(hash) ? 'explorer' : 'overview', hash);
      buildRangeControl(fieldset, offeredRanges(meta), ctx.range.key, (k) => selectRange(k));
      mountPanels('');
    }
    // The explorer's own controls are not rebuilt here: a live-tail tick must never steal focus from them.
    panels.forEach((p) => p.refreshTools());
    panels.forEach((p) => p.load());
  }

  setupTheme(byId('dy-theme'));
  byId('dy-refresh').addEventListener('click', () => void refreshAll());
  void refreshAll();
  return { refresh: () => void refreshAll() };
}

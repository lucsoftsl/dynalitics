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
import { initialRange, offeredRanges, rangeByKey, type RangeKey } from './ranges.js';
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

function buildRangeControl(
  fieldset: HTMLElement,
  meta: MetaData,
  selected: RangeKey,
  onChange: (k: RangeKey) => void,
): void {
  const ranges = offeredRanges(meta);
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
  const updated = byId('dy-updated');
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

  function mountPanels(): void {
    panels = [
      createHeroPanel(getCtx, host),
      createPagesPanel(getCtx, host),
      createNvrPanel(getCtx, host),
      createConsentPanel(getCtx, host),
      createVisitsPanel(getCtx, host),
    ];
    clear(grid);
    append(grid, ...panels.map((p) => p.element));
  }

  function selectRange(key: RangeKey): void {
    const range = rangeByKey(key);
    if (!range || !ctx) return;
    ctx = { ...ctx, range };
    syncRangeControl(fieldset, key);
    try {
      history.replaceState(null, '', `#range=${key}`);
    } catch {
      /* sandboxed frame: the hash simply is not mirrored */
    }
    void refreshAll();
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
    const range = rangeByKey(
      initialRange(meta, first ? location.hash : `#range=${ctx?.range.key}`),
    );
    if (!range) return;
    ctx = {
      api,
      fmt,
      meta,
      range: ctx && offeredRanges(meta).some((r) => r.key === ctx?.range.key) ? ctx.range : range,
    };
    if (first) {
      buildRangeControl(fieldset, meta, ctx.range.key, (k) => selectRange(k));
      mountPanels();
    }
    panels.forEach((p) => p.refreshTools());
    panels.forEach((p) => p.load());
  }

  setupTheme(byId('dy-theme'));
  byId('dy-refresh').addEventListener('click', () => void refreshAll());
  void refreshAll();
  return { refresh: () => void refreshAll() };
}

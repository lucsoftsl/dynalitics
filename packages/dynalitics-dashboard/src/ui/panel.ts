import type { ApiResult } from './api.js';
import type { Ctx, Host } from './context.js';
import { append, clear, el } from './dom.js';
import { parseInstant } from './format.js';
import { begin, initialState, resolve, withData, type PanelState } from './state.js';
import { errorBlock, staleNotice, unavailableBlock } from './states.js';
import type { Unavailable } from '../protocol.js';

const SKELETON_DELAY_MS = 200;
const RETRY_COOLDOWN_MS = 2000;

/** What a widget supplies; the controller owns requests, state, busy flags and the live region. */
export interface PanelSpec<T> {
  readonly id: string;
  readonly no: number;
  readonly title: string;
  readonly className: string;
  readonly sheet?: boolean;
  /** Head eyebrow, e.g. `No. 3 · LAST 31 DAYS`; recomputed on every load so it never changes with the data. */
  readonly eyebrow?: (ctx: Ctx) => string;
  /** A 400 on this panel means stale meta (it is normally clamped): offer a reload. */
  readonly reloadOnBadRequest?: boolean;
  /** Set when /api/meta says the widget is off: no request is made. */
  readonly availability: (ctx: Ctx) => Unavailable | null;
  readonly request: (ctx: Ctx, signal: AbortSignal, panel: PanelApi<T>) => Promise<ApiResult<T>>;
  readonly isEmpty: (data: T) => boolean;
  readonly skeleton: (ctx: Ctx) => Node;
  readonly empty: (ctx: Ctx, host: Host) => Node;
  readonly ready: (data: T, ctx: Ctx, panel: PanelApi<T>) => Node;
  readonly summary: (data: T, ctx: Ctx) => string;
  /** Rebuilt on every meta/range change; return the controls for the panel head. */
  readonly tools?: (ctx: Ctx, panel: PanelApi<T>) => readonly Node[];
}

export interface PanelApi<T> {
  readonly element: HTMLElement;
  readonly host: Host;
  getCtx(): Ctx;
  getState(): PanelState<T>;
  load(): void;
  rerender(): void;
  readonly say: (text: string) => void;
  /** Replace the data without a new request (load more, PII toggle). */
  patch(data: T): void;
}

export interface Panel {
  readonly element: HTMLElement;
  load(): void;
  refreshTools(): void;
}

export function createPanel<T>(spec: PanelSpec<T>, getCtx: () => Ctx, host: Host): Panel {
  let state: PanelState<T> = initialState<T>();
  let abort: AbortController | null = null;
  let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
  let skeletonShown = false;
  let lastRetryAt = Number.NEGATIVE_INFINITY;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let errorRole: 'alert' | 'status' = 'status';

  const section = el(
    'section',
    `dy-panel ${spec.className}${spec.sheet ? ' dy-panel--sheet' : ''}`,
    null,
    {
      'aria-labelledby': `h-${spec.id}`,
    },
  );
  const tools = el('div', 'dy-tools');
  const viz = el('div', 'dy-viz');
  const live = el('p', 'vh', null, { role: 'status', 'aria-live': 'polite' });
  const head = el('header', 'dy-panel-head');
  const eyebrow = el('p', 'dy-eyebrow', `No. ${spec.no}`, { 'aria-hidden': 'true' });
  append(head, eyebrow, el('h2', 'dy-h2', spec.title, { id: `h-${spec.id}` }), tools);
  const body = el('div', 'dy-body');
  body.appendChild(viz);
  append(section, el('div', 'dy-progress', null, { 'aria-hidden': 'true' }), head, body, live);

  const api: PanelApi<T> = {
    element: section,
    host,
    getCtx,
    getState: () => state,
    load,
    rerender: render,
    say: (text) => {
      live.textContent = text;
    },
    patch: (data) => {
      state = withData(state, data, spec.isEmpty);
      render();
    },
  };

  const cooldownLeft = (): number => Math.max(0, RETRY_COOLDOWN_MS - (host.now() - lastRetryAt));

  /** A retry click starts a 2 s cooldown; no automatic retries ever (SPEC 10.9 rule 4). */
  function retry(): void {
    lastRetryAt = host.now();
    load();
  }

  function renderContent(ctx: Ctx): Node {
    switch (state.status) {
      case 'loading': {
        const wrap = el('div', skeletonShown ? 'dy-loading' : 'dy-loading dy-loading--wait');
        wrap.appendChild(spec.skeleton(ctx));
        return wrap;
      }
      case 'ready':
        return spec.ready(state.data as T, ctx, api);
      case 'empty':
        return spec.empty(ctx, host);
      case 'unavailable':
        return unavailableBlock(state.unavailable as Unavailable, spec.title);
      case 'error':
        return errorBlock(state.failure!, {
          role: errorRole,
          cooldownLeftMs: cooldownLeft(),
          onRetry: retry,
          onReload: host.reloadPage,
          onTrySevenDays: ctx.range.days > 7 ? () => host.setRange('7d') : null,
          reloadOnBadRequest: spec.reloadOnBadRequest === true,
        });
    }
  }

  function render(): void {
    const ctx = getCtx();
    if (spec.eyebrow) eyebrow.textContent = spec.eyebrow(ctx);
    const busy = state.status === 'loading' || state.refreshing;
    viz.setAttribute('aria-busy', String(busy));
    viz.classList.toggle('is-refreshing', state.refreshing);
    section.classList.toggle('is-refreshing-panel', state.refreshing);
    clear(viz);
    if (state.staleFailure && state.generatedAt) {
      const at = parseInstant(state.generatedAt);
      viz.appendChild(staleNotice(state.staleFailure, ctx.fmt.time(at), retry));
    }
    viz.appendChild(renderContent(ctx));
    clearTimeout(cooldownTimer);
    if (state.status === 'error' && cooldownLeft() > 0)
      cooldownTimer = setTimeout(render, cooldownLeft());
  }

  function refreshTools(): void {
    clear(tools);
    append(tools, ...(spec.tools?.(getCtx(), api) ?? []));
  }

  function settle(id: number, result: ApiResult<T>): void {
    const next = resolve(state, id, result, spec.isEmpty);
    if (next === state) return;
    const failedNow = next.status === 'error' && state.status !== 'error';
    state = next;
    if (failedNow) errorRole = host.claimErrorRole();
    clearTimeout(skeletonTimer);
    render();
    const ctx = getCtx();
    if (state.status === 'ready' && state.data) api.say(spec.summary(state.data, ctx));
    else if (state.status === 'error') api.say(`${spec.title} failed to load.`);
  }

  function load(): void {
    abort?.abort();
    clearTimeout(skeletonTimer);
    const ctx = getCtx();
    const unavailable = spec.availability(ctx);
    if (unavailable) {
      state = { ...initialState<T>(), status: 'unavailable', reqId: state.reqId + 1, unavailable };
      render();
      return;
    }
    abort = new AbortController();
    state = begin(state);
    skeletonShown = false;
    skeletonTimer = setTimeout(() => {
      skeletonShown = true;
      if (state.status === 'loading') {
        render();
        api.say(`Loading ${spec.title}`);
      }
    }, SKELETON_DELAY_MS);
    const id = state.reqId;
    render();
    void spec.request(ctx, abort.signal, api).then((result) => settle(id, result));
  }

  return { element: section, load, refreshTools };
}

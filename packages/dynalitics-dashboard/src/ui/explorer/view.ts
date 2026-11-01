import type { MetaData, RecentVisit } from '../../protocol.js';
import type { Failure } from '../api.js';
import type { Ctx, Host } from '../context.js';
import { append, clear, el } from '../dom.js';
import type { Panel } from '../panel.js';
import { createVisitsPanel, toView, type VisitsView } from '../panels/visits.js';
import { unavailableOf } from '../request.js';
import { createFieldsPanel } from './fields.js';
import { createHistogramPanel, NO_MATCHES } from './histogram.js';
import { explorerGet, type ExplorerHost } from './host.js';
import {
  addClause,
  explorerWindow,
  tailChoices,
  type ExplorerState,
  type TailSeconds,
  type Zoom,
} from './state.js';

// The explorer view (docs/DESIGN.md 14): query bar, split and live controls, and three panels.

export interface ExplorerView {
  readonly element: HTMLElement;
  readonly panels: readonly Panel[];
  readonly state: () => ExplorerState;
  /** Called on every range change: a zoom belongs to the old range. */
  readonly resetZoom: () => void;
  readonly refreshTools: () => void;
  readonly stop: () => void;
}

export interface ExplorerOptions {
  readonly initial: ExplorerState;
  /** The state changed in a way worth keeping in the URL. */
  readonly onChange: (s: ExplorerState) => void;
}

const SYNTAX: readonly [string, string][] = [
  ['pricing', 'any searchable field contains "pricing" (case-insensitive)'],
  ['"two words"', 'the exact phrase'],
  ['page:/blog*', 'starts with /blog (also *end and *contains*)'],
  ['plan:pro', 'equals pro'],
  ['-consent:false', 'leave out matches; - works on any part'],
  ['amount:>=10', 'numbers: > >= < <='],
  ['plan:*', 'has a value'],
];

const describeTail = (s: TailSeconds): string => (s === 0 ? 'Off' : `Every ${s} s`);

function syntaxHelp(meta: MetaData): HTMLElement {
  const d = el('details', 'dy-syntax');
  d.appendChild(el('summary', undefined, 'Syntax'));
  const dl = el('dl');
  for (const [code, text] of SYNTAX)
    append(dl, el('dt', undefined, code), el('dd', undefined, text));
  d.appendChild(dl);
  const fields = meta.explorer?.fields ?? [];
  d.appendChild(
    el(
      'p',
      'dy-note',
      `Fields: ${fields.map((f) => `${f.key} (${f.type})`).join(', ')}. Personal fields cannot be searched.`,
    ),
  );
  return d;
}

function select(
  label: string,
  options: readonly [string, string][],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = el('label', 'dy-xctl');
  const s = el('select', 'dy-select');
  for (const [v, text] of options) {
    const o = el('option', undefined, text, { value: v });
    o.selected = v === value;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  append(wrap, el('span', 'dy-eyebrow', label), s);
  return wrap;
}

export function createExplorer(
  getCtx: () => Ctx,
  host: Host,
  options: ExplorerOptions,
): ExplorerView {
  let state = options.initial;
  let inflight = 0;
  let tailTick = false;
  let tailTimer: ReturnType<typeof setTimeout> | undefined;
  let seen = new Set<string>();
  let fresh = new Set<string>();

  const element = el('div', 'dy-explorer');
  const form = el('form', 'dy-query', null, { role: 'search', novalidate: '' });
  const input = el('input', 'dy-q', null, {
    id: 'dy-q',
    type: 'search',
    name: 'q',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-describedby': 'dy-q-err',
  });
  input.value = state.q;
  const err = el('div', 'dy-q-err', null, { id: 'dy-q-err', role: 'alert' });
  err.hidden = true;
  const controls = el('div', 'dy-xmeta');
  const matched = el('p', 'dy-xmatched', null, { role: 'status' });
  const live = el('p', 'vh', null, { role: 'status', 'aria-live': 'polite' });
  const grid = el('div', 'dy-xgrid');

  const set = (next: ExplorerState, persist = true): void => {
    state = next;
    if (persist) options.onChange(state);
  };

  function showQueryError(f: Failure | null): void {
    clear(err);
    err.hidden = f === null;
    input.setAttribute('aria-invalid', String(f !== null));
    if (!f) return;
    const q = f.query;
    err.appendChild(el('p', undefined, q?.message ?? 'Invalid query.'));
    if (q) {
      const text = state.q;
      const at = Math.min(Math.max(0, q.position), text.length);
      const echo = el('p', 'dy-q-echo');
      append(
        echo,
        document.createTextNode(text.slice(0, at)),
        el('mark', 'dy-q-at', text.slice(at, at + 1) || ' '),
        document.createTextNode(text.slice(at + 1)),
      );
      err.appendChild(echo);
    }
  }

  function stopTail(note: string | null): void {
    clearTimeout(tailTimer);
    if (state.tail !== 0) set({ ...state, tail: 0 });
    tailTick = false;
    renderControls(note);
  }

  function scheduleTail(): void {
    clearTimeout(tailTimer);
    if (state.tail === 0) return;
    tailTimer = setTimeout(() => {
      if (state.tail === 0) return;
      if (document.hidden || inflight > 0) return scheduleTail();
      tailTick = true;
      host.refresh();
      scheduleTail();
    }, state.tail * 1000);
  }

  const x: ExplorerHost = {
    state: () => state,
    window: (ctx) => explorerWindow(ctx.range, ctx.meta.now, state.zoom),
    onQueryError: (f) => {
      showQueryError(f);
      if (tailTick) stopTail('Live updates stopped: the search is not valid.');
    },
    onMatched: (n) => {
      matched.textContent = `${getCtx().fmt.num(n)} ${n === 1 ? 'match' : 'matches'}`;
    },
    zoom: (z: Zoom) => {
      set({ ...state, zoom: z }, false);
      loadAll(false);
    },
    addClause: (key, value, negate) => {
      const next = addClause(state.q, key, value, negate);
      if (next === null) return;
      input.value = next;
      submit();
    },
    isTailTick: () => tailTick,
    begin: () => {
      inflight += 1;
      let done = false;
      return () => {
        if (!done) inflight -= 1;
        done = true;
      };
    },
    onData: (generatedAt) => host.touchUpdated(generatedAt),
    onFailure: () => {
      if (tailTick) stopTail('Live updates stopped after an error.');
    },
  };

  const results = createVisitsPanel(getCtx, host, {
    id: 'xresults',
    no: 3,
    title: 'Matching visits',
    className: 'p-xresults',
    ariaLabel: 'Matching visits, newest first',
    empty: NO_MATCHES,
    availability: (ctx) =>
      ctx.meta.widgets.explorer ? unavailableOf(ctx.meta.widgets.explorer) : null,
    fetch: async (ctx, signal, params, panel) => {
      const paging = 'cursor' in params;
      const r = toView(await explorerGet(ctx, x, 'search', signal, panel, () => params));
      if (r.kind === 'data' && !paging) {
        if (typeof r.data.matched === 'number') x.onMatched(r.data.matched);
        noteFresh(r.data.visits);
      }
      return r;
    },
    decorate: (data: VisitsView, rows) => {
      const visits = data.visits;
      rows.forEach((row, i) => {
        const id = visits[i]?.id;
        if (id && fresh.has(id)) row.classList.add('is-new');
      });
    },
  });

  function noteFresh(visits: readonly RecentVisit[]): void {
    const ids = visits.map((v) => v.id).filter((id): id is string => id !== null);
    fresh = tailTick ? new Set(ids.filter((id) => !seen.has(id))) : new Set();
    seen = new Set(ids);
    if (fresh.size > 0)
      live.textContent = `${fresh.size} new matching ${fresh.size === 1 ? 'visit' : 'visits'}`;
  }

  const panels: Panel[] = [
    createHistogramPanel(getCtx, host, x),
    createFieldsPanel(getCtx, host, x),
    results,
  ];

  function loadAll(fromTail: boolean): void {
    tailTick = fromTail;
    panels.forEach((p) => p.load());
  }

  function submit(): void {
    showQueryError(null);
    set({ ...state, q: input.value.trim() });
    loadAll(false);
  }

  function renderControls(note: string | null = null): void {
    clear(controls);
    const meta = getCtx().meta;
    const facets = (meta.explorer?.fields ?? []).filter((f) => f.facet);
    append(controls, matched);
    if (state.zoom) {
      const chip = el('p', 'dy-xzoom');
      const reset = el('button', 'dy-btn dy-btn--text', 'Reset zoom', { type: 'button' });
      reset.addEventListener('click', () => {
        set({ ...state, zoom: null }, false);
        renderControls();
        loadAll(false);
      });
      const f = getCtx().fmt;
      const z = state.zoom;
      const span =
        z.interval === 'hour' ? f.weekday(z.fromMs) : `${f.day(z.fromMs)} to ${f.day(z.toMs - 1)}`;
      append(chip, document.createTextNode(`Zoomed to ${span} (UTC) `), reset);
      controls.appendChild(chip);
    }
    controls.appendChild(
      select(
        'Split by',
        [['', 'None'], ...facets.map((f): [string, string] => [f.key, f.key])],
        state.split ?? '',
        (v) => {
          set({ ...state, split: v || null });
          panels[0]?.load();
        },
      ),
    );
    controls.appendChild(
      select(
        'Live',
        [0 as TailSeconds, ...tailChoices(meta)].map((s): [string, string] => [
          String(s),
          describeTail(s),
        ]),
        String(state.tail),
        (v) => {
          set({ ...state, tail: Number(v) as TailSeconds });
          scheduleTail();
        },
      ),
    );
    if (facets.some((f) => f.key === 'statusClass')) controls.appendChild(errorFilters());
    if (note) controls.appendChild(el('span', 'dy-note', note));
  }

  /** One-click filters for failed requests (DESIGN 15.3). They only write the query; nothing else is special. */
  function errorFilters(): HTMLElement {
    const box = el('div', 'dy-xquick', null, { role: 'group', 'aria-label': 'Show errors' });
    for (const [q, label, cls] of [
      ['statusClass:5xx', '5xx', 'server'],
      ['statusClass:4xx', '4xx', 'client'],
      ['status:>=400', 'All errors', 'any'],
    ] as const) {
      const b = el('button', `dy-btn dy-btn--chip dy-xquick--${cls}`, label, { type: 'button' });
      b.setAttribute('aria-pressed', String(state.q === q));
      b.addEventListener('click', () => {
        input.value = state.q === q ? '' : q;
        submit();
        renderControls();
      });
      box.appendChild(b);
    }
    return box;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  const row = el('div', 'dy-query-row');
  append(row, input, el('button', 'dy-btn', 'Search', { type: 'submit' }));
  append(
    form,
    el('label', 'dy-eyebrow', 'Search visits', { for: 'dy-q' }),
    row,
    err,
    syntaxHelp(getCtx().meta),
  );
  append(element, form, controls, live, grid);
  append(grid, ...panels.map((p) => p.element));
  renderControls();
  scheduleTail();

  return {
    element,
    panels,
    state: () => state,
    resetZoom: () => {
      if (!state.zoom) return;
      set({ ...state, zoom: null }, false);
      renderControls();
    },
    refreshTools: () => {
      renderControls();
      panels.forEach((p) => p.refreshTools());
    },
    stop: () => {
      clearTimeout(tailTimer);
    },
  };
}

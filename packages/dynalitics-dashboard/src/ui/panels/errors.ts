import type { ErrorReasonCount, ErrorsData, Unavailable } from '../../protocol.js';
import { intervalUnit } from '../charts/labels.js';
import type { Ctx, Host } from '../context.js';
import { append, el, visitorText } from '../dom.js';
import { clamp01, parseInstant, pct } from '../format.js';
import { createPanel, type Panel, type PanelApi, type PanelSpec } from '../panel.js';
import { windowFor } from '../ranges.js';
import { requestWindow, unavailableOf } from '../request.js';
import { emptyBlock, skeletonChart, skeletonHeadline } from '../states.js';
import { setViewTools, splitBar, type View } from '../widgets.js';
import { bucketChart } from './bucket-chart.js';
import { statusBadge } from './status.js';

/** One ranked row: label, count, and a bar coloured by the worst class it contains (DESIGN 15.2). */
function rankRow(
  label: Node,
  count: string,
  ratio: number,
  severity: 'client' | 'server',
): HTMLElement {
  const li = el('li', `dy-page-row dy-err-row dy-err-row--${severity}`);
  const nums = el('span', 'dy-nums');
  nums.appendChild(el('span', 'dy-count', count));
  const bar = el('span', 'dy-bar', null, { 'aria-hidden': 'true' });
  bar.style.setProperty('--r', String(clamp01(ratio)));
  append(li, label, nums, bar);
  return li;
}

function reasonLabel(r: ErrorReasonCount): HTMLElement {
  const wrap = el('span', 'dy-err-label');
  wrap.appendChild(statusBadge(r.status));
  wrap.appendChild(
    r.reason === null
      ? el('span', 'dy-err-none', 'no reason given')
      : visitorText('span', r.reason, 'dy-err-reason'),
  );
  return wrap;
}

function lists(data: ErrorsData, ctx: Ctx): HTMLElement {
  const f = ctx.fmt;
  const box = el('div', 'dy-err-lists');
  const topPage = Math.max(1, ...data.pages.map((p) => p.errors));
  const pages = el('ol', 'dy-pages dy-err-pages', null, {
    'aria-label': 'Pages with the most errors',
  });
  for (const p of data.pages) {
    const label = el('span', 'dy-err-label');
    label.appendChild(visitorText('span', p.page, 'dy-page', true));
    pages.appendChild(
      rankRow(
        label,
        p.serverErrors > 0 ? `${f.num(p.errors)} · ${f.num(p.serverErrors)} 5xx` : f.num(p.errors),
        p.errors / topPage,
        p.serverErrors > 0 ? 'server' : 'client',
      ),
    );
  }
  const topReason = Math.max(1, ...data.reasons.map((r) => r.count));
  const reasons = el('ol', 'dy-pages dy-err-reasons', null, { 'aria-label': 'Commonest errors' });
  for (const r of data.reasons)
    reasons.appendChild(
      rankRow(
        reasonLabel(r),
        f.num(r.count),
        r.count / topReason,
        r.status >= 500 ? 'server' : 'client',
      ),
    );
  const section = (title: string, list: HTMLElement, note: string | null): HTMLElement => {
    const s = el('section', 'dy-err-list');
    append(s, el('h3', 'dy-eyebrow', title), list);
    if (note !== null) s.appendChild(el('p', 'dy-kpi-sub', note));
    return s;
  };
  append(
    box,
    section('Failing pages', pages, null),
    section('Errors by reason', reasons, data.reasonsStored ? null : ERRORS_COPY.noReasons),
  );
  return box;
}

function buildReady(
  data: ErrorsData,
  ctx: Ctx,
  api: PanelApi<ErrorsData>,
  view: View,
): HTMLElement {
  const f = ctx.fmt;
  const { totals } = data;
  const errors = totals.clientErrors + totals.serverErrors;
  const ok = (p: { total: number; clientErrors: number; serverErrors: number }): number =>
    Math.max(0, p.total - p.clientErrors - p.serverErrors);
  const wrap = el('div', 'dy-err');
  const head = el('div', 'dy-err-head');
  const num = el('p', 'dy-kpi-num');
  append(
    num,
    document.createTextNode(totals.rate === null ? '—' : pct(totals.rate)),
    el('small', errors > 0 ? 'c-server' : undefined, 'failed'),
  );
  append(
    head,
    num,
    el(
      'p',
      'dy-kpi-sub',
      ERRORS_COPY.sub(
        f.num(errors),
        f.num(totals.total),
        f.num(totals.serverErrors),
        f.num(totals.clientErrors),
      ),
    ),
    splitBar(
      [
        { swatch: 'ok', value: ok(totals) },
        { swatch: 'client', value: totals.clientErrors },
        { swatch: 'server', value: totals.serverErrors },
      ],
      `${f.num(ok(totals))} succeeded, ${f.num(totals.clientErrors)} client errors, ${f.num(totals.serverErrors)} server errors`,
    ),
    bucketChart(
      api,
      ctx,
      {
        interval: data.interval,
        times: data.points.map((p) => parseInstant(p.bucket)),
        series: [
          { swatch: 'ok', label: 'Succeeded', values: data.points.map(ok) },
          { swatch: 'client', label: '4xx', values: data.points.map((p) => p.clientErrors) },
          { swatch: 'server', label: '5xx', values: data.points.map((p) => p.serverErrors) },
        ],
        order: [2, 1, 0],
        percent: false,
        win: windowFor(ctx.range, ctx.meta.now),
        ariaLabel: `Responses per ${intervalUnit(data.interval)}. ${f.num(totals.serverErrors)} server errors, ${f.num(totals.clientErrors)} client errors of ${f.num(totals.total)}.`,
        caption: `Responses per ${intervalUnit(data.interval)}`,
        extra: {
          text: 'Failed',
          cell: (i) => (data.points[i]?.rate == null ? '—' : pct(data.points[i].rate)),
        },
      },
      view,
    ),
  );
  append(wrap, head, lists(data, ctx));
  return wrap;
}

export const ERRORS_EMPTY = {
  title: 'No responses with a status yet.',
  body: 'Pass status to track() after each response; failed requests will appear here.',
} as const;

export const ERRORS_COPY = {
  sub: (errors: string, total: string, server: string, client: string): string =>
    `${errors} of ${total} responses failed: ${server} server errors (5xx), ${client} client errors (4xx). Visits without a stored status are not counted.`,
  noReasons:
    'No reasons are stored. Map columns.errorReason and pass errorReason to track() to see why requests failed.',
} as const;

const NOT_OFFERED = {
  reason: 'column_not_mapped',
  message: 'This server does not report errors.',
} as const;

export const errorsAvailability = (ctx: Pick<Ctx, 'meta'>): Unavailable | null =>
  ctx.meta.widgets.errors === undefined ? NOT_OFFERED : unavailableOf(ctx.meta.widgets.errors);

/** True when the overview should show the Errors panel (no status column: no panel, not an empty one). */
export const errorsOn = (ctx: Pick<Ctx, 'meta'>): boolean =>
  ctx.meta.widgets.errors?.available === true;

export function createErrorsPanel(getCtx: () => Ctx, host: Host): Panel {
  let view: View = 'chart';
  const spec: PanelSpec<ErrorsData> = {
    id: 'errors',
    no: 5,
    title: 'Errors',
    className: 'p-errors',
    // The overview mounts this panel only when the widget is available (errorsOn); older servers have no `errors` key.
    availability: errorsAvailability,
    request: (ctx, signal) =>
      requestWindow<ErrorsData>(ctx, 'errors', signal, (w) => ({
        from: w.from,
        to: w.to,
        interval: w.interval,
      })),
    isEmpty: (d) => d.totals.total === 0,
    skeleton: () => {
      const b = el('div');
      append(b, skeletonHeadline(), skeletonChart(200));
      return b;
    },
    empty: () => emptyBlock(ERRORS_EMPTY),
    ready: (d, ctx, api) => buildReady(d, ctx, api, view),
    summary: (d, ctx) =>
      `Errors loaded: ${ctx.fmt.num(d.totals.serverErrors)} server errors, ${ctx.fmt.num(d.totals.clientErrors)} client errors`,
    tools: (_ctx, api) =>
      setViewTools(api, view, (v) => {
        view = v;
      }),
  };
  return createPanel(spec, getCtx, host);
}

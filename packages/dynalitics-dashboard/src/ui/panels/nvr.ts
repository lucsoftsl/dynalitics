import type { NewVsReturningData } from '../../protocol.js';
import { intervalUnit } from '../charts/labels.js';
import type { Ctx, Host } from '../context.js';
import { append, el } from '../dom.js';
import { parseInstant, pct } from '../format.js';
import { createPanel, type Panel, type PanelApi, type PanelSpec } from '../panel.js';
import { windowFor, windowLabel } from '../ranges.js';
import { requestWindow, unavailableOf } from '../request.js';
import { emptyBlock, skeletonChart, skeletonHeadline } from '../states.js';
import { setViewTools, splitBar, type View } from '../widgets.js';
import { bucketChart } from './bucket-chart.js';

const UNKNOWN_DEF = 'Unknown means no consent, or consent but no usable identity.';
const CAVEAT =
  'Visitors are matched by IP address as well as user id, so shared addresses can merge people and hashed addresses reset when the salt changes. Read these as estimates, not a head count.';

const capNote = (cap: number): string =>
  cap === 1
    ? 'Showing the last day: this widget is capped at 1 day.'
    : `Showing the last ${cap} days: this widget is capped at ${cap} days.`;

function buildReady(
  data: NewVsReturningData,
  ctx: Ctx,
  api: PanelApi<NewVsReturningData>,
  view: View,
): HTMLElement {
  const f = ctx.fmt;
  const { totals } = data;
  const identified = totals.new + totals.returning;
  const all = identified + totals.unknown;
  const cap = ctx.meta.limits.newVsReturningMaxRangeDays;
  const label = windowLabel(ctx.range, cap);
  const times = data.points.map((p) => parseInstant(p.bucket));
  const wrap = el('div');

  const num = el('p', 'dy-kpi-num');
  append(
    num,
    document.createTextNode(identified > 0 ? pct(totals.new / identified) : '—'),
    el('small', 'c-new', 'new'),
  );
  if (data.approximate) num.appendChild(el('span', 'dy-estimate', 'Estimate'));
  wrap.appendChild(num);
  const unknownPart =
    totals.unknown > 0
      ? ` ${f.num(totals.unknown)} (${pct(totals.unknown / all)}) could not be classified: declined consent or no usable identity.`
      : '';
  wrap.appendChild(
    el(
      'p',
      'dy-kpi-sub',
      identified > 0
        ? `Based on ${f.num(identified)} visits with a known visitor.${unknownPart}`
        : 'No visitors could be classified yet.',
    ),
  );
  for (const note of [
    label.capped ? capNote(cap) : null,
    data.approximate ? CAVEAT : null,
    UNKNOWN_DEF,
  ]) {
    if (note) wrap.appendChild(el('p', 'dy-note', note));
  }
  wrap.appendChild(
    splitBar(
      [
        { swatch: 'new', value: totals.new },
        { swatch: 'returning', value: totals.returning },
        { swatch: 'unknown', value: totals.unknown },
      ],
      `${f.num(totals.new)} new, ${f.num(totals.returning)} returning, ${f.num(totals.unknown)} unknown`,
    ),
  );
  wrap.appendChild(
    bucketChart(
      api,
      ctx,
      {
        interval: data.interval,
        times,
        series: [
          { swatch: 'returning', label: 'Returning', values: data.points.map((p) => p.returning) },
          { swatch: 'new', label: 'New', values: data.points.map((p) => p.new) },
          { swatch: 'unknown', label: 'Unknown', values: data.points.map((p) => p.unknown) },
        ],
        order: [1, 0, 2],
        percent: false,
        win: windowFor(ctx.range, ctx.meta.now, cap),
        ariaLabel: `Visits by new, returning and unknown visitors per ${intervalUnit(data.interval)}. ${f.num(totals.new)} new, ${f.num(totals.returning)} returning, ${f.num(totals.unknown)} unknown in total. Window: ${label.lower}.`,
        caption: `New vs returning visits per ${intervalUnit(data.interval)}, ${label.lower} (UTC)`,
      },
      view,
    ),
  );
  return wrap;
}

export function createNvrPanel(getCtx: () => Ctx, host: Host): Panel {
  let view: View = 'chart';
  const cap = (ctx: Ctx): number => ctx.meta.limits.newVsReturningMaxRangeDays;
  const spec: PanelSpec<NewVsReturningData> = {
    id: 'nvr',
    no: 3,
    title: 'New vs returning',
    className: 'p-nvr',
    eyebrow: (ctx) => `No. 3 · ${windowLabel(ctx.range, cap(ctx)).upper}`,
    reloadOnBadRequest: true,
    availability: (ctx) => unavailableOf(ctx.meta.widgets.newVsReturning),
    request: (ctx, signal) =>
      requestWindow<NewVsReturningData>(
        ctx,
        'new-vs-returning',
        signal,
        (w) => ({ from: w.from, to: w.to, interval: w.interval }),
        cap(ctx),
      ),
    isEmpty: (d) => d.totals.new + d.totals.returning + d.totals.unknown === 0,
    skeleton: () => {
      const b = el('div');
      append(b, skeletonHeadline(), skeletonChart(200));
      return b;
    },
    empty: (ctx) => {
      const block = emptyBlock({
        title: 'Nobody classified yet.',
        body: 'Visits count as new or returning only when consent was given and an identity was supplied.',
      });
      // An empty 31-day window must not be mistaken for an empty 90-day one.
      if (windowLabel(ctx.range, cap(ctx)).capped)
        block.appendChild(el('p', 'dy-note', capNote(cap(ctx))));
      return block;
    },
    ready: (d, ctx, api) => buildReady(d, ctx, api, view),
    summary: (d, ctx) =>
      `New vs returning loaded (${windowLabel(ctx.range, cap(ctx)).lower}): ${ctx.fmt.num(d.totals.new)} new, ${ctx.fmt.num(d.totals.returning)} returning, ${ctx.fmt.num(d.totals.unknown)} unknown`,
    tools: (_ctx, api) =>
      setViewTools(api, view, (v) => {
        view = v;
      }),
  };
  return createPanel(spec, getCtx, host);
}

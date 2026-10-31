import type { VisitsOverTimeData } from '../../protocol.js';
import { createChart } from '../charts/host.js';
import { intervalUnit, plainLabel, timeLabels } from '../charts/labels.js';
import { drawLineArea, type DrawResult } from '../charts/line-area.js';
import { numeralCollides } from '../charts/scales.js';
import { drawStackedAreas } from '../charts/stacked-area.js';
import type { Ctx, Host } from '../context.js';
import { append, el, visuallyHidden } from '../dom.js';
import { bucketEnd, parseInstant, tooltipTitle } from '../format.js';
import { createPanel, type Panel, type PanelApi, type PanelSpec } from '../panel.js';
import { windowFor } from '../ranges.js';
import { requestWindow, unavailableOf } from '../request.js';
import { emptyBlock, skeletonChart, skeletonHeadline } from '../states.js';
import {
  chartOrTable,
  legend,
  setViewTools,
  twinTable,
  type TwinColumn,
  type View,
} from '../widgets.js';
import { buildSplit, type SplitSeries } from './hero-split.js';

/** Chart height from the drawn width (docs/DESIGN.md 5.2: 220 / 260 / 300 / 340). */
function heroHeight(width: number): number {
  if (width >= 800) return 340;
  if (width >= 640) return 300;
  return width >= 400 ? 260 : 220;
}

function extremes(points: VisitsOverTimeData['points']): {
  max: number;
  min: number;
  maxAt: number;
  minAt: number;
} {
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  let maxAt = 0;
  let minAt = 0;
  points.forEach((p, i) => {
    if (p.visits > max) {
      max = p.visits;
      maxAt = i;
    }
    if (p.visits < min) {
      min = p.visits;
      minAt = i;
    }
  });
  return { max, min: Number.isFinite(min) ? min : 0, maxAt, minAt };
}

function describe(
  data: VisitsOverTimeData,
  ctx: Ctx,
  split: readonly SplitSeries[],
  splitLabel: string,
): string {
  const { points, interval, total } = data;
  const t = (i: number) => plainLabel(ctx.fmt, parseInstant(points[i]?.bucket ?? ''), interval);
  const x = extremes(points);
  const first = points.length ? t(0) : '';
  const last = points.length ? t(points.length - 1) : '';
  const by = split.length
    ? ` Split by ${splitLabel}: ${[...split]
        .reverse()
        .map((s) => `${s.name} ${ctx.fmt.num(s.total)}`)
        .join(', ')}.`
    : '';
  return `Visits per ${intervalUnit(interval)}, ${first} to ${last} UTC. Total ${ctx.fmt.num(total)}. Highest: ${t(x.maxAt)} with ${ctx.fmt.num(x.max)}. Lowest: ${t(x.minAt)} with ${ctx.fmt.num(x.min)}.${by}`;
}

interface HeroState {
  view: View;
  /** Selected breakdown key, or null for "None". Survives range changes. */
  split: string | null;
}

function splitLegend(series: readonly SplitSeries[], ctx: Ctx): HTMLElement {
  const ul = legend(
    [...series]
      .reverse()
      .map((s) => ({ swatch: s.swatch, label: s.name, value: ctx.fmt.num(s.total) })),
  );
  [...series].reverse().forEach((s, i) => {
    if (!s.note) return;
    const li = ul.children[i] as HTMLElement;
    li.setAttribute('title', s.note);
    li.appendChild(visuallyHidden(` ${s.note}`));
  });
  return ul;
}

function buildReady(
  data: VisitsOverTimeData,
  ctx: Ctx,
  api: PanelApi<VisitsOverTimeData>,
  ui: HeroState,
): HTMLElement {
  const f = ctx.fmt;
  const win = windowFor(ctx.range, ctx.meta.now);
  const times = data.points.map((p) => parseInstant(p.bucket));
  const values = data.points.map((p) => p.visits);
  const n = times.length;
  const lastT = times[n - 1] ?? 0;
  const inProgress = win ? bucketEnd(lastT, data.interval) > win.toMs : false;
  const breakdown = data.breakdown;
  const split = breakdown ? buildSplit(breakdown.key, breakdown.series) : [];
  const splitLabel =
    ctx.meta.breakdowns.find((b) => b.key === breakdown?.key)?.label ?? breakdown?.key ?? '';

  const wrap = el('div', 'dy-hero-wrap');
  const num = el('p', 'dy-hero-num');
  append(num, visuallyHidden('Total visits: '), document.createTextNode(f.num(data.total)));
  const x = extremes(data.points);
  const sub = el(
    'p',
    'dy-kpi-sub',
    `${plainLabel(f, times[x.maxAt] ?? 0, data.interval)} was the busiest ${intervalUnit(data.interval)}: ${f.num(x.max)} visits.`,
  );
  append(wrap, num, sub);

  const topToBottom = [...split].reverse();
  const xLabels = timeLabels(f, times, data.interval);
  const chart = createChart(
    {
      label: describe(data, ctx, split, splitLabel),
      height: heroHeight,
      draw: (w, h): DrawResult =>
        split.length
          ? drawStackedAreas(w, h, {
              series: split.map((s) => ({
                fill: s.fill,
                labelClass: s.labelClass,
                label: s.name,
                values: s.values,
              })),
              xLabels,
              compact: f.compact,
              labelIndex: inProgress ? n - 2 : n - 1,
            })
          : drawLineArea(w, h, { values, xLabels, inProgressLast: inProgress, compact: f.compact }),
      tip: (i) => ({
        title: tooltipTitle(f, times[i] ?? 0, data.interval, {
          last: inProgress && i === n - 1,
          first: i === 0,
          fromMs: win?.fromMs ?? 0,
        }),
        lines: split.length
          ? topToBottom.map((s) => ({
              swatch: s.swatch,
              text: `${s.name} ${f.num(s.values[i] ?? 0)}`,
            }))
          : [{ swatch: null, text: `${f.num(values[i] ?? 0)} visits` }],
      }),
      announce: (i) =>
        split.length
          ? `${plainLabel(f, times[i] ?? 0, data.interval)}: ${topToBottom.map((s) => `${s.name} ${s.values[i] ?? 0}`).join(', ')}`
          : `${plainLabel(f, times[i] ?? 0, data.interval)}: ${f.num(values[i] ?? 0)} visits`,
      onDraw: (r) => {
        // Measured on every draw (resize, range, split change); the class is set from scratch each time.
        const size = { w: num.offsetWidth, h: num.offsetHeight };
        const plotWidth = r.plot.right - r.plot.left;
        wrap.classList.toggle('dy-hero--stacked', numeralCollides(r.line, size, plotWidth));
        num.style.setProperty('--ny', `${chart.element.offsetTop + 6}px`);
      },
    },
    api.say,
  );
  const columns: TwinColumn[] = [
    { text: 'Period (UTC)', numeric: false },
    { text: 'Visits', numeric: true },
    ...topToBottom.map((s) => ({ text: s.name, numeric: true })),
  ];
  const table = twinTable(
    `Visits per ${intervalUnit(data.interval)}, ${ctx.range.short}${split.length ? `, split by ${splitLabel}` : ''}`,
    columns,
    data.points.map((p, i) => [
      plainLabel(f, times[i] ?? 0, data.interval),
      f.num(p.visits),
      ...topToBottom.map((s) => f.num(s.values[i] ?? 0)),
    ]),
  );
  const figure = el('figure', 'dy-figure');
  append(figure, chartOrTable(ui.view, chart.element, table));
  if (split.length) figure.appendChild(splitLegend(split, ctx));
  wrap.appendChild(figure);
  queueMicrotask(chart.redraw);
  return wrap;
}

function emptyHero(ctx: Ctx, host: Host): HTMLElement {
  const win = windowFor(ctx.range, ctx.meta.now);
  if (ctx.range.key === '90d') {
    const body = el('p');
    append(
      body,
      document.createTextNode('dynalitics has not stored a visit in the last 90 days. Call '),
      el('code', undefined, 'track()'),
      document.createTextNode(" from a route handler, check that your app's "),
      el('code', undefined, 'onError'),
      document.createTextNode(' is not reporting insert errors, then refresh.'),
    );
    const refresh = el('button', 'dy-btn', 'Refresh', { type: 'button' });
    refresh.addEventListener('click', host.refresh);
    return emptyBlock({ title: 'Nothing recorded yet.', body: '' }, [refresh], body);
  }
  const try90 = el('button', 'dy-btn', 'Try 90 days', { type: 'button' });
  try90.addEventListener('click', () => host.setRange('90d'));
  return emptyBlock(
    {
      title: 'The ledger is empty for this range.',
      body: win
        ? `No visits between ${win.from.slice(0, 10)} and ${win.to.slice(0, 10)} (UTC).`
        : 'No visits in this range.',
    },
    [try90],
  );
}

export function createHeroPanel(getCtx: () => Ctx, host: Host): Panel {
  const ui: HeroState = { view: 'chart', split: null };
  const activeSplit = (ctx: Ctx): string | null =>
    ui.split !== null && ctx.meta.breakdowns.some((b) => b.key === ui.split) ? ui.split : null;

  const spec: PanelSpec<VisitsOverTimeData> = {
    id: 'hero',
    no: 1,
    title: 'Visits over time',
    className: 'p-hero',
    sheet: true,
    eyebrow: (ctx) => `No. 1 · ${ctx.range.label}`,
    availability: (ctx) => unavailableOf(ctx.meta.widgets.visitsOverTime),
    request: async (ctx, signal) => {
      const key = activeSplit(ctx);
      const result = await requestWindow<VisitsOverTimeData>(
        ctx,
        'visits-over-time',
        signal,
        (w) => ({
          from: w.from,
          to: w.to,
          interval: w.interval,
          ...(key ? { breakdown: key } : {}),
        }),
      );
      if (result.kind === 'data') host.touchUpdated(result.meta.generatedAt);
      return result;
    },
    isEmpty: (d) => d.total === 0,
    skeleton: () => {
      const b = el('div');
      append(b, skeletonHeadline(), skeletonChart(220));
      return b;
    },
    empty: emptyHero,
    ready: (d, ctx, api) => buildReady(d, ctx, api, ui),
    summary: (d, ctx) => `Visits over time loaded: ${ctx.fmt.num(d.total)} visits`,
    tools: (ctx, api) => {
      const tools: Node[] = [];
      if (ctx.meta.breakdowns.length > 0) {
        const label = el('label', 'dy-split-lbl-sel');
        const select = el('select', 'dy-select');
        select.appendChild(el('option', undefined, 'None', { value: '' }));
        for (const b of ctx.meta.breakdowns) {
          select.appendChild(
            el('option', undefined, b.label, {
              value: b.key,
              ...(b.key === activeSplit(ctx) ? { selected: 'selected' } : {}),
            }),
          );
        }
        select.addEventListener('change', () => {
          ui.split = select.value === '' ? null : select.value;
          api.load();
        });
        append(label, el('span', 'dy-eyebrow', 'Split by'), select);
        tools.push(label);
      }
      tools.push(
        ...setViewTools(api, ui.view, (v) => {
          ui.view = v;
        }),
      );
      return tools;
    },
  };
  return createPanel(spec, getCtx, host);
}

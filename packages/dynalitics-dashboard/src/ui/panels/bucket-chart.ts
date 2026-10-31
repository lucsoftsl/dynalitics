import { createChart } from '../charts/host.js';
import { drawColumns } from '../charts/columns.js';
import { plainLabel, timeLabels } from '../charts/labels.js';
import type { Ctx } from '../context.js';
import { bucketEnd, pct, tooltipTitle } from '../format.js';
import type { Interval } from '../../protocol.js';
import type { PanelApi } from '../panel.js';
import type { Window } from '../ranges.js';
import { chartOrTable, legend, twinTable, type View } from '../widgets.js';
import { append, el } from '../dom.js';

export interface BucketSeries {
  /** Swatch suffix (`dy-sw-<swatch>`) and fill class (`f-<swatch>`). */
  readonly swatch: string;
  readonly label: string;
  readonly values: readonly number[];
}

export interface BucketChartInput {
  readonly interval: Interval;
  readonly times: readonly number[];
  /** Stack order, bottom to top. */
  readonly series: readonly BucketSeries[];
  /** Order used by tooltip, legend and table (indexes into `series`). */
  readonly order: readonly number[];
  readonly percent: boolean;
  readonly win: Window | null;
  readonly ariaLabel: string;
  readonly caption: string;
  /** Extra table column after the series (e.g. consent "Share of visits"). */
  readonly extra?: { readonly text: string; readonly cell: (i: number) => string };
  /** Explorer: click or Enter on a column (docs/DESIGN.md 14.3). */
  readonly onPick?: (i: number) => void;
}

const sumAt = (series: readonly BucketSeries[], i: number): number =>
  series.reduce((a, s) => a + (s.values[i] ?? 0), 0);

/** Stacked columns + legend + table twin shared by new-vs-returning and consent. */
export function bucketChart<T>(
  api: PanelApi<T>,
  ctx: Ctx,
  input: BucketChartInput,
  view: View,
): HTMLElement {
  const f = ctx.fmt;
  const { series, order, times, interval, win } = input;
  const at = (i: number) => plainLabel(f, times[i] ?? 0, interval);
  const chart = createChart(
    {
      label: input.ariaLabel,
      height: (w) => (w < 400 ? 180 : 200),
      draw: (w, h) =>
        drawColumns(w, h, {
          series: series.map((s) => ({ fill: `f-${s.swatch}`, values: s.values })),
          percent: input.percent,
          xLabels: timeLabels(f, times, interval),
          compact: f.compact,
        }),
      tip: (i) => {
        const total = sumAt(series, i);
        const last =
          i === times.length - 1 && win !== null && bucketEnd(times[i] ?? 0, interval) > win.toMs;
        return {
          title: tooltipTitle(f, times[i] ?? 0, interval, {
            last,
            first: i === 0,
            fromMs: win?.fromMs ?? 0,
          }),
          lines:
            total === 0
              ? [{ swatch: null, text: 'No visits' }]
              : order.map((k) => {
                  const s = series[k]!;
                  const v = s.values[i] ?? 0;
                  return { swatch: s.swatch, text: `${s.label} ${f.num(v)} (${pct(v / total)})` };
                }),
        };
      },
      announce: (i) =>
        `${at(i)}: ${series.map((s) => `${s.label.toLowerCase()} ${s.values[i] ?? 0}`).join(', ')}`,
      ...(input.onPick ? { onPick: input.onPick } : {}),
    },
    api.say,
  );
  const ordered = order.map((k) => series[k]!);
  const table = twinTable(
    input.caption,
    [
      { text: 'Period (UTC)', numeric: false },
      ...ordered.map((s) => ({ text: s.label, numeric: true })),
      ...(input.extra ? [{ text: input.extra.text, numeric: true }] : []),
    ],
    times.map((_, i) => [
      at(i),
      ...ordered.map((s) => f.num(s.values[i] ?? 0)),
      ...(input.extra ? [input.extra.cell(i)] : []),
    ]),
  );
  const wrap = el('div');
  append(
    wrap,
    legend(
      ordered.map((s) => ({
        swatch: s.swatch,
        label: s.label,
        value: f.num(s.values.reduce((a, b) => a + b, 0)),
      })),
    ),
    chartOrTable(view, chart.element, table),
  );
  queueMicrotask(chart.redraw);
  return wrap;
}

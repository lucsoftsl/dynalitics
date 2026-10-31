import { useCallback, type ReactElement } from 'react';
import type { Interval } from '../../protocol.js';
import { plainLabel, timeLabels } from '../../ui/charts/labels.js';
import type { Ctx } from '../../ui/context.js';
import { bucketEnd, pct, tooltipTitle } from '../../ui/format.js';
import type { Window } from '../../ui/ranges.js';
import { Chart } from '../charts/Chart.js';
import { drawColumns } from '../charts/geometry.js';
import { Legend, TwinTable, VizBody, type View } from '../widgets.js';

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
}

const sumAt = (series: readonly BucketSeries[], i: number): number =>
  series.reduce((a, s) => a + (s.values[i] ?? 0), 0);
const bucketHeight = (w: number): number => (w < 400 ? 180 : 200);

/** Stacked columns + legend + table twin shared by new-vs-returning and consent. `input` must be memoised. */
export function BucketChart(props: {
  ctx: Ctx;
  input: BucketChartInput;
  view: View;
  say: (text: string) => void;
}): ReactElement {
  const { ctx, input, view, say } = props;
  const f = ctx.fmt;
  const { series, order, times, interval, win } = input;
  const at = (i: number): string => plainLabel(f, times[i] ?? 0, interval);
  const draw = useCallback(
    (w: number, h: number) =>
      drawColumns(w, h, {
        series: series.map((s) => ({ fill: `f-${s.swatch}`, values: s.values })),
        percent: input.percent,
        xLabels: timeLabels(f, times, interval),
        compact: f.compact,
      }),
    [series, input.percent, f, times, interval],
  );
  const ordered = order.map((k) => series[k]).filter((s): s is BucketSeries => s !== undefined);
  return (
    <div>
      <Legend
        items={ordered.map((s) => ({
          swatch: s.swatch,
          label: s.label,
          value: f.num(s.values.reduce((a, b) => a + b, 0)),
        }))}
      />
      <VizBody>
        <Chart
          label={input.ariaLabel}
          height={bucketHeight}
          draw={draw}
          say={say}
          hidden={view !== 'chart'}
          tip={(i) => {
            const total = sumAt(series, i);
            const last =
              i === times.length - 1 &&
              win !== null &&
              bucketEnd(times[i] ?? 0, interval) > win.toMs;
            return {
              title: tooltipTitle(f, times[i] ?? 0, interval, {
                last,
                first: i === 0,
                fromMs: win?.fromMs ?? 0,
              }),
              lines:
                total === 0
                  ? [{ swatch: null, text: 'No visits' }]
                  : ordered.map((s) => {
                      const v = s.values[i] ?? 0;
                      return {
                        swatch: s.swatch,
                        text: `${s.label} ${f.num(v)} (${pct(v / total)})`,
                      };
                    }),
            };
          }}
          announce={(i) =>
            `${at(i)}: ${series.map((s) => `${s.label.toLowerCase()} ${s.values[i] ?? 0}`).join(', ')}`
          }
        />
        <TwinTable
          hidden={view !== 'table'}
          caption={input.caption}
          columns={[
            { text: 'Period (UTC)', numeric: false },
            ...ordered.map((s) => ({ text: s.label, numeric: true })),
            ...(input.extra ? [{ text: input.extra.text, numeric: true }] : []),
          ]}
          rows={times.map((_, i) => [
            at(i),
            ...ordered.map((s) => f.num(s.values[i] ?? 0)),
            ...(input.extra ? [input.extra.cell(i)] : []),
          ])}
        />
      </VizBody>
    </div>
  );
}

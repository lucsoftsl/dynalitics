import type { SearchHistogramData } from '../../protocol.js';
import { intervalUnit } from '../charts/labels.js';
import type { Ctx, Host } from '../context.js';
import { el } from '../dom.js';
import { parseInstant } from '../format.js';
import { createPanel, type Panel, type PanelSpec } from '../panel.js';
import { bucketChart, type BucketSeries } from '../panels/bucket-chart.js';
import { buildSplit } from '../panels/hero-split.js';
import { unavailableOf } from '../request.js';
import { emptyBlock, skeletonChart } from '../states.js';
import { setViewTools, type View } from '../widgets.js';
import { explorerGet, type ExplorerHost } from './host.js';
import { zoomInto } from './state.js';

export const NO_MATCHES = {
  title: 'No visits match this search.',
  body: 'Try fewer words, or a longer range.',
};

function seriesOf(data: SearchHistogramData): BucketSeries[] {
  if (!data.breakdown) {
    return [{ swatch: 'match', label: 'Matches', values: data.points.map((p) => p.visits) }];
  }
  return buildSplit(data.breakdown.key, data.breakdown.series).map((s) => ({
    swatch: s.swatch,
    label: s.name,
    values: s.values,
  }));
}

/** No. 1 of the explorer: matching visits per bucket, optionally split (docs/DESIGN.md 14.3). */
export function createHistogramPanel(getCtx: () => Ctx, host: Host, x: ExplorerHost): Panel {
  let view: View = 'chart';
  const spec: PanelSpec<SearchHistogramData> = {
    id: 'xhist',
    no: 1,
    title: 'Matches over time',
    className: 'p-xhist',
    availability: (ctx) =>
      ctx.meta.widgets.explorer ? unavailableOf(ctx.meta.widgets.explorer) : null,
    request: (ctx, signal, panel) =>
      explorerGet<SearchHistogramData>(ctx, x, 'search/histogram', signal, panel, (w) => ({
        interval: w.interval,
        ...(x.state().split ? { split: x.state().split as string } : {}),
      })),
    isEmpty: (d) => d.total === 0,
    skeleton: () => skeletonChart(200),
    empty: () => emptyBlock(NO_MATCHES),
    ready: (data, ctx, api) => {
      const f = ctx.fmt;
      const times = data.points.map((p) => parseInstant(p.bucket));
      const series = seriesOf(data);
      const win = x.window(ctx);
      const unit = intervalUnit(data.interval);
      const zoomable = win !== null && data.interval !== 'hour';
      const wrap = el('div');
      wrap.appendChild(
        bucketChart(
          api,
          ctx,
          {
            interval: data.interval,
            times,
            series,
            order: series.map((_, i) => i),
            percent: false,
            win,
            ariaLabel: `Matching visits per ${unit}: ${f.num(data.total)} in total.${zoomable ? ' Press Enter on a period to zoom into it.' : ''}`,
            caption: `Matching visits per ${unit}`,
            ...(zoomable
              ? {
                  onPick: (i: number) => {
                    const z = zoomInto(times[i] ?? 0, data.interval, win);
                    if (z) x.zoom(z);
                  },
                }
              : {}),
          },
          view,
        ),
      );
      return wrap;
    },
    summary: (d, ctx) => `Matches over time loaded: ${ctx.fmt.num(d.total)} visits`,
    tools: (_ctx, api) =>
      setViewTools(api, view, (v) => {
        view = v;
      }),
  };
  return createPanel(spec, getCtx, host);
}

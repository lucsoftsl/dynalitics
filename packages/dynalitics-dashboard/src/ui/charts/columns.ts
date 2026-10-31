import { svg } from '../dom.js';
import { drawXAxis, drawYAxis, type XLabel } from './axes.js';
import type { DrawResult } from './line-area.js';
import { bandLayout, createPlot, fmtNum, niceScale } from './scales.js';

export interface ColumnSeries {
  /** Fill class, e.g. `f-new`; the pattern/colour lives in CSS. */
  readonly fill: string;
  readonly values: readonly number[];
}

export interface ColumnsInput {
  /** Stack order, bottom to top. */
  readonly series: readonly ColumnSeries[];
  readonly percent: boolean;
  readonly xLabels: (centers: readonly number[]) => readonly XLabel[];
  readonly compact: (n: number) => string;
}

const PERCENT_SCALE = { step: 0.5, yMax: 1, ticks: [0, 0.5, 1] } as const;

/** Stacked columns, absolute or 100%. Empty percent buckets draw a stub so empty is visible. */
export function drawColumns(width: number, height: number, input: ColumnsInput): DrawResult {
  const plot = createPlot(width, height);
  const n = input.series[0]?.values.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) =>
    input.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const scale = input.percent ? PERCENT_SCALE : niceScale(Math.max(0, ...totals));
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-hidden': 'true',
  });
  const label = input.percent ? (v: number) => `${Math.round(v * 100)}%` : input.compact;
  drawYAxis(root, plot, scale, { yLabel: label, yRatio: (v) => v / scale.yMax });
  const bands = bandLayout(plot, n);
  const centers = bands.xs.map((x) => x + bands.bandWidth / 2);
  drawXAxis(root, plot, input.xLabels(centers));

  const span = plot.bottom - plot.top;
  bands.xs.forEach((x, i) => {
    const total = totals[i] ?? 0;
    if (input.percent && total === 0) {
      const y = plot.bottom - 1;
      svg(
        'line',
        { class: 'stub', x1: fmtNum(x), x2: fmtNum(x + bands.bandWidth), y1: y, y2: y },
        root,
      );
      return;
    }
    let top = plot.bottom;
    for (const s of input.series) {
      const raw = s.values[i] ?? 0;
      if (raw <= 0) continue;
      const h = ((input.percent ? raw / total : raw) / scale.yMax) * span;
      top -= h;
      const rect = svg(
        'rect',
        {
          class: `seg dy-col ${s.fill}`,
          x: fmtNum(x),
          y: fmtNum(top),
          width: fmtNum(bands.bandWidth),
          height: fmtNum(h),
        },
        root,
      );
      rect.style.setProperty('--i', String(Math.min(i, 30)));
    }
  });
  return { svg: root, plot, centers, yMax: scale.yMax, line: [] };
}

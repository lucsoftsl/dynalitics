import { svg } from '../dom.js';
import { drawXAxis, drawYAxis, type XLabel } from './axes.js';
import type { DrawResult } from './line-area.js';
import { createPlot, fmtNum, niceScale, pointXs } from './scales.js';

export interface AreaSeries {
  /** Fill class (`f-cat1`, `f-granted`, `f-other`...). */
  readonly fill: string;
  /** Class for the direct label text, or null for hatched/dotted bands (the legend names those). */
  readonly labelClass: string | null;
  readonly label: string;
  readonly values: readonly number[];
}

export interface StackedAreaInput {
  /** Stack order, bottom to top (the server's order, never re-sorted). */
  readonly series: readonly AreaSeries[];
  readonly xLabels: (xs: readonly number[]) => readonly XLabel[];
  readonly compact: (n: number) => string;
  /** Index of the last complete bucket: the bucket that carries the direct labels. */
  readonly labelIndex: number;
}

const MIN_LABEL_BAND = 20;
const MAX_LABEL_CHARS = 12;

export const ellipsize = (text: string, max = MAX_LABEL_CHARS): string =>
  [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;

/** Stacked areas separated by a 1.5 px stroke; bands >= 20 px tall get a direct label (docs/DESIGN.md 6.3). */
export function drawStackedAreas(
  width: number,
  height: number,
  input: StackedAreaInput,
): DrawResult {
  const plot = createPlot(width, height);
  const n = input.series[0]?.values.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) =>
    input.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const scale = niceScale(Math.max(0, ...totals));
  const span = plot.bottom - plot.top;
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-hidden': 'true',
  });
  drawYAxis(root, plot, scale, { yLabel: input.compact, yRatio: (v) => v / scale.yMax });
  const xs = pointXs(plot, n);
  drawXAxis(root, plot, input.xLabels(xs));

  const yFor = (v: number): number => plot.bottom - (v / scale.yMax) * span;
  let lower = new Array<number>(n).fill(0);
  const labels: { x: number; y: number; text: string; cls: string }[] = [];
  for (const s of input.series) {
    const upper = lower.map((base, i) => base + (s.values[i] ?? 0));
    const top = xs.map((x, i) => `${fmtNum(x)},${fmtNum(yFor(upper[i] ?? 0))}`);
    const bottom = xs.map((x, i) => `${fmtNum(x)},${fmtNum(yFor(lower[i] ?? 0))}`).reverse();
    if (n >= 2)
      svg('polygon', { class: `seg ${s.fill}`, points: [...top, ...bottom].join(' ') }, root);
    else if (n === 1)
      svg(
        'rect',
        {
          class: `seg ${s.fill}`,
          x: fmtNum(plot.left),
          width: fmtNum(plot.right - plot.left),
          y: fmtNum(yFor(upper[0] ?? 0)),
          height: fmtNum(yFor(lower[0] ?? 0) - yFor(upper[0] ?? 0)),
        },
        root,
      );
    const i = Math.min(Math.max(input.labelIndex, 0), n - 1);
    const band = yFor(lower[i] ?? 0) - yFor(upper[i] ?? 0);
    if (s.labelClass && band >= MIN_LABEL_BAND) {
      labels.push({
        x: (xs[i] ?? plot.right) - 8,
        y: yFor(upper[i] ?? 0) + band / 2 + 4,
        text: ellipsize(s.label),
        cls: s.labelClass,
      });
    }
    lower = upper;
  }
  for (const l of labels) {
    const t = svg('text', { class: `band-label ${l.cls}`, x: fmtNum(l.x), y: fmtNum(l.y) }, root);
    t.textContent = l.text;
  }
  return {
    svg: root,
    plot,
    centers: xs,
    yMax: scale.yMax,
    line: xs.map((x, i) => ({ x, y: yFor(totals[i] ?? 0) })),
  };
}

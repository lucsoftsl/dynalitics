import { svg } from '../dom.js';
import { drawXAxis, drawYAxis, type XLabel } from './axes.js';
import { createPlot, fmtNum, niceScale, pointXs, type Plot } from './scales.js';

export interface DrawResult {
  readonly svg: SVGSVGElement;
  readonly plot: Plot;
  /** x centre of every bucket, used for pointer and keyboard exploration. */
  readonly centers: readonly number[];
  readonly yMax: number;
  /** Top contour of the data in svg pixels, for the hero numeral collision test. */
  readonly line: readonly { x: number; y: number }[];
}

export interface LineAreaInput {
  readonly values: readonly number[];
  readonly xLabels: (xs: readonly number[]) => readonly XLabel[];
  readonly inProgressLast: boolean;
  readonly compact: (n: number) => string;
}

/** Area + line chart of one series (the hero). The in-progress last bucket is hollow and dashed. */
export function drawLineArea(width: number, height: number, input: LineAreaInput): DrawResult {
  const plot = createPlot(width, height);
  const n = input.values.length;
  const scale = niceScale(Math.max(0, ...input.values));
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-hidden': 'true',
  });
  drawYAxis(root, plot, scale, { yLabel: input.compact, yRatio: (v) => v / scale.yMax });
  const xs = pointXs(plot, n);
  drawXAxis(root, plot, input.xLabels(xs));

  const ys = input.values.map((v) => plot.bottom - (v / scale.yMax) * (plot.bottom - plot.top));
  const pts = xs.map((x, i) => `${fmtNum(x)},${fmtNum(ys[i] ?? plot.bottom)}`);
  if (n >= 2) {
    const last = pts.length - 1;
    const solid = input.inProgressLast ? pts.slice(0, last) : pts;
    svg(
      'polygon',
      {
        class: 'area',
        points: `${fmtNum(plot.left)},${plot.bottom} ${pts.join(' ')} ${fmtNum(plot.right)},${plot.bottom}`,
      },
      root,
    );
    if (solid.length >= 2) svg('polyline', { class: 'line', points: solid.join(' ') }, root);
    if (input.inProgressLast)
      svg('polyline', { class: 'line-dash', points: pts.slice(last - 1).join(' ') }, root);
  }
  const lastX = xs[n - 1];
  const lastY = ys[n - 1];
  if (input.inProgressLast && lastX !== undefined && lastY !== undefined) {
    svg('circle', { class: 'mark-now', cx: fmtNum(lastX), cy: fmtNum(lastY), r: 4 }, root);
  } else if (n === 1 && lastX !== undefined && lastY !== undefined) {
    svg('circle', { class: 'cross-dot', cx: fmtNum(lastX), cy: fmtNum(lastY), r: 4 }, root);
  }
  return {
    svg: root,
    plot,
    centers: xs,
    yMax: scale.yMax,
    line: xs.map((x, i) => ({ x, y: ys[i] ?? plot.bottom })),
  };
}

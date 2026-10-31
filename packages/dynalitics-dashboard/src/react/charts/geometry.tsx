// SVG for the three chart kinds, as JSX. Geometry comes from the pure helpers in src/ui/charts/scales.ts;
// test/react/parity.test.tsx compares the result with the HTML dashboard's DOM drawers.
import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { XLabel } from '../../ui/charts/axes.js';
import { ellipsize } from '../../ui/charts/stacked-area.js';
import {
  bandLayout,
  createPlot,
  fmtNum,
  niceScale,
  pointXs,
  type NiceScale,
  type Plot,
  type Pt,
} from '../../ui/charts/scales.js';
import { cssVars } from '../css-vars.js';

export interface ChartDrawing {
  /** Children of the chart's `<svg>`. */
  readonly content: ReactNode;
  readonly plot: Plot;
  /** x centre of every bucket, used for pointer and keyboard exploration. */
  readonly centers: readonly number[];
  readonly yMax: number;
  /** Top contour of the data in svg pixels, for the hero numeral collision test. */
  readonly line: readonly Pt[];
}

interface YAxisProps {
  readonly plot: Plot;
  readonly scale: NiceScale;
  readonly yLabel: (v: number) => string;
  readonly yRatio: (v: number) => number;
}

function YAxis({ plot, scale, yLabel, yRatio }: YAxisProps): ReactElement {
  return (
    <>
      {scale.ticks.map((tick) => {
        const y = fmtNum(plot.bottom - yRatio(tick) * (plot.bottom - plot.top));
        return (
          <Fragment key={tick}>
            <line
              className={tick === 0 ? 'base-l' : 'grid-l'}
              x1={plot.left}
              x2={plot.right}
              y1={y}
              y2={y}
            />
            <text className="ax" x={plot.left - 8} y={Number(y) + 4} textAnchor="end">
              {yLabel(tick)}
            </text>
          </Fragment>
        );
      })}
    </>
  );
}

function XAxis({ plot, labels }: { plot: Plot; labels: readonly XLabel[] }): ReactElement {
  return (
    <>
      {labels.map(({ x, text }) => (
        <Fragment key={`${x}-${text}`}>
          <line
            className="base-l"
            x1={fmtNum(x)}
            x2={fmtNum(x)}
            y1={plot.bottom}
            y2={plot.bottom + 4}
          />
          <text
            className="ax"
            x={fmtNum(x)}
            y={plot.bottom + 20}
            textAnchor={x > plot.right - 20 ? 'end' : 'middle'}
          >
            {text}
          </text>
        </Fragment>
      ))}
    </>
  );
}

export interface LineAreaInput {
  readonly values: readonly number[];
  readonly xLabels: (xs: readonly number[]) => readonly XLabel[];
  readonly inProgressLast: boolean;
  readonly compact: (n: number) => string;
}

/** Area + line chart of one series (the hero). The in-progress last bucket is hollow and dashed. */
export function drawLineArea(width: number, height: number, input: LineAreaInput): ChartDrawing {
  const plot = createPlot(width, height);
  const n = input.values.length;
  const scale = niceScale(Math.max(0, ...input.values));
  const xs = pointXs(plot, n);
  const ys = input.values.map((v) => plot.bottom - (v / scale.yMax) * (plot.bottom - plot.top));
  const pts = xs.map((x, i) => `${fmtNum(x)},${fmtNum(ys[i] ?? plot.bottom)}`);
  const last = pts.length - 1;
  const solid = input.inProgressLast ? pts.slice(0, last) : pts;
  const lastX = xs[n - 1];
  const lastY = ys[n - 1];
  const content = (
    <>
      <YAxis plot={plot} scale={scale} yLabel={input.compact} yRatio={(v) => v / scale.yMax} />
      <XAxis plot={plot} labels={input.xLabels(xs)} />
      {n >= 2 ? (
        <>
          <polygon
            className="area"
            points={`${fmtNum(plot.left)},${plot.bottom} ${pts.join(' ')} ${fmtNum(plot.right)},${plot.bottom}`}
          />
          {solid.length >= 2 ? <polyline className="line" points={solid.join(' ')} /> : null}
          {input.inProgressLast ? (
            <polyline className="line-dash" points={pts.slice(last - 1).join(' ')} />
          ) : null}
        </>
      ) : null}
      {input.inProgressLast && lastX !== undefined && lastY !== undefined ? (
        <circle className="mark-now" cx={fmtNum(lastX)} cy={fmtNum(lastY)} r={4} />
      ) : n === 1 && lastX !== undefined && lastY !== undefined ? (
        <circle className="cross-dot" cx={fmtNum(lastX)} cy={fmtNum(lastY)} r={4} />
      ) : null}
    </>
  );
  return {
    content,
    plot,
    centers: xs,
    yMax: scale.yMax,
    line: xs.map((x, i) => ({ x, y: ys[i] ?? plot.bottom })),
  };
}

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

const PERCENT_SCALE: NiceScale = { step: 0.5, yMax: 1, ticks: [0, 0.5, 1] };

/** Stacked columns, absolute or 100%. Empty percent buckets draw a stub so empty is visible. */
export function drawColumns(width: number, height: number, input: ColumnsInput): ChartDrawing {
  const plot = createPlot(width, height);
  const n = input.series[0]?.values.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) =>
    input.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const scale = input.percent ? PERCENT_SCALE : niceScale(Math.max(0, ...totals));
  const label = input.percent ? (v: number) => `${Math.round(v * 100)}%` : input.compact;
  const bands = bandLayout(plot, n);
  const centers = bands.xs.map((x) => x + bands.bandWidth / 2);
  const span = plot.bottom - plot.top;
  const columns = bands.xs.map((x, i) => {
    const total = totals[i] ?? 0;
    if (input.percent && total === 0) {
      const y = plot.bottom - 1;
      return (
        <line
          key={i}
          className="stub"
          x1={fmtNum(x)}
          x2={fmtNum(x + bands.bandWidth)}
          y1={y}
          y2={y}
        />
      );
    }
    let top = plot.bottom;
    const rects: ReactElement[] = [];
    input.series.forEach((s, k) => {
      const raw = s.values[i] ?? 0;
      if (raw <= 0) return;
      const h = ((input.percent ? raw / total : raw) / scale.yMax) * span;
      top -= h;
      rects.push(
        <rect
          key={k}
          className={`seg dy-col ${s.fill}`}
          x={fmtNum(x)}
          y={fmtNum(top)}
          width={fmtNum(bands.bandWidth)}
          height={fmtNum(h)}
          style={cssVars({ '--i': String(Math.min(i, 30)) })}
        />,
      );
    });
    return <Fragment key={i}>{rects}</Fragment>;
  });
  const content = (
    <>
      <YAxis plot={plot} scale={scale} yLabel={label} yRatio={(v) => v / scale.yMax} />
      <XAxis plot={plot} labels={input.xLabels(centers)} />
      {columns}
    </>
  );
  return { content, plot, centers, yMax: scale.yMax, line: [] };
}

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

/** Stacked areas separated by a 1.5 px stroke; bands >= 20 px tall get a direct label (docs/DESIGN.md 6.3). */
export function drawStackedAreas(
  width: number,
  height: number,
  input: StackedAreaInput,
): ChartDrawing {
  const plot = createPlot(width, height);
  const n = input.series[0]?.values.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) =>
    input.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const scale = niceScale(Math.max(0, ...totals));
  const span = plot.bottom - plot.top;
  const xs = pointXs(plot, n);
  const yFor = (v: number): number => plot.bottom - (v / scale.yMax) * span;
  let lower = new Array<number>(n).fill(0);
  const bands: ReactElement[] = [];
  const labels: { x: number; y: number; text: string; cls: string }[] = [];
  input.series.forEach((s, k) => {
    const upper = lower.map((base, i) => base + (s.values[i] ?? 0));
    const top = xs.map((x, i) => `${fmtNum(x)},${fmtNum(yFor(upper[i] ?? 0))}`);
    const bottom = xs.map((x, i) => `${fmtNum(x)},${fmtNum(yFor(lower[i] ?? 0))}`).reverse();
    if (n >= 2)
      bands.push(
        <polygon key={k} className={`seg ${s.fill}`} points={[...top, ...bottom].join(' ')} />,
      );
    else if (n === 1)
      bands.push(
        <rect
          key={k}
          className={`seg ${s.fill}`}
          x={fmtNum(plot.left)}
          width={fmtNum(plot.right - plot.left)}
          y={fmtNum(yFor(upper[0] ?? 0))}
          height={fmtNum(yFor(lower[0] ?? 0) - yFor(upper[0] ?? 0))}
        />,
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
  });
  const content = (
    <>
      <YAxis plot={plot} scale={scale} yLabel={input.compact} yRatio={(v) => v / scale.yMax} />
      <XAxis plot={plot} labels={input.xLabels(xs)} />
      {bands}
      {labels.map((l, k) => (
        <text key={k} className={`band-label ${l.cls}`} x={fmtNum(l.x)} y={fmtNum(l.y)}>
          {l.text}
        </text>
      ))}
    </>
  );
  return {
    content,
    plot,
    centers: xs,
    yMax: scale.yMax,
    line: xs.map((x, i) => ({ x, y: yFor(totals[i] ?? 0) })),
  };
}

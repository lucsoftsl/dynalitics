export interface NiceScale {
  readonly step: number;
  readonly yMax: number;
  readonly ticks: readonly number[];
}

/** Smallest 1/2/5 x 10^k step that yields at most 3 intervals; always starts at 0. */
export function niceScale(max: number): NiceScale {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  if (safeMax === 0) return { step: 1, yMax: 4, ticks: [0, 1, 2, 3, 4] };
  const target = safeMax / 3;
  const pow = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target) ?? 10 * pow;
  const yMax = step * Math.ceil(safeMax / step);
  const ticks: number[] = [];
  for (let v = 0; v <= yMax + step / 2; v += step) ticks.push(v);
  return { step, yMax, ticks };
}

/** Every k-th bucket is labelled (k >= 1) so labels sit at least `minPx` apart. */
export function labelStep(pxPerBucket: number, minPx = 64): number {
  if (!(pxPerBucket > 0)) return 1;
  return Math.max(1, Math.ceil(minPx / pxPerBucket));
}

/** Indexes to label: first, then every k-th; the last is dropped when it would crowd the previous. */
export function labelIndexes(count: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  const last = count - 1;
  if (last > 0 && !out.includes(last) && last - (out[out.length - 1] ?? 0) >= step) out.push(last);
  return out;
}

export interface Plot {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const MARGIN = { top: 8, right: 8, bottom: 28, left: 40 } as const;

export function createPlot(width: number, height: number): Plot {
  return {
    width,
    height,
    left: MARGIN.left,
    right: width - MARGIN.right,
    top: MARGIN.top,
    bottom: height - MARGIN.bottom,
  };
}

/** x centres of `n` points laid out on a line (n = 1 centres it). */
export function pointXs(plot: Plot, n: number): number[] {
  const span = plot.right - plot.left;
  if (n <= 1) return [plot.left + span / 2];
  return Array.from({ length: n }, (_, i) => plot.left + (i * span) / (n - 1));
}

export interface Bands {
  readonly xs: readonly number[];
  readonly bandWidth: number;
  readonly gap: number;
}

/** x left edges of `n` columns; gap shrinks to 1 px when columns get narrow, band floors at 2 px. */
export function bandLayout(plot: Plot, n: number): Bands {
  const span = plot.right - plot.left;
  let gap = 2;
  let bandWidth = (span - gap * (n - 1)) / n;
  if (bandWidth < 6) {
    gap = 1;
    bandWidth = (span - gap * (n - 1)) / n;
  }
  bandWidth = Math.max(2, bandWidth);
  return {
    xs: Array.from({ length: n }, (_, i) => plot.left + i * (bandWidth + gap)),
    bandWidth,
    gap,
  };
}

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Highest on-screen point (smallest y) of any polyline segment inside the box's x range. */
export function lineMeetsBox(line: readonly Pt[], box: Box): boolean {
  const first = line[0];
  if (first && line.length === 1)
    return first.x >= box.left && first.x <= box.right && first.y < box.bottom;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    const [p, q] = a.x <= b.x ? [a, b] : [b, a];
    if (q.x < box.left || p.x > box.right) continue;
    const yAt = (x: number): number =>
      q.x === p.x ? Math.min(p.y, q.y) : p.y + ((q.y - p.y) * (x - p.x)) / (q.x - p.x);
    const minY = Math.min(yAt(Math.max(p.x, box.left)), yAt(Math.min(q.x, box.right)));
    if (minY < box.bottom) return true;
  }
  return false;
}

export const NUMERAL_ORIGIN = { left: 48, top: 6 } as const;
const NUMERAL_MARGIN = 12;
const NUMERAL_MAX_SHARE = 0.6;

/**
 * docs/DESIGN.md 7.6: the numeral overlays the plot's upper left unless it would meet the line.
 * No usable measurement, or a numeral wider than 60% of the plot, also counts as a collision.
 */
export function numeralCollides(
  line: readonly Pt[],
  size: { w: number; h: number } | null,
  plotWidth: number,
): boolean {
  if (!size || !(size.w > 0) || !(size.h > 0) || !(plotWidth > 0)) return true;
  if (size.w > plotWidth * NUMERAL_MAX_SHARE) return true;
  return lineMeetsBox(line, {
    left: NUMERAL_ORIGIN.left - NUMERAL_MARGIN,
    top: NUMERAL_ORIGIN.top - NUMERAL_MARGIN,
    right: NUMERAL_ORIGIN.left + size.w + NUMERAL_MARGIN,
    bottom: NUMERAL_ORIGIN.top + size.h + NUMERAL_MARGIN,
  });
}

export function fmtNum(n: number): string {
  return String(Math.round(n * 10) / 10);
}

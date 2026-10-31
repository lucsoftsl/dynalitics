import { svg } from '../dom.js';
import { fmtNum, type NiceScale, type Plot } from './scales.js';

export interface XLabel {
  readonly x: number;
  readonly text: string;
}

export interface AxisOptions {
  readonly yLabel: (v: number) => string;
  readonly yRatio: (v: number) => number;
}

/** Gridlines, baseline and y labels; the y axis starts at 0 and each tick is a round number. */
export function drawYAxis(
  parent: SVGElement,
  plot: Plot,
  scale: NiceScale,
  opts: AxisOptions,
): void {
  for (const tick of scale.ticks) {
    const y = fmtNum(plot.bottom - opts.yRatio(tick) * (plot.bottom - plot.top));
    svg(
      'line',
      { class: tick === 0 ? 'base-l' : 'grid-l', x1: plot.left, x2: plot.right, y1: y, y2: y },
      parent,
    );
    const label = svg(
      'text',
      { class: 'ax', x: plot.left - 8, y: Number(y) + 4, 'text-anchor': 'end' },
      parent,
    );
    label.textContent = opts.yLabel(tick);
  }
}

export function drawXAxis(parent: SVGElement, plot: Plot, labels: readonly XLabel[]): void {
  for (const { x, text } of labels) {
    svg(
      'line',
      { class: 'base-l', x1: fmtNum(x), x2: fmtNum(x), y1: plot.bottom, y2: plot.bottom + 4 },
      parent,
    );
    const anchor = x > plot.right - 20 ? 'end' : 'middle';
    const node = svg(
      'text',
      { class: 'ax', x: fmtNum(x), y: plot.bottom + 20, 'text-anchor': anchor },
      parent,
    );
    node.textContent = text;
  }
}

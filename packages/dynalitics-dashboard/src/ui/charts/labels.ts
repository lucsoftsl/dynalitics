import type { Interval } from '../../protocol.js';
import { axisLabel, type Formatters } from '../format.js';
import type { XLabel } from './axes.js';
import { labelIndexes, labelStep } from './scales.js';

/** X labels for time buckets: spaced >= 64 px apart, first always labelled (docs/DESIGN.md 7.3). */
export function timeLabels(
  f: Formatters,
  times: readonly number[],
  interval: Interval,
): (xs: readonly number[]) => readonly XLabel[] {
  return (xs) => {
    const pxPer = xs.length > 1 ? Math.abs((xs[1] ?? 0) - (xs[0] ?? 0)) : 64;
    return labelIndexes(xs.length, labelStep(pxPer)).map((i) => ({
      x: xs[i] ?? 0,
      text: axisLabel(f, times[i] ?? 0, interval, i === 0),
    }));
  };
}

const UNIT: Record<Interval, string> = { hour: 'hour', day: 'day', week: 'week', month: 'month' };

export function intervalUnit(interval: Interval): string {
  return UNIT[interval];
}

/** Short label used in announcements and summaries ("25 Oct" or "25 Oct 14:00"). */
export function plainLabel(f: Formatters, t: number, interval: Interval): string {
  return interval === 'hour' ? `${f.day(t)} ${f.hour(t)}` : f.day(t);
}

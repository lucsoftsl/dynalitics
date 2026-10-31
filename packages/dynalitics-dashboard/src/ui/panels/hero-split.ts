import type { BreakdownSeries } from '../../protocol.js';

/** One band of the split-by chart, already mapped to colours, patterns and display text. */
export interface SplitSeries {
  readonly name: string;
  /** Swatch suffix (`dy-sw-<swatch>`), shared by legend and tooltip. */
  readonly swatch: string;
  readonly fill: string;
  /** Direct-label class; null for solid-but-unlabelled, hatched and dotted bands. */
  readonly labelClass: string | null;
  readonly values: readonly number[];
  readonly total: number;
  /** Explanation shown as `title` and hidden text (docs/DESIGN.md 6.3, F-37). */
  readonly note?: string;
}

const MAX_NAMED = 5;
export const NO_VALUE_NOTE = 'Rows without a value for this field.';

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const valuesOf = (s: BreakdownSeries): number[] => s.points.map((p) => p.visits);
const addInto = (a: readonly number[], b: readonly number[]): number[] =>
  a.map((v, i) => v + (b[i] ?? 0));

function build(partial: Omit<SplitSeries, 'total'>): SplitSeries {
  return { ...partial, total: sum(partial.values) };
}

/**
 * Server order is the stack order (bottom to top), never re-sorted or re-coloured by size.
 * Custom keys get --cat-1..5 in that order; any further named values are folded into "Other"
 * so a colour never identifies two series.
 */
export function buildSplit(key: string, series: readonly BreakdownSeries[]): SplitSeries[] {
  const out: SplitSeries[] = [];
  let named = 0;
  let spill: number[] | null = null;
  let otherAt = -1;
  for (const s of series) {
    const values = valuesOf(s);
    if (s.isOther) {
      otherAt = out.length;
      out.push(
        build({ name: 'Other', swatch: 'other', fill: 'f-other', labelClass: null, values }),
      );
    } else if (s.value === null) {
      out.push(
        build({
          name: 'No value',
          swatch: 'unknown',
          fill: 'f-none',
          labelClass: null,
          values,
          note: NO_VALUE_NOTE,
        }),
      );
    } else if (key === 'consent') {
      const granted = s.value === 'true';
      out.push(
        build({
          name: granted ? 'Granted' : 'Declined',
          swatch: granted ? 'granted' : 'declined',
          fill: granted ? 'f-granted' : 'f-declined',
          labelClass: null,
          values,
        }),
      );
    } else if (named < MAX_NAMED) {
      named += 1;
      out.push(
        build({
          name: s.value,
          swatch: `cat${named}`,
          fill: `f-cat${named}`,
          labelClass: `on-cat${named}`,
          values,
        }),
      );
    } else {
      spill = spill ? addInto(spill, values) : values;
    }
  }
  if (spill) {
    if (otherAt >= 0) {
      const existing = out[otherAt] as SplitSeries;
      out[otherAt] = build({ ...existing, values: addInto(existing.values, spill) });
    } else {
      out.push(
        build({ name: 'Other', swatch: 'other', fill: 'f-other', labelClass: null, values: spill }),
      );
    }
  }
  return out;
}

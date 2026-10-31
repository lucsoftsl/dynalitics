import type { ReactElement, ReactNode } from 'react';
import { cx } from './css-vars.js';

export type View = 'chart' | 'table';

/** Chart | Table switch: two aria-pressed buttons, both always visible (docs/DESIGN.md 9.2). */
export function ViewToggle(props: { current: View; set: (v: View) => void }): ReactElement {
  return (
    <div className="dy-toggle" role="group" aria-label="Show as">
      {(
        [
          ['chart', 'Chart'],
          ['table', 'Table'],
        ] as const
      ).map(([view, label]) => (
        <button
          key={view}
          type="button"
          className="dy-btn"
          aria-pressed={props.current === view}
          onClick={() => props.set(view)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export interface TwinColumn {
  readonly text: string;
  readonly numeric: boolean;
}

/** The data-table twin of a chart: real table, caption, scoped headers. */
export function TwinTable(props: {
  caption: string;
  columns: readonly TwinColumn[];
  rows: readonly (readonly string[])[];
  hidden: boolean;
}): ReactElement {
  return (
    <div className="dy-table-wrap" hidden={props.hidden}>
      <table className="dy-twin">
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((c, i) => (
              <th key={i} className={cx(c.numeric && 'n')} scope="col">
                {c.text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cx(props.columns[i]?.numeric && 'n')}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface LegendItem {
  readonly swatch: string;
  readonly label: string;
  readonly value: string;
  /** Explanation shown as `title` and as hidden text. */
  readonly note?: string | undefined;
}

export function Legend(props: { items: readonly LegendItem[] }): ReactElement {
  return (
    <ul className="dy-legend">
      {props.items.map((item, i) => (
        <li key={i} title={item.note}>
          <span className={`dy-sw dy-sw-${item.swatch}`} aria-hidden="true" />
          {`${item.label} `}
          <b>{item.value}</b>
          {item.note ? <span className="vh">{` ${item.note}`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export interface SplitSegment {
  readonly swatch: string;
  readonly value: number;
}

/** Proportional bar built from flex children; patterns come from the swatch classes. */
export function SplitBar(props: {
  segments: readonly SplitSegment[];
  label: string;
}): ReactElement {
  return (
    <div className="dy-bar-split" role="img" aria-label={props.label}>
      {props.segments
        .filter((seg) => seg.value > 0)
        .map((seg) => (
          <span
            key={seg.swatch}
            className={`dy-sw-${seg.swatch}`}
            style={{ flexGrow: seg.value }}
          />
        ))}
    </div>
  );
}

/** The chart and its table twin; the inactive one is `hidden`. */
export function VizBody(props: { children: ReactNode }): ReactElement {
  return <div className="dy-viz-body">{props.children}</div>;
}

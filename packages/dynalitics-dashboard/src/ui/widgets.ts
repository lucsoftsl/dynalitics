import { append, el, swatch } from './dom.js';
import type { PanelApi } from './panel.js';

export type View = 'chart' | 'table';

/** Chart | Table switch: two aria-pressed buttons, both always visible (docs/DESIGN.md 9.2). */
export function viewToggle(current: View, set: (v: View) => void): HTMLElement {
  const group = el('div', 'dy-toggle', null, { role: 'group', 'aria-label': 'Show as' });
  for (const [view, label] of [
    ['chart', 'Chart'],
    ['table', 'Table'],
  ] as const) {
    const b = el('button', 'dy-btn', label, {
      type: 'button',
      'aria-pressed': String(current === view),
    });
    b.addEventListener('click', () => {
      group
        .querySelectorAll('button')
        .forEach((other) => other.setAttribute('aria-pressed', String(other === b)));
      set(view);
    });
    group.appendChild(b);
  }
  return group;
}

export interface TwinColumn {
  readonly text: string;
  readonly numeric: boolean;
}

/** The data-table twin of a chart: real table, caption, scoped headers. */
export function twinTable(
  caption: string,
  columns: readonly TwinColumn[],
  rows: readonly (readonly string[])[],
): HTMLElement {
  const wrap = el('div', 'dy-table-wrap');
  const table = el('table', 'dy-twin');
  table.appendChild(el('caption', undefined, caption));
  const headRow = el('tr');
  columns.forEach((c) =>
    headRow.appendChild(el('th', c.numeric ? 'n' : '', c.text, { scope: 'col' })),
  );
  table.appendChild(el('thead')).appendChild(headRow);
  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((cell, i) =>
      tr.appendChild(
        i === 0
          ? el('th', '', cell, { scope: 'row' })
          : el('td', columns[i]?.numeric ? 'n' : '', cell),
      ),
    );
    body.appendChild(tr);
  }
  append(table, body);
  wrap.appendChild(table);
  return wrap;
}

export interface LegendItem {
  readonly swatch: string;
  readonly label: string;
  readonly value: string;
}

export function legend(items: readonly LegendItem[]): HTMLElement {
  const ul = el('ul', 'dy-legend');
  for (const item of items) {
    const li = el('li');
    append(
      li,
      swatch(item.swatch),
      document.createTextNode(`${item.label} `),
      el('b', undefined, item.value),
    );
    ul.appendChild(li);
  }
  return ul;
}

export interface SplitSegment {
  readonly swatch: string;
  readonly value: number;
}

/** Proportional bar built from flex children (CSSOM only; patterns come from the swatch classes). */
export function splitBar(segments: readonly SplitSegment[], label: string): HTMLElement {
  const bar = el('div', 'dy-bar-split', null, { role: 'img', 'aria-label': label });
  for (const seg of segments) {
    if (seg.value <= 0) continue;
    const part = el('span', `dy-sw-${seg.swatch}`);
    part.style.setProperty('flex-grow', String(seg.value));
    bar.appendChild(part);
  }
  return bar;
}

/** The chart and its table twin; the inactive one is `hidden`. */
export function chartOrTable(view: View, chart: HTMLElement, table: HTMLElement): HTMLElement {
  chart.hidden = view !== 'chart';
  table.hidden = view !== 'table';
  const wrap = el('div', 'dy-viz-body');
  append(wrap, chart, table);
  return wrap;
}

export function setViewTools<T>(
  api: PanelApi<T>,
  view: View,
  set: (v: View) => void,
): readonly Node[] {
  return [
    viewToggle(view, (v) => {
      set(v);
      api.rerender();
    }),
  ];
}

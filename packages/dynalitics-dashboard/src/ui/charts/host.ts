import { append, el, svg, clear } from '../dom.js';
import type { DrawResult } from './line-area.js';

export interface TipLine {
  readonly swatch: string | null;
  readonly text: string;
}

export interface ChartSpec {
  /** Text alternative of the whole chart (docs/DESIGN.md 9.2). */
  readonly label: string;
  readonly height: (width: number) => number;
  readonly draw: (width: number, height: number) => DrawResult;
  readonly tip: (index: number) => { readonly title: string; readonly lines: readonly TipLine[] };
  readonly announce: (index: number) => string;
  readonly onDraw?: (result: DrawResult) => void;
  /** Explorer zoom (docs/DESIGN.md 14.3): click or Enter on a period. */
  readonly onPick?: (index: number) => void;
}

export interface ChartHandle {
  readonly element: HTMLElement;
  /** Drawn width is measured here; call once the element is in the document. */
  readonly redraw: () => void;
}

const FALLBACK_WIDTH = 320;
const HINT_LONG =
  'Use the left and right arrow keys to move between periods. Escape closes the tooltip.';
const HINT_SHORT = '← → explore · Esc close';
let hintCounter = 0;
const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']);

/** Focusable chart with pointer + keyboard exploration, a tooltip and a live-region echo. */
export function createChart(spec: ChartSpec, say: (text: string) => void): ChartHandle {
  const hintId = `dy-kbd-${++hintCounter}`;
  const host = el('div', 'dy-chart', null, {
    tabindex: 0,
    role: 'group',
    'aria-roledescription': 'chart',
    'aria-label': spec.label,
    'aria-describedby': hintId,
  });
  // Wrapper: the chart, a hidden full hint for assistive tech and a visible caption (shown on :focus-visible).
  const wrap = el('div', 'dy-chart-wrap');
  append(
    wrap,
    host,
    el('p', 'vh', HINT_LONG, { id: hintId }),
    el('p', 'dy-kbd-hint', HINT_SHORT, { 'aria-hidden': 'true' }),
  );
  const tip = el('div', 'dy-tip', null, { role: 'presentation', 'aria-hidden': 'true' });
  host.appendChild(tip);
  let current: DrawResult | null = null;
  let cross: SVGLineElement | null = null;
  let index: number | null = null;
  let drawnWidth = 0;

  function hide(): void {
    index = null;
    tip.classList.remove('on');
    cross?.setAttribute('visibility', 'hidden');
  }

  function show(i: number, announce: boolean): void {
    const result = current;
    const cx = result?.centers[i];
    if (!result || cx === undefined) return;
    index = i;
    const { title, lines } = spec.tip(i);
    clear(tip);
    tip.appendChild(el('b', undefined, title));
    for (const line of lines) {
      const row = el('div');
      if (line.swatch) row.appendChild(el('i', `dy-sw dy-sw-${line.swatch}`));
      row.appendChild(document.createTextNode(line.text));
      tip.appendChild(row);
    }
    cross?.setAttribute('x1', String(cx));
    cross?.setAttribute('x2', String(cx));
    cross?.setAttribute('visibility', 'visible');
    const boxWidth = host.clientWidth || FALLBACK_WIDTH;
    const tipWidth = tip.offsetWidth || 0;
    const x = cx + 12 + tipWidth > boxWidth ? Math.max(0, cx - 12 - tipWidth) : cx + 12;
    tip.style.transform = `translate(${Math.round(x)}px, 8px)`;
    tip.classList.add('on');
    if (announce) say(spec.announce(i));
  }

  function redraw(): void {
    const width = Math.floor(host.clientWidth) || FALLBACK_WIDTH;
    drawnWidth = width;
    const result = spec.draw(width, spec.height(width));
    current?.svg.remove();
    current = result;
    cross = svg(
      'line',
      { class: 'cross', y1: result.plot.top, y2: result.plot.bottom, visibility: 'hidden' },
      result.svg,
    );
    host.insertBefore(result.svg, tip);
    spec.onDraw?.(result);
    if (index !== null) show(Math.min(index, result.centers.length - 1), false);
  }

  function nearest(clientX: number): number {
    const box = host.getBoundingClientRect();
    const scale = box.width > 0 ? drawnWidth / box.width : 1;
    const x = (clientX - box.left) * scale;
    const centers = current?.centers ?? [];
    let best = 0;
    centers.forEach((c, i) => {
      if (Math.abs(c - x) < Math.abs((centers[best] ?? 0) - x)) best = i;
    });
    return best;
  }

  host.addEventListener('pointermove', (e) => show(nearest(e.clientX), false));
  host.addEventListener('pointerdown', (e) => show(nearest(e.clientX), false));
  host.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  host.addEventListener('blur', () => hide());
  if (spec.onPick) {
    const pick = spec.onPick;
    host.addEventListener('click', (e) => pick(nearest(e.clientX)));
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && index !== null) pick(index);
    });
  }
  host.addEventListener('keydown', (e) => {
    const count = current?.centers.length ?? 0;
    if (!KEYS.has(e.key) || count === 0) return;
    e.preventDefault();
    if (e.key === 'Escape') return hide();
    const last = count - 1;
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (index === null) next = e.key === 'ArrowLeft' ? last : 0;
    else next = Math.min(last, Math.max(0, index + (e.key === 'ArrowLeft' ? -1 : 1)));
    show(next, true);
  });

  if (typeof ResizeObserver !== 'undefined') {
    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.isConnected && Math.floor(host.clientWidth) !== drawnWidth) redraw();
      });
    }).observe(host);
  }
  return { element: wrap, redraw };
}

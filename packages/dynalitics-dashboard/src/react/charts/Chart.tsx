import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { HINT_LONG, HINT_SHORT } from '../copy.js';
import type { ChartDrawing } from './geometry.js';

export interface TipLine {
  readonly swatch: string | null;
  readonly text: string;
}

export interface ChartProps {
  /** Text alternative of the whole chart (docs/DESIGN.md 9.2). */
  readonly label: string;
  readonly height: (width: number) => number;
  /** Must be memoised by the caller: a new function means a new drawing. */
  readonly draw: (width: number, height: number) => ChartDrawing;
  readonly tip: (index: number) => { readonly title: string; readonly lines: readonly TipLine[] };
  readonly announce: (index: number) => string;
  readonly say: (text: string) => void;
  readonly hidden: boolean;
  readonly onDraw?: (drawing: ChartDrawing) => void;
  /** The outer `.dy-chart-wrap`, for callers that need its offset (hero numeral). */
  readonly wrapRef?: RefObject<HTMLDivElement | null>;
}

const FALLBACK_WIDTH = 320;
const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']);

// useLayoutEffect warns on the server in React 18; the effect only matters in the browser.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Focusable chart with pointer + keyboard exploration, a tooltip and a live-region echo. */
export function Chart(props: ChartProps): ReactElement {
  const { label, height, draw, tip, announce, say, hidden, onDraw, wrapRef } = props;
  const hintId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [index, setIndex] = useState<number | null>(null);

  const drawing = useMemo(() => draw(width, height(width)), [draw, height, width]);
  const onDrawRef = useRef(onDraw);
  onDrawRef.current = onDraw;
  useIsoLayoutEffect(() => {
    onDrawRef.current?.(drawing);
  }, [drawing]);

  useIsoLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = (): void => setWidth(Math.floor(el.clientWidth) || FALLBACK_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (el.isConnected) measure();
      });
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const count = drawing.centers.length;
  const current = index === null || count === 0 ? null : Math.min(index, count - 1);
  const centerX = current === null ? undefined : drawing.centers[current];
  const tipContent = current === null ? null : tip(current);

  useIsoLayoutEffect(() => {
    const node = tipRef.current;
    const host = hostRef.current;
    if (!node || !host || centerX === undefined) return;
    const boxWidth = host.clientWidth || FALLBACK_WIDTH;
    const tipWidth = node.offsetWidth || 0;
    const x =
      centerX + 12 + tipWidth > boxWidth ? Math.max(0, centerX - 12 - tipWidth) : centerX + 12;
    node.style.transform = `translate(${Math.round(x)}px, 8px)`;
  }, [centerX, tipContent]);

  const nearest = useCallback(
    (clientX: number): number => {
      const host = hostRef.current;
      if (!host) return 0;
      const box = host.getBoundingClientRect();
      const scale = box.width > 0 ? width / box.width : 1;
      const x = (clientX - box.left) * scale;
      let best = 0;
      drawing.centers.forEach((c, i) => {
        if (Math.abs(c - x) < Math.abs((drawing.centers[best] ?? 0) - x)) best = i;
      });
      return best;
    },
    [drawing, width],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!KEYS.has(e.key) || count === 0) return;
    e.preventDefault();
    if (e.key === 'Escape') return setIndex(null);
    const last = count - 1;
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (current === null) next = e.key === 'ArrowLeft' ? last : 0;
    else next = Math.min(last, Math.max(0, current + (e.key === 'ArrowLeft' ? -1 : 1)));
    setIndex(next);
    say(announce(next));
  };
  const onPointer = (e: PointerEvent<HTMLDivElement>): void => setIndex(nearest(e.clientX));

  return (
    <div className="dy-chart-wrap" hidden={hidden} ref={wrapRef ?? null}>
      <div
        className="dy-chart"
        ref={hostRef}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={label}
        aria-describedby={hintId}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setIndex(null);
        }}
        onBlur={() => setIndex(null)}
        onKeyDown={onKeyDown}
      >
        <svg viewBox={`0 0 ${width} ${height(width)}`} role="img" aria-hidden="true">
          {drawing.content}
          <line
            className="cross"
            y1={drawing.plot.top}
            y2={drawing.plot.bottom}
            visibility={current === null ? 'hidden' : 'visible'}
            {...(centerX === undefined ? {} : { x1: centerX, x2: centerX })}
          />
        </svg>
        <div
          className={current === null ? 'dy-tip' : 'dy-tip on'}
          role="presentation"
          aria-hidden="true"
          ref={tipRef}
        >
          {tipContent ? (
            <>
              <b>{tipContent.title}</b>
              {tipContent.lines.map((line, i) => (
                <div key={i}>
                  {line.swatch ? <i className={`dy-sw dy-sw-${line.swatch}`} /> : null}
                  {line.text}
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>
      <p className="vh" id={hintId}>
        {HINT_LONG}
      </p>
      <p className="dy-kbd-hint" aria-hidden="true">
        {HINT_SHORT}
      </p>
    </div>
  );
}

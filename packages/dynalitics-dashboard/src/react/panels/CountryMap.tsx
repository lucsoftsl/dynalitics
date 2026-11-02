import { useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import type { Ctx } from '../../ui/context.js';
import { clamp01 } from '../../ui/format.js';
import {
  DRAG_THRESHOLD,
  MAX_ZOOM,
  MIN_ZOOM,
  WHEEL_ZOOM_SPEED,
  ZOOM_STEP,
  countryLabel,
  flagOf,
  fullView,
  hiddenCount,
  listedRows,
  panView,
  pointAt,
  safeShapes,
  shadeStep,
  viewBox,
  zoomView,
  type MapView,
} from '../../ui/geo.js';
import {
  COUNTRIES_COPY,
  COUNTRIES_EMPTY,
  countriesAvailability,
  countriesHint,
  countriesSummary,
  requestCountries,
  type CountriesView,
} from '../../ui/panels/countries.js';
import { cssVars, cx } from '../css-vars.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonChart } from '../states.js';
import { usePanel } from '../use-panel.js';

// "Where visitors come from" (docs/DESIGN.md section 16). The React form has no explorer, so the map is read-only:
// shading, names, zoom and pan, the same markup and classes as the HTML page.

function WorldMap(props: { data: CountriesView; ctx: Ctx }): ReactElement {
  const { map, countries } = props.data;
  const f = props.ctx.fmt;
  const [view, setView] = useState<MapView>(() => fullView(map));
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: MapView; moved: boolean } | null>(null);
  const byCode = new Map(countries.countries.map((c) => [c.code, c.visits]));
  const max = Math.max(1, ...countries.countries.map((c) => c.visits));
  const zoomed = view.zoom > MIN_ZOOM;

  // Pinch / Ctrl+wheel zooms towards the pointer. Attached by hand: React's wheel listener is passive.
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return undefined;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = node.getBoundingClientRect();
      setView((v) =>
        zoomView(
          map,
          v,
          Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED),
          pointAt(map, v, (e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height),
        ),
      );
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [map]);

  const onPointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    drag.current = zoomed ? { x: e.clientX, y: e.clientY, view, moved: false } : null;
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      drag.current = { ...d, moved: true };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setView(panView(map, d.view, dx, dy, e.currentTarget.getBoundingClientRect().width));
  };
  const endDrag = (): void => {
    drag.current = null;
  };

  return (
    <div className={cx('dy-geo-frame', zoomed && 'is-zoomed')}>
      <svg
        ref={svgRef}
        className="dy-geo-map"
        viewBox={viewBox(map, view)}
        role="group"
        aria-label={COUNTRIES_COPY.mapLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setView((v) => zoomView(map, v, ZOOM_STEP))}
      >
        {safeShapes(map).map((shape) => {
          const visits = byCode.get(shape.code) ?? 0;
          const step = shadeStep(visits, max);
          return (
            <path
              key={shape.code}
              d={shape.d}
              className={`dy-geo-c dy-geo-s${step}`}
              data-code={step === 0 ? undefined : shape.code}
            >
              {step === 0 ? null : (
                <title>{countryLabel(f.country(shape.code), f.num(visits), visits === 1)}</title>
              )}
            </path>
          );
        })}
      </svg>
      <div className="dy-geo-zoom">
        <button
          type="button"
          className="dy-geo-zbtn"
          aria-label={COUNTRIES_COPY.zoomIn}
          title={COUNTRIES_COPY.zoomIn}
          disabled={view.zoom >= MAX_ZOOM}
          onClick={() => setView((v) => zoomView(map, v, ZOOM_STEP))}
        >
          +
        </button>
        <button
          type="button"
          className="dy-geo-zbtn"
          aria-label={COUNTRIES_COPY.zoomOut}
          title={COUNTRIES_COPY.zoomOut}
          disabled={!zoomed}
          onClick={() => setView((v) => zoomView(map, v, 1 / ZOOM_STEP))}
        >
          −
        </button>
        <button
          type="button"
          className="dy-geo-zbtn"
          aria-label={COUNTRIES_COPY.zoomReset}
          title={COUNTRIES_COPY.zoomReset}
          hidden={!zoomed}
          onClick={() => setView(fullView(map))}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}

function Ready(props: { data: CountriesView; ctx: Ctx }): ReactElement {
  const { data, ctx } = props;
  const listed = listedRows(data.countries);
  const max = Math.max(1, ...listed.map((r) => r.visits));
  const hidden = hiddenCount(data.countries, listed);
  return (
    <div className="dy-geo">
      <p className="dy-kpi-sub dy-geo-hint">{countriesHint(false)}</p>
      <div className="dy-geo-body">
        <WorldMap data={data} ctx={ctx} />
        <ol className="dy-geo-list" aria-label={COUNTRIES_COPY.listLabel}>
          {listed.map((r) => (
            <li
              key={r.code ?? '?'}
              className={cx('dy-geo-row', r.code === null && 'dy-geo-row--unknown')}
            >
              <span className="dy-geo-item">
                <span
                  className="dy-bar"
                  aria-hidden="true"
                  style={cssVars({ '--r': String(clamp01(r.visits / max)) })}
                />
                <span className="dy-geo-flag" aria-hidden="true">
                  {r.code === null ? '?' : flagOf(r.code)}
                </span>
                <span className="dy-geo-name">
                  {r.code === null ? COUNTRIES_COPY.unknown : ctx.fmt.country(r.code)}
                </span>
                <span className="dy-count">{ctx.fmt.num(r.visits)}</span>
              </span>
            </li>
          ))}
          {hidden > 0 ? <li className="dy-geo-more">{COUNTRIES_COPY.more(hidden)}</li> : null}
        </ol>
      </div>
    </div>
  );
}

export function CountryMap(props: { no: number }): ReactElement {
  const panel = usePanel<CountriesView>({
    title: COUNTRIES_COPY.title,
    requestKey: '',
    availability: countriesAvailability,
    request: requestCountries,
    isEmpty: (d) => d.countries.total === 0,
    summary: countriesSummary,
  });
  return (
    <PanelShell
      no={props.no}
      title={COUNTRIES_COPY.title}
      className="p-geo"
      panel={panel}
      skeleton={<SkeletonChart height={240} />}
      empty={() => <EmptyBlock title={COUNTRIES_EMPTY.title} body={COUNTRIES_EMPTY.body} />}
      ready={(data, c) => <Ready data={data} ctx={c} />}
    />
  );
}

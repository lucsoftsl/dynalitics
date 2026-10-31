import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import type { VisitsOverTimeData } from '../../protocol.js';
import { intervalUnit, plainLabel, timeLabels } from '../../ui/charts/labels.js';
import { numeralCollides } from '../../ui/charts/scales.js';
import type { Ctx } from '../../ui/context.js';
import { bucketEnd, parseInstant, tooltipTitle } from '../../ui/format.js';
import { buildSplit, type SplitSeries } from '../../ui/panels/hero-split.js';
import { windowFor } from '../../ui/ranges.js';
import { requestWindow, unavailableOf } from '../../ui/request.js';
import { Chart } from '../charts/Chart.js';
import { drawLineArea, drawStackedAreas, type ChartDrawing } from '../charts/geometry.js';
import { useInternal } from '../internal-context.js';
import { cssVars, cx } from '../css-vars.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonChart, SkeletonHeadline } from '../states.js';
import { usePanel } from '../use-panel.js';
import { Legend, TwinTable, ViewToggle, VizBody, type TwinColumn, type View } from '../widgets.js';

/** Chart height from the drawn width (docs/DESIGN.md 5.2: 220 / 260 / 300 / 340). */
const heroHeight = (width: number): number => {
  if (width >= 800) return 340;
  if (width >= 640) return 300;
  return width >= 400 ? 260 : 220;
};

function extremes(points: VisitsOverTimeData['points']): {
  max: number;
  min: number;
  maxAt: number;
  minAt: number;
} {
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  let maxAt = 0;
  let minAt = 0;
  points.forEach((p, i) => {
    if (p.visits > max) {
      max = p.visits;
      maxAt = i;
    }
    if (p.visits < min) {
      min = p.visits;
      minAt = i;
    }
  });
  return { max, min: Number.isFinite(min) ? min : 0, maxAt, minAt };
}

function describe(
  data: VisitsOverTimeData,
  ctx: Ctx,
  split: readonly SplitSeries[],
  splitLabel: string,
): string {
  const { points, interval, total } = data;
  const t = (i: number): string =>
    plainLabel(ctx.fmt, parseInstant(points[i]?.bucket ?? ''), interval);
  const x = extremes(points);
  const first = points.length ? t(0) : '';
  const last = points.length ? t(points.length - 1) : '';
  const by = split.length
    ? ` Split by ${splitLabel}: ${[...split]
        .reverse()
        .map((s) => `${s.name} ${ctx.fmt.num(s.total)}`)
        .join(', ')}.`
    : '';
  return `Visits per ${intervalUnit(interval)}, ${first} to ${last} UTC. Total ${ctx.fmt.num(total)}. Highest: ${t(x.maxAt)} with ${ctx.fmt.num(x.max)}. Lowest: ${t(x.minAt)} with ${ctx.fmt.num(x.min)}.${by}`;
}

function Ready(props: {
  data: VisitsOverTimeData;
  ctx: Ctx;
  view: View;
  say: (text: string) => void;
}): ReactElement {
  const { data, ctx, view, say } = props;
  const f = ctx.fmt;
  const win = windowFor(ctx.range, ctx.meta.now);
  const times = useMemo(() => data.points.map((p) => parseInstant(p.bucket)), [data]);
  const values = useMemo(() => data.points.map((p) => p.visits), [data]);
  const n = times.length;
  const lastT = times[n - 1] ?? 0;
  const inProgress = win ? bucketEnd(lastT, data.interval) > win.toMs : false;
  const breakdown = data.breakdown;
  const split = useMemo(
    () => (breakdown ? buildSplit(breakdown.key, breakdown.series) : []),
    [breakdown],
  );
  const splitLabel =
    ctx.meta.breakdowns.find((b) => b.key === breakdown?.key)?.label ?? breakdown?.key ?? '';
  const x = extremes(data.points);
  const topToBottom = [...split].reverse();

  const draw = useCallback(
    (w: number, h: number): ChartDrawing => {
      const xLabels = timeLabels(f, times, data.interval);
      return split.length
        ? drawStackedAreas(w, h, {
            series: split.map((s) => ({
              fill: s.fill,
              labelClass: s.labelClass,
              label: s.name,
              values: s.values,
            })),
            xLabels,
            compact: f.compact,
            labelIndex: inProgress ? n - 2 : n - 1,
          })
        : drawLineArea(w, h, { values, xLabels, inProgressLast: inProgress, compact: f.compact });
    },
    [f, times, data.interval, split, values, inProgress, n],
  );

  // docs/DESIGN.md 7.6: measured on every draw; the state is recomputed from scratch each time.
  const numRef = useRef<HTMLParagraphElement>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const [numeral, setNumeral] = useState<{ stacked: boolean; ny: number | null }>({
    stacked: false,
    ny: null,
  });
  const onDraw = useCallback((drawing: ChartDrawing): void => {
    const num = numRef.current;
    const wrap = chartWrapRef.current;
    if (!num || !wrap) return;
    const size = { w: num.offsetWidth, h: num.offsetHeight };
    const plotWidth = drawing.plot.right - drawing.plot.left;
    setNumeral({ stacked: numeralCollides(drawing.line, size, plotWidth), ny: wrap.offsetTop + 6 });
  }, []);

  const columns: TwinColumn[] = [
    { text: 'Period (UTC)', numeric: false },
    { text: 'Visits', numeric: true },
    ...topToBottom.map((s) => ({ text: s.name, numeric: true })),
  ];
  const plain = (i: number): string => plainLabel(f, times[i] ?? 0, data.interval);
  return (
    <div className={cx('dy-hero-wrap', numeral.stacked && 'dy-hero--stacked')}>
      <p
        className="dy-hero-num"
        ref={numRef}
        style={numeral.ny === null ? undefined : cssVars({ '--ny': `${numeral.ny}px` })}
      >
        <span className="vh">Total visits: </span>
        {f.num(data.total)}
      </p>
      <p className="dy-kpi-sub">
        {`${plainLabel(f, times[x.maxAt] ?? 0, data.interval)} was the busiest ${intervalUnit(data.interval)}: ${f.num(x.max)} visits.`}
      </p>
      <figure className="dy-figure">
        <VizBody>
          <Chart
            label={describe(data, ctx, split, splitLabel)}
            height={heroHeight}
            draw={draw}
            say={say}
            hidden={view !== 'chart'}
            onDraw={onDraw}
            wrapRef={chartWrapRef}
            tip={(i) => ({
              title: tooltipTitle(f, times[i] ?? 0, data.interval, {
                last: inProgress && i === n - 1,
                first: i === 0,
                fromMs: win?.fromMs ?? 0,
              }),
              lines: split.length
                ? topToBottom.map((s) => ({
                    swatch: s.swatch,
                    text: `${s.name} ${f.num(s.values[i] ?? 0)}`,
                  }))
                : [{ swatch: null, text: `${f.num(values[i] ?? 0)} visits` }],
            })}
            announce={(i) =>
              split.length
                ? `${plain(i)}: ${topToBottom.map((s) => `${s.name} ${s.values[i] ?? 0}`).join(', ')}`
                : `${plain(i)}: ${f.num(values[i] ?? 0)} visits`
            }
          />
          <TwinTable
            hidden={view !== 'table'}
            caption={`Visits per ${intervalUnit(data.interval)}, ${ctx.range.short}${split.length ? `, split by ${splitLabel}` : ''}`}
            columns={columns}
            rows={data.points.map((p, i) => [
              plain(i),
              f.num(p.visits),
              ...topToBottom.map((s) => f.num(s.values[i] ?? 0)),
            ])}
          />
        </VizBody>
        {split.length ? (
          <Legend
            items={topToBottom.map((s) => ({
              swatch: s.swatch,
              label: s.name,
              value: f.num(s.total),
              note: s.note,
            }))}
          />
        ) : null}
      </figure>
    </div>
  );
}

function Empty(props: {
  ctx: Ctx;
  refresh: () => void;
  setRange: (k: '90d') => void;
}): ReactElement {
  const win = windowFor(props.ctx.range, props.ctx.meta.now);
  if (props.ctx.range.key === '90d') {
    return (
      <EmptyBlock
        title="Nothing recorded yet."
        bodyNode={
          <p>
            dynalitics has not stored a visit in the last 90 days. Call <code>track()</code>
            {" from a route handler, check that your app's "}
            <code>onError</code>
            {' is not reporting insert errors, then refresh.'}
          </p>
        }
        actions={
          <button type="button" className="dy-btn" onClick={props.refresh}>
            Refresh
          </button>
        }
      />
    );
  }
  return (
    <EmptyBlock
      title="The ledger is empty for this range."
      body={
        win
          ? `No visits between ${win.from.slice(0, 10)} and ${win.to.slice(0, 10)} (UTC).`
          : 'No visits in this range.'
      }
      actions={
        <button type="button" className="dy-btn" onClick={() => props.setRange('90d')}>
          Try 90 days
        </button>
      }
    />
  );
}

export function VisitsOverTime(): ReactElement {
  const dyn = useInternal();
  const [view, setView] = useState<View>('chart');
  /** Selected breakdown key, or null for "None". Survives range changes. */
  const [split, setSplit] = useState<string | null>(null);
  const ctx = dyn.ctx;
  const activeSplit =
    ctx && split !== null && ctx.meta.breakdowns.some((b) => b.key === split) ? split : null;
  const { touchUpdated } = dyn;
  const panel = usePanel<VisitsOverTimeData>({
    title: 'Visits over time',
    requestKey: activeSplit ?? '',
    availability: (c) => unavailableOf(c.meta.widgets.visitsOverTime),
    request: async (c, signal) => {
      const result = await requestWindow<VisitsOverTimeData>(
        c,
        'visits-over-time',
        signal,
        (w) => ({
          from: w.from,
          to: w.to,
          interval: w.interval,
          ...(activeSplit ? { breakdown: activeSplit } : {}),
        }),
      );
      if (result.kind === 'data') touchUpdated(result.meta.generatedAt);
      return result;
    },
    isEmpty: (d) => d.total === 0,
    summary: (d, c) => `Visits over time loaded: ${c.fmt.num(d.total)} visits`,
  });
  return (
    <PanelShell
      no={1}
      title="Visits over time"
      className="p-hero"
      sheet
      eyebrow={ctx ? `No. 1 · ${ctx.range.label}` : undefined}
      panel={panel}
      tools={
        <>
          {ctx && ctx.meta.breakdowns.length > 0 ? (
            <label className="dy-split-lbl-sel">
              <span className="dy-eyebrow">Split by</span>
              <select
                className="dy-select"
                value={activeSplit ?? ''}
                onChange={(e) => setSplit(e.target.value === '' ? null : e.target.value)}
              >
                <option value="">None</option>
                {ctx.meta.breakdowns.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <ViewToggle current={view} set={setView} />
        </>
      }
      skeleton={
        <div>
          <SkeletonHeadline />
          <SkeletonChart height={220} />
        </div>
      }
      empty={(c) => <Empty ctx={c} refresh={dyn.refresh} setRange={dyn.setRange} />}
      ready={(data, c) => <Ready data={data} ctx={c} view={view} say={panel.say} />}
    />
  );
}

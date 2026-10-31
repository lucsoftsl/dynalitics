import { useMemo, useState, type ReactElement } from 'react';
import type { NewVsReturningData } from '../../protocol.js';
import { intervalUnit } from '../../ui/charts/labels.js';
import type { Ctx } from '../../ui/context.js';
import { parseInstant, pct } from '../../ui/format.js';
import { windowFor, windowLabel } from '../../ui/ranges.js';
import { requestWindow, unavailableOf } from '../../ui/request.js';
import { useInternal } from '../internal-context.js';
import { capNote, CAVEAT, EMPTY, UNKNOWN_DEF } from '../copy.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonChart, SkeletonHeadline } from '../states.js';
import { usePanel } from '../use-panel.js';
import { SplitBar, ViewToggle, type View } from '../widgets.js';
import { BucketChart, type BucketChartInput } from './BucketChart.js';

const cap = (ctx: Ctx): number => ctx.meta.limits.newVsReturningMaxRangeDays;

function Ready(props: {
  data: NewVsReturningData;
  ctx: Ctx;
  view: View;
  say: (text: string) => void;
}): ReactElement {
  const { data, ctx, view, say } = props;
  const f = ctx.fmt;
  const { totals } = data;
  const identified = totals.new + totals.returning;
  const all = identified + totals.unknown;
  const label = windowLabel(ctx.range, cap(ctx));
  const input = useMemo<BucketChartInput>(
    () => ({
      interval: data.interval,
      times: data.points.map((p) => parseInstant(p.bucket)),
      series: [
        { swatch: 'returning', label: 'Returning', values: data.points.map((p) => p.returning) },
        { swatch: 'new', label: 'New', values: data.points.map((p) => p.new) },
        { swatch: 'unknown', label: 'Unknown', values: data.points.map((p) => p.unknown) },
      ],
      order: [1, 0, 2],
      percent: false,
      win: windowFor(ctx.range, ctx.meta.now, cap(ctx)),
      ariaLabel: `Visits by new, returning and unknown visitors per ${intervalUnit(data.interval)}. ${f.num(totals.new)} new, ${f.num(totals.returning)} returning, ${f.num(totals.unknown)} unknown in total. Window: ${label.lower}.`,
      caption: `New vs returning visits per ${intervalUnit(data.interval)}, ${label.lower} (UTC)`,
    }),
    [data, ctx, f, totals, label.lower],
  );
  const unknownPart =
    totals.unknown > 0
      ? ` ${f.num(totals.unknown)} (${pct(totals.unknown / all)}) could not be classified: declined consent or no usable identity.`
      : '';
  const notes = [
    label.capped ? capNote(cap(ctx)) : null,
    data.approximate ? CAVEAT : null,
    UNKNOWN_DEF,
  ];
  return (
    <div>
      <p className="dy-kpi-num">
        {identified > 0 ? pct(totals.new / identified) : '—'}
        <small className="c-new">new</small>
        {data.approximate ? <span className="dy-estimate">Estimate</span> : null}
      </p>
      <p className="dy-kpi-sub">
        {identified > 0
          ? `Based on ${f.num(identified)} visits with a known visitor.${unknownPart}`
          : 'No visitors could be classified yet.'}
      </p>
      {notes.map((note, i) =>
        note ? (
          <p key={i} className="dy-note">
            {note}
          </p>
        ) : null,
      )}
      <SplitBar
        segments={[
          { swatch: 'new', value: totals.new },
          { swatch: 'returning', value: totals.returning },
          { swatch: 'unknown', value: totals.unknown },
        ]}
        label={`${f.num(totals.new)} new, ${f.num(totals.returning)} returning, ${f.num(totals.unknown)} unknown`}
      />
      <BucketChart ctx={ctx} input={input} view={view} say={say} />
    </div>
  );
}

/** New vs returning: clamped to the server's cap and labelled with the window it really shows (DESIGN 6.4). */
export function NewVsReturning(): ReactElement {
  const dyn = useInternal();
  const [view, setView] = useState<View>('chart');
  const panel = usePanel<NewVsReturningData>({
    title: 'New vs returning',
    requestKey: '',
    availability: (ctx) => unavailableOf(ctx.meta.widgets.newVsReturning),
    request: (ctx, signal) =>
      requestWindow<NewVsReturningData>(
        ctx,
        'new-vs-returning',
        signal,
        (w) => ({ from: w.from, to: w.to, interval: w.interval }),
        cap(ctx),
      ),
    isEmpty: (d) => d.totals.new + d.totals.returning + d.totals.unknown === 0,
    summary: (d, ctx) =>
      `New vs returning loaded (${windowLabel(ctx.range, cap(ctx)).lower}): ${ctx.fmt.num(d.totals.new)} new, ${ctx.fmt.num(d.totals.returning)} returning, ${ctx.fmt.num(d.totals.unknown)} unknown`,
  });
  const ctx = dyn.ctx;
  return (
    <PanelShell
      no={3}
      title="New vs returning"
      className="p-nvr"
      eyebrow={ctx ? `No. 3 · ${windowLabel(ctx.range, cap(ctx)).upper}` : undefined}
      reloadOnBadRequest
      panel={panel}
      tools={<ViewToggle current={view} set={setView} />}
      skeleton={
        <div>
          <SkeletonHeadline />
          <SkeletonChart height={200} />
        </div>
      }
      empty={(c) => (
        <EmptyBlock
          title={EMPTY.nvr.title}
          body={EMPTY.nvr.body}
          extra={
            // An empty 31-day window must not be mistaken for an empty 90-day one.
            windowLabel(c.range, cap(c)).capped ? (
              <p className="dy-note">{capNote(cap(c))}</p>
            ) : null
          }
        />
      )}
      ready={(data, c) => <Ready data={data} ctx={c} view={view} say={panel.say} />}
    />
  );
}

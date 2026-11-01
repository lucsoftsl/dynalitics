import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { ErrorReasonCount, ErrorsData } from '../../protocol.js';
import { intervalUnit } from '../../ui/charts/labels.js';
import type { Ctx } from '../../ui/context.js';
import { clamp01, parseInstant, pct } from '../../ui/format.js';
import { errorsAvailability } from '../../ui/panels/errors.js';
import { windowFor } from '../../ui/ranges.js';
import { requestWindow } from '../../ui/request.js';
import { EMPTY, ERRORS_COPY } from '../copy.js';
import { cssVars } from '../css-vars.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonChart, SkeletonHeadline } from '../states.js';
import { usePanel } from '../use-panel.js';
import { SplitBar, ViewToggle, type View } from '../widgets.js';
import { BucketChart, type BucketChartInput } from './BucketChart.js';
import { StatusBadge } from './StatusBadge.js';

type Counts = { total: number; clientErrors: number; serverErrors: number };
const okOf = (p: Counts): number => Math.max(0, p.total - p.clientErrors - p.serverErrors);

function RankRow(props: {
  label: ReactNode;
  count: string;
  ratio: number;
  severity: 'client' | 'server';
}): ReactElement {
  return (
    <li className={`dy-page-row dy-err-row dy-err-row--${props.severity}`}>
      {props.label}
      <span className="dy-nums">
        <span className="dy-count">{props.count}</span>
      </span>
      <span
        className="dy-bar"
        aria-hidden="true"
        style={cssVars({ '--r': String(clamp01(props.ratio)) })}
      />
    </li>
  );
}

function ReasonLabel(props: { r: ErrorReasonCount }): ReactElement {
  return (
    <span className="dy-err-label">
      <StatusBadge status={props.r.status} />
      {props.r.reason === null ? (
        <span className="dy-err-none">no reason given</span>
      ) : (
        <span className="v dy-err-reason">{props.r.reason}</span>
      )}
    </span>
  );
}

function Lists(props: { data: ErrorsData; ctx: Ctx }): ReactElement {
  const { data } = props;
  const f = props.ctx.fmt;
  const topPage = Math.max(1, ...data.pages.map((p) => p.errors));
  const topReason = Math.max(1, ...data.reasons.map((r) => r.count));
  return (
    <div className="dy-err-lists">
      <section className="dy-err-list">
        <h3 className="dy-eyebrow">Failing pages</h3>
        <ol className="dy-pages dy-err-pages" aria-label="Pages with the most errors">
          {data.pages.map((p, i) => (
            <RankRow
              key={`${i}-${p.page}`}
              label={
                <span className="dy-err-label">
                  <span className="v dy-page" dir="auto">
                    {p.page}
                  </span>
                </span>
              }
              count={
                p.serverErrors > 0
                  ? `${f.num(p.errors)} · ${f.num(p.serverErrors)} 5xx`
                  : f.num(p.errors)
              }
              ratio={p.errors / topPage}
              severity={p.serverErrors > 0 ? 'server' : 'client'}
            />
          ))}
        </ol>
      </section>
      <section className="dy-err-list">
        <h3 className="dy-eyebrow">Errors by reason</h3>
        <ol className="dy-pages dy-err-reasons" aria-label="Commonest errors">
          {data.reasons.map((r, i) => (
            <RankRow
              key={`${i}-${String(r.reason)}-${r.status}`}
              label={<ReasonLabel r={r} />}
              count={f.num(r.count)}
              ratio={r.count / topReason}
              severity={r.status >= 500 ? 'server' : 'client'}
            />
          ))}
        </ol>
        {data.reasonsStored ? null : <p className="dy-kpi-sub">{ERRORS_COPY.noReasons}</p>}
      </section>
    </div>
  );
}

function Ready(props: {
  data: ErrorsData;
  ctx: Ctx;
  view: View;
  say: (text: string) => void;
}): ReactElement {
  const { data, ctx, view, say } = props;
  const f = ctx.fmt;
  const { totals } = data;
  const errors = totals.clientErrors + totals.serverErrors;
  const input = useMemo<BucketChartInput>(
    () => ({
      interval: data.interval,
      times: data.points.map((p) => parseInstant(p.bucket)),
      series: [
        { swatch: 'ok', label: 'Succeeded', values: data.points.map(okOf) },
        { swatch: 'client', label: '4xx', values: data.points.map((p) => p.clientErrors) },
        { swatch: 'server', label: '5xx', values: data.points.map((p) => p.serverErrors) },
      ],
      order: [2, 1, 0],
      percent: false,
      win: windowFor(ctx.range, ctx.meta.now),
      ariaLabel: `Responses per ${intervalUnit(data.interval)}. ${f.num(totals.serverErrors)} server errors, ${f.num(totals.clientErrors)} client errors of ${f.num(totals.total)}.`,
      caption: `Responses per ${intervalUnit(data.interval)}`,
      extra: {
        text: 'Failed',
        cell: (i) => {
          const rate = data.points[i]?.rate;
          return rate == null ? '—' : pct(rate);
        },
      },
    }),
    [data, ctx, f, totals],
  );
  return (
    <div className="dy-err">
      <div className="dy-err-head">
        <p className="dy-kpi-num">
          {totals.rate === null ? '—' : pct(totals.rate)}
          <small className={errors > 0 ? 'c-server' : undefined}>failed</small>
        </p>
        <p className="dy-kpi-sub">
          {ERRORS_COPY.sub(
            f.num(errors),
            f.num(totals.total),
            f.num(totals.serverErrors),
            f.num(totals.clientErrors),
          )}
        </p>
        <SplitBar
          segments={[
            { swatch: 'ok', value: okOf(totals) },
            { swatch: 'client', value: totals.clientErrors },
            { swatch: 'server', value: totals.serverErrors },
          ]}
          label={`${f.num(okOf(totals))} succeeded, ${f.num(totals.clientErrors)} client errors, ${f.num(totals.serverErrors)} server errors`}
        />
        <BucketChart ctx={ctx} input={input} view={view} say={say} />
      </div>
      <Lists data={data} ctx={ctx} />
    </div>
  );
}

/** HTTP errors: rate over time, failing pages, reasons (docs/DESIGN.md 15). Renders only when the server offers it. */
export function Errors(props: { no?: number } = {}): ReactElement {
  const [view, setView] = useState<View>('chart');
  const panel = usePanel<ErrorsData>({
    title: 'Errors',
    requestKey: '',
    availability: errorsAvailability,
    request: (ctx, signal) =>
      requestWindow<ErrorsData>(ctx, 'errors', signal, (w) => ({
        from: w.from,
        to: w.to,
        interval: w.interval,
      })),
    isEmpty: (d) => d.totals.total === 0,
    summary: (d, ctx) =>
      `Errors loaded: ${ctx.fmt.num(d.totals.serverErrors)} server errors, ${ctx.fmt.num(d.totals.clientErrors)} client errors`,
  });
  return (
    <PanelShell
      no={props.no ?? 5}
      title="Errors"
      className="p-errors"
      panel={panel}
      tools={<ViewToggle current={view} set={setView} />}
      skeleton={
        <div>
          <SkeletonHeadline />
          <SkeletonChart height={200} />
        </div>
      }
      empty={() => <EmptyBlock title={EMPTY.errors.title} body={EMPTY.errors.body} />}
      ready={(data, ctx) => <Ready data={data} ctx={ctx} view={view} say={panel.say} />}
    />
  );
}

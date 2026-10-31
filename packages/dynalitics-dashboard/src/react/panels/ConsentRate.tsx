import { useMemo, useState, type ReactElement } from 'react';
import type { ConsentRateData } from '../../protocol.js';
import { intervalUnit } from '../../ui/charts/labels.js';
import type { Ctx } from '../../ui/context.js';
import { parseInstant, pct } from '../../ui/format.js';
import { windowFor } from '../../ui/ranges.js';
import { requestWindow, unavailableOf } from '../../ui/request.js';
import { CONSENT_SUB, EMPTY } from '../copy.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonChart, SkeletonHeadline } from '../states.js';
import { usePanel } from '../use-panel.js';
import { SplitBar, ViewToggle, type View } from '../widgets.js';
import { BucketChart, type BucketChartInput } from './BucketChart.js';

function Ready(props: {
  data: ConsentRateData;
  ctx: Ctx;
  view: View;
  say: (text: string) => void;
}): ReactElement {
  const { data, ctx, view, say } = props;
  const f = ctx.fmt;
  const { totals } = data;
  const input = useMemo<BucketChartInput>(
    () => ({
      interval: data.interval,
      times: data.points.map((p) => parseInstant(p.bucket)),
      series: [
        { swatch: 'granted', label: 'Granted', values: data.points.map((p) => p.granted) },
        { swatch: 'declined', label: 'Declined', values: data.points.map((p) => p.denied) },
      ],
      order: [0, 1],
      percent: true,
      win: windowFor(ctx.range, ctx.meta.now),
      ariaLabel: `Consent per ${intervalUnit(data.interval)}. ${f.num(totals.granted)} granted, ${f.num(totals.denied)} declined${totals.rate === null ? '' : `, ${pct(totals.rate)} granted overall`}.`,
      caption: `Consent per ${intervalUnit(data.interval)}`,
      extra: {
        text: 'Share of visits',
        cell: (i) => {
          const rate = data.points[i]?.rate;
          return rate == null ? '—' : pct(rate);
        },
      },
    }),
    [data, ctx, f, totals],
  );
  return (
    <div>
      <p className="dy-kpi-num">
        {totals.rate === null ? '—' : pct(totals.rate)}
        <small className="c-granted">granted</small>
      </p>
      <p className="dy-kpi-sub">{CONSENT_SUB(f.num(totals.denied))}</p>
      <SplitBar
        segments={[
          { swatch: 'granted', value: totals.granted },
          { swatch: 'declined', value: totals.denied },
        ]}
        label={`${f.num(totals.granted)} granted, ${f.num(totals.denied)} declined`}
      />
      <BucketChart ctx={ctx} input={input} view={view} say={say} />
    </div>
  );
}

export function ConsentRate(): ReactElement {
  const [view, setView] = useState<View>('chart');
  const panel = usePanel<ConsentRateData>({
    title: 'Consent',
    requestKey: '',
    availability: (ctx) => unavailableOf(ctx.meta.widgets.consentRate),
    request: (ctx, signal) =>
      requestWindow<ConsentRateData>(ctx, 'consent-rate', signal, (w) => ({
        from: w.from,
        to: w.to,
        interval: w.interval,
      })),
    isEmpty: (d) => d.totals.granted + d.totals.denied === 0,
    summary: (d, ctx) =>
      `Consent loaded: ${ctx.fmt.num(d.totals.granted)} granted, ${ctx.fmt.num(d.totals.denied)} declined`,
  });
  return (
    <PanelShell
      no={4}
      title="Consent"
      className="p-consent"
      panel={panel}
      tools={<ViewToggle current={view} set={setView} />}
      skeleton={
        <div>
          <SkeletonHeadline />
          <SkeletonChart height={200} />
        </div>
      }
      empty={() => <EmptyBlock title={EMPTY.consent.title} body={EMPTY.consent.body} />}
      ready={(data, ctx) => <Ready data={data} ctx={ctx} view={view} say={panel.say} />}
    />
  );
}

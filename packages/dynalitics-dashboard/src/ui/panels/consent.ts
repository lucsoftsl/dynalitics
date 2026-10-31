import type { ConsentRateData } from '../../protocol.js';
import { intervalUnit } from '../charts/labels.js';
import type { Ctx, Host } from '../context.js';
import { append, el } from '../dom.js';
import { parseInstant, pct } from '../format.js';
import { createPanel, type Panel, type PanelApi, type PanelSpec } from '../panel.js';
import { windowFor } from '../ranges.js';
import { requestWindow, unavailableOf } from '../request.js';
import { emptyBlock, skeletonChart, skeletonHeadline } from '../states.js';
import { setViewTools, splitBar, type View } from '../widgets.js';
import { bucketChart } from './bucket-chart.js';

function buildReady(
  data: ConsentRateData,
  ctx: Ctx,
  api: PanelApi<ConsentRateData>,
  view: View,
): HTMLElement {
  const f = ctx.fmt;
  const { totals } = data;
  const wrap = el('div');
  const num = el('p', 'dy-kpi-num');
  append(
    num,
    document.createTextNode(totals.rate === null ? '—' : pct(totals.rate)),
    el('small', 'c-granted', 'granted'),
  );
  wrap.appendChild(num);
  wrap.appendChild(
    el(
      'p',
      'dy-kpi-sub',
      `${f.num(totals.denied)} visits declined. Declined visits store only the page and the time. No IP, user id, name or email is kept, and they are never counted as new or returning.`,
    ),
  );
  wrap.appendChild(
    splitBar(
      [
        { swatch: 'granted', value: totals.granted },
        { swatch: 'declined', value: totals.denied },
      ],
      `${f.num(totals.granted)} granted, ${f.num(totals.denied)} declined`,
    ),
  );
  wrap.appendChild(
    bucketChart(
      api,
      ctx,
      {
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
          cell: (i) => (data.points[i]?.rate == null ? '—' : pct(data.points[i].rate)),
        },
      },
      view,
    ),
  );
  return wrap;
}

export function createConsentPanel(getCtx: () => Ctx, host: Host): Panel {
  let view: View = 'chart';
  const spec: PanelSpec<ConsentRateData> = {
    id: 'consent',
    no: 4,
    title: 'Consent',
    className: 'p-consent',
    availability: (ctx) => unavailableOf(ctx.meta.widgets.consentRate),
    request: (ctx, signal) =>
      requestWindow<ConsentRateData>(ctx, 'consent-rate', signal, (w) => ({
        from: w.from,
        to: w.to,
        interval: w.interval,
      })),
    isEmpty: (d) => d.totals.granted + d.totals.denied === 0,
    skeleton: () => {
      const b = el('div');
      append(b, skeletonHeadline(), skeletonChart(200));
      return b;
    },
    empty: () =>
      emptyBlock({
        title: 'No consent decisions yet.',
        body: 'Granted and declined visits will appear here.',
      }),
    ready: (d, ctx, api) => buildReady(d, ctx, api, view),
    summary: (d, ctx) =>
      `Consent loaded: ${ctx.fmt.num(d.totals.granted)} granted, ${ctx.fmt.num(d.totals.denied)} declined`,
    tools: (_ctx, api) =>
      setViewTools(api, view, (v) => {
        view = v;
      }),
  };
  return createPanel(spec, getCtx, host);
}

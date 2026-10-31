import { useState, type ReactElement, type ReactNode } from 'react';
import type { TopPagesData } from '../../protocol.js';
import type { Ctx } from '../../ui/context.js';
import { clamp01, sharePct } from '../../ui/format.js';
import { requestWindow, unavailableOf } from '../../ui/request.js';
import { EMPTY } from '../copy.js';
import { cssVars, cx } from '../css-vars.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonRows } from '../states.js';
import { usePanel } from '../use-panel.js';

const LIMIT_CHOICES = [10, 25, 100] as const;

function Row(props: {
  rank: string;
  content: ReactNode;
  count: string;
  share: string;
  ratio: number;
  other?: boolean;
}): ReactElement {
  return (
    <li className={cx('dy-page-row', props.other && 'dy-page-row--other')}>
      <span className="dy-rank" aria-hidden="true">
        {props.rank}
      </span>
      {props.content}
      <span className="dy-nums">
        <span className="dy-count">{props.count}</span>
        <span className="dy-share">{props.share}</span>
      </span>
      <span
        className="dy-bar"
        aria-hidden="true"
        style={cssVars({ '--r': String(clamp01(props.ratio)) })}
      />
    </li>
  );
}

function Ready(props: { data: TopPagesData; ctx: Ctx }): ReactElement {
  const { data, ctx } = props;
  const f = ctx.fmt;
  const top = Math.max(1, ...data.pages.map((p) => p.visits));
  return (
    <div>
      <p className="dy-eyebrow">
        {`TOP ${data.pages.length} · ${f.num(data.totalVisits)} VISITS · ${ctx.range.label}`}
      </p>
      <ol className="dy-pages">
        {data.pages.map((p, i) => (
          <Row
            key={`${i}-${p.page}`}
            rank={String(i + 1)}
            // Visitor-supplied: rendered as a React text child, isolated for bidi, wrappable at any length.
            content={
              <span className="v dy-page" dir="auto">
                {p.page}
              </span>
            }
            count={f.num(p.visits)}
            share={sharePct(p.share, p.visits)}
            ratio={p.visits / top}
          />
        ))}
        {data.otherVisits > 0 ? (
          <Row
            rank=""
            content={<span className="dy-page">Other pages</span>}
            count={f.num(data.otherVisits)}
            share={sharePct(
              data.totalVisits > 0 ? data.otherVisits / data.totalVisits : 0,
              data.otherVisits,
            )}
            ratio={data.otherVisits / top}
            other
          />
        ) : null}
      </ol>
    </div>
  );
}

export function TopPages(): ReactElement {
  const [limit, setLimit] = useState<number | null>(null);
  const currentLimit = (ctx: Ctx): number =>
    limit ?? Math.min(ctx.meta.defaults.topPagesLimit, ctx.meta.limits.topPagesMax);
  const panel = usePanel<TopPagesData>({
    title: 'Top pages',
    requestKey: String(limit ?? ''),
    availability: (ctx) => unavailableOf(ctx.meta.widgets.topPages),
    request: (ctx, signal) =>
      requestWindow<TopPagesData>(ctx, 'top-pages', signal, (w) => ({
        from: w.from,
        to: w.to,
        limit: String(currentLimit(ctx)),
      })),
    isEmpty: (d) => d.pages.length === 0,
    summary: (d, ctx) =>
      `Top pages loaded: ${d.pages.length} pages, ${ctx.fmt.num(d.totalVisits)} visits`,
  });
  const ctx = panel.ctx;
  const tools = ((): ReactNode => {
    if (!ctx) return null;
    const choices: number[] = LIMIT_CHOICES.filter((n) => n <= ctx.meta.limits.topPagesMax);
    const current = currentLimit(ctx);
    if (!choices.includes(current)) choices.push(current);
    return (
      <label className="dy-select-lbl">
        <span className="vh">Number of pages</span>
        <select
          className="dy-select"
          value={current}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          {choices.map((n) => (
            <option key={n} value={n}>
              {`Top ${n}`}
            </option>
          ))}
        </select>
      </label>
    );
  })();
  return (
    <PanelShell
      no={2}
      title="Top pages"
      className="p-pages"
      panel={panel}
      tools={tools}
      skeleton={<SkeletonRows count={10} />}
      empty={() => <EmptyBlock title={EMPTY.pages.title} body={EMPTY.pages.body} />}
      ready={(data, c) => <Ready data={data} ctx={c} />}
    />
  );
}

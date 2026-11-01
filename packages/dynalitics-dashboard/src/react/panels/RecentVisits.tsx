import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { RecentVisitsData } from '../../protocol.js';
import type { Ctx } from '../../ui/context.js';
import { columnsFor } from '../../ui/panels/visit-row.js';
import { toView, type VisitsView } from '../../ui/panels/visits.js';
import { requestWindow, unavailableOf } from '../../ui/request.js';
import { EMPTY } from '../copy.js';
import { PanelShell } from '../Panel.js';
import { EmptyBlock, SkeletonRows } from '../states.js';
import { usePanel, type PanelController } from '../use-panel.js';
import { HeaderRow, VisitRow } from './VisitRow.js';

const pageSize = (ctx: Ctx): number =>
  Math.max(1, Math.min(ctx.meta.defaults.recentLimit, ctx.meta.limits.recentMax));

/** Recent visits: masked by default, `reveal` only when the server offers it, cursor paging (DESIGN 6.7). */
export function RecentVisits(props: { no?: number } = {}): ReactElement {
  const [reveal, setReveal] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);

  const query =
    (ctx: Ctx, extra: Readonly<Record<string, string>>) => (w: { from: string; to: string }) => ({
      from: w.from,
      to: w.to,
      limit: String(pageSize(ctx)),
      ...(reveal ? { pii: 'reveal' } : {}),
      ...extra,
    });

  const panel: PanelController<VisitsView> = usePanel<VisitsView>({
    title: 'Recent visits',
    requestKey: reveal ? 'reveal' : '',
    availability: (ctx) => unavailableOf(ctx.meta.widgets.recentVisits),
    request: async (ctx, signal) => {
      setMoreFailed(false);
      return toView(
        await requestWindow<RecentVisitsData>(ctx, 'recent-visits', signal, query(ctx, {})),
      );
    },
    isEmpty: (d) => d.visits.length === 0,
    summary: (d) => `Recent visits loaded: ${d.visits.length} rows`,
  });

  async function loadMore(): Promise<void> {
    const before = panel.getState();
    const ctx = panel.ctx;
    const cursor = before.data?.nextCursor;
    if (!ctx || !cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = toView(
      await requestWindow<RecentVisitsData>(
        ctx,
        'recent-visits',
        new AbortController().signal,
        query(ctx, { cursor }),
      ),
    );
    setLoadingMore(false);
    const now = panel.getState();
    if (now.reqId !== before.reqId || !now.data) return;
    if (result.kind !== 'data') {
      setMoreFailed(result.kind === 'error');
      return;
    }
    focusRow.current = now.data.visits.length;
    panel.patch({
      visits: [...now.data.visits, ...result.data.visits],
      nextCursor: result.data.nextCursor,
      piiMasked: result.data.piiMasked,
    });
    panel.say(`${result.data.visits.length} more visits loaded`);
  }

  // After "load more" the first new row's first cell takes focus (docs/DESIGN.md 6.7).
  const rows = panel.state.data?.visits.length;
  useEffect(() => {
    const index = focusRow.current;
    if (index === null) return;
    focusRow.current = null;
    const cell = tableRef.current?.querySelectorAll('tbody tr')[index]?.querySelector('td');
    if (cell instanceof HTMLElement) {
      cell.setAttribute('tabindex', '-1');
      cell.focus();
    }
  }, [rows]);

  const ctx = panel.ctx;
  return (
    <PanelShell
      no={props.no ?? 5}
      title="Recent visits"
      className="p-table"
      sheet
      panel={panel}
      tools={
        ctx?.meta.features.piiRevealable ? (
          <button
            type="button"
            className="dy-btn"
            aria-pressed={reveal}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? 'Hide full values' : 'Show full values'}
          </button>
        ) : null
      }
      skeleton={<SkeletonRows count={6} />}
      empty={() => <EmptyBlock title={EMPTY.table.title} body={EMPTY.table.body} />}
      ready={(data, c) => {
        const columns = columnsFor(c.meta.fields);
        const revealed = reveal && !data.piiMasked;
        return (
          <div className={revealed ? 'dy-revealed' : undefined}>
            {revealed ? (
              <p className="dy-note">Showing personal data. Hide when sharing your screen.</p>
            ) : reveal && data.piiMasked ? (
              <p className="dy-note">The server kept values masked.</p>
            ) : null}
            <div className="dy-table-wrap" ref={tableRef}>
              <table className="dy-table" role="table" aria-label="Recent visits, newest first">
                <thead role="rowgroup">
                  <HeaderRow columns={columns} masked={data.piiMasked} />
                </thead>
                <tbody role="rowgroup">
                  {data.visits.map((v, i) => (
                    <VisitRow key={`${v.id ?? 'row'}-${i}`} visit={v} columns={columns} f={c.fmt} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dy-more">
              {moreFailed ? <span className="dy-note">Could not load more visits. </span> : null}
              {data.nextCursor ? (
                <button
                  type="button"
                  className="dy-btn dy-btn--text"
                  disabled={loadingMore}
                  aria-busy={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Loading...' : `Load ${pageSize(c)} more`}
                </button>
              ) : (
                <span className="dy-note">
                  {c.meta.features.recentVisitsCursor
                    ? 'End of range.'
                    : `Showing the latest ${data.visits.length} visits.`}
                </span>
              )}
            </div>
          </div>
        );
      }}
    />
  );
}

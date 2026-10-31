import type { RecentVisit, RecentVisitsData } from '../../protocol.js';
import type { ApiResult } from '../api.js';
import type { Ctx, Host } from '../context.js';
import { append, el } from '../dom.js';
import { createPanel, type Panel, type PanelApi, type PanelSpec } from '../panel.js';
import { requestWindow, unavailableOf } from '../request.js';
import { emptyBlock, skeletonRows } from '../states.js';
import { columnsFor, headerRow, visitRow } from './visit-row.js';

export interface VisitsView {
  readonly visits: readonly RecentVisit[];
  readonly nextCursor: string | null;
  readonly piiMasked: boolean;
}

export function toView(r: ApiResult<RecentVisitsData>): ApiResult<VisitsView> {
  if (r.kind !== 'data') return r;
  return {
    kind: 'data',
    meta: r.meta,
    data: { visits: r.data.visits, nextCursor: r.data.nextCursor, piiMasked: r.meta.piiMasked },
  };
}

function pageSize(ctx: Ctx): number {
  return Math.max(1, Math.min(ctx.meta.defaults.recentLimit, ctx.meta.limits.recentMax));
}

export function createVisitsPanel(getCtx: () => Ctx, host: Host): Panel {
  let reveal = false;
  let moreFailed = false;
  let loadingMore = false;

  const query =
    (ctx: Ctx, extra: Readonly<Record<string, string>>) => (w: { from: string; to: string }) => ({
      from: w.from,
      to: w.to,
      limit: String(pageSize(ctx)),
      ...(reveal ? { pii: 'reveal' } : {}),
      ...extra,
    });

  async function loadMore(api: PanelApi<VisitsView>): Promise<void> {
    const before = api.getState();
    const cursor = before.data?.nextCursor;
    if (!cursor || loadingMore) return;
    loadingMore = true;
    moreFailed = false;
    api.rerender();
    const ctx = api.getCtx();
    const result = toView(
      await requestWindow<RecentVisitsData>(
        ctx,
        'recent-visits',
        new AbortController().signal,
        query(ctx, { cursor }),
      ),
    );
    loadingMore = false;
    const now = api.getState();
    if (now.reqId !== before.reqId || !now.data) return;
    if (result.kind !== 'data') {
      moreFailed = result.kind === 'error';
      api.rerender();
      return;
    }
    const added = result.data.visits.length;
    const old = now.data.visits.length;
    api.patch({
      visits: [...now.data.visits, ...result.data.visits],
      nextCursor: result.data.nextCursor,
      piiMasked: result.data.piiMasked,
    });
    const firstNew = api.element.querySelectorAll('tbody tr')[old]?.querySelector('td');
    if (firstNew instanceof HTMLElement) {
      firstNew.setAttribute('tabindex', '-1');
      firstNew.focus();
    }
    api.say(`${added} more visits loaded`);
  }

  function footer(data: VisitsView, ctx: Ctx, api: PanelApi<VisitsView>): HTMLElement {
    const row = el('div', 'dy-more');
    if (moreFailed) row.appendChild(el('span', 'dy-note', 'Could not load more visits. '));
    if (data.nextCursor) {
      const more = el(
        'button',
        'dy-btn dy-btn--text',
        loadingMore ? 'Loading...' : `Load ${pageSize(ctx)} more`,
        { type: 'button' },
      );
      more.disabled = loadingMore;
      more.setAttribute('aria-busy', String(loadingMore));
      more.addEventListener('click', () => void loadMore(api));
      row.appendChild(more);
    } else {
      row.appendChild(
        el(
          'span',
          'dy-note',
          ctx.meta.features.recentVisitsCursor
            ? 'End of range.'
            : `Showing the latest ${data.visits.length} visits.`,
        ),
      );
    }
    return row;
  }

  function buildReady(data: VisitsView, ctx: Ctx, api: PanelApi<VisitsView>): HTMLElement {
    const columns = columnsFor(ctx.meta.fields);
    const revealed = reveal && !data.piiMasked;
    const wrap = el('div', revealed ? 'dy-revealed' : '');
    if (revealed)
      wrap.appendChild(el('p', 'dy-note', 'Showing personal data. Hide when sharing your screen.'));
    else if (reveal && data.piiMasked)
      wrap.appendChild(el('p', 'dy-note', 'The server kept values masked.'));
    const table = el('table', 'dy-table', null, {
      role: 'table',
      'aria-label': 'Recent visits, newest first',
    });
    const thead = el('thead', undefined, null, { role: 'rowgroup' });
    thead.appendChild(headerRow(columns, data.piiMasked));
    const tbody = el('tbody', undefined, null, { role: 'rowgroup' });
    for (const v of data.visits) tbody.appendChild(visitRow(v, columns, ctx.fmt));
    append(table, thead, tbody);
    const tableWrap = el('div', 'dy-table-wrap');
    tableWrap.appendChild(table);
    append(wrap, tableWrap, footer(data, ctx, api));
    return wrap;
  }

  const spec: PanelSpec<VisitsView> = {
    id: 'table',
    no: 5,
    title: 'Recent visits',
    className: 'p-table',
    sheet: true,
    availability: (ctx) => unavailableOf(ctx.meta.widgets.recentVisits),
    request: async (ctx, signal) => {
      moreFailed = false;
      return toView(
        await requestWindow<RecentVisitsData>(ctx, 'recent-visits', signal, query(ctx, {})),
      );
    },
    isEmpty: (d) => d.visits.length === 0,
    skeleton: () => skeletonRows(6),
    empty: () =>
      emptyBlock({
        title: 'No visits in this range.',
        body: 'Newest visits appear here as soon as they are written.',
      }),
    ready: buildReady,
    summary: (d) => `Recent visits loaded: ${d.visits.length} rows`,
    tools: (ctx, api) => {
      if (!ctx.meta.features.piiRevealable) return [];
      const b = el('button', 'dy-btn', reveal ? 'Hide full values' : 'Show full values', {
        type: 'button',
        'aria-pressed': String(reveal),
      });
      b.addEventListener('click', () => {
        reveal = !reveal;
        b.setAttribute('aria-pressed', String(reveal));
        b.textContent = reveal ? 'Hide full values' : 'Show full values';
        api.load();
      });
      return [b];
    },
  };
  return createPanel(spec, getCtx, host);
}

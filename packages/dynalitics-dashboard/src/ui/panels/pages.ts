import type { TopPagesData } from '../../protocol.js';
import type { Ctx, Host } from '../context.js';
import { append, el, visitorText } from '../dom.js';
import { clamp01, sharePct } from '../format.js';
import { createPanel, type Panel, type PanelApi, type PanelSpec } from '../panel.js';
import { requestWindow, unavailableOf } from '../request.js';
import { emptyBlock, skeletonRows } from '../states.js';

const LIMIT_CHOICES = [10, 25, 100] as const;

function row(
  rank: string,
  content: Node,
  count: string,
  share: string,
  ratio: number,
  other = false,
): HTMLElement {
  const li = el('li', other ? 'dy-page-row dy-page-row--other' : 'dy-page-row');
  const nums = el('span', 'dy-nums');
  append(nums, el('span', 'dy-count', count), el('span', 'dy-share', share));
  append(
    li,
    el('span', 'dy-rank', rank, { 'aria-hidden': 'true' }),
    content,
    nums,
    el('span', 'dy-bar', null, { 'aria-hidden': 'true' }),
  );
  const bar = li.lastElementChild as HTMLElement;
  bar.style.setProperty('--r', String(clamp01(ratio)));
  return li;
}

function buildReady(data: TopPagesData, ctx: Ctx): HTMLElement {
  const f = ctx.fmt;
  const top = Math.max(1, ...data.pages.map((p) => p.visits));
  const wrap = el('div');
  wrap.appendChild(
    el(
      'p',
      'dy-eyebrow',
      `TOP ${data.pages.length} · ${f.num(data.totalVisits)} VISITS · ${ctx.range.label}`,
    ),
  );
  const list = el('ol', 'dy-pages');
  data.pages.forEach((p, i) => {
    list.appendChild(
      row(
        String(i + 1),
        visitorText('span', p.page, 'dy-page', true),
        f.num(p.visits),
        sharePct(p.share, p.visits),
        p.visits / top,
      ),
    );
  });
  if (data.otherVisits > 0) {
    const share = data.totalVisits > 0 ? data.otherVisits / data.totalVisits : 0;
    list.appendChild(
      row(
        '',
        el('span', 'dy-page', 'Other pages'),
        f.num(data.otherVisits),
        sharePct(share, data.otherVisits),
        data.otherVisits / top,
        true,
      ),
    );
  }
  wrap.appendChild(list);
  return wrap;
}

export function createPagesPanel(getCtx: () => Ctx, host: Host): Panel {
  let limit: number | null = null;
  const currentLimit = (ctx: Ctx): number =>
    limit ?? Math.min(ctx.meta.defaults.topPagesLimit, ctx.meta.limits.topPagesMax);

  const spec: PanelSpec<TopPagesData> = {
    id: 'pages',
    no: 2,
    title: 'Top pages',
    className: 'p-pages',
    availability: (ctx) => unavailableOf(ctx.meta.widgets.topPages),
    request: (ctx, signal) =>
      requestWindow<TopPagesData>(ctx, 'top-pages', signal, (w) => ({
        from: w.from,
        to: w.to,
        limit: String(currentLimit(ctx)),
      })),
    isEmpty: (d) => d.pages.length === 0,
    skeleton: () => skeletonRows(10),
    empty: () =>
      emptyBlock({ title: 'No pages yet.', body: 'Pages appear once visits are recorded.' }),
    ready: buildReady,
    summary: (d, ctx) =>
      `Top pages loaded: ${d.pages.length} pages, ${ctx.fmt.num(d.totalVisits)} visits`,
    tools: (ctx, api: PanelApi<TopPagesData>) => {
      const choices = LIMIT_CHOICES.filter((n) => n <= ctx.meta.limits.topPagesMax);
      const current = currentLimit(ctx);
      if (!choices.includes(current as 10)) choices.push(current as 10);
      const label = el('label', 'dy-select-lbl');
      const select = el('select', 'dy-select');
      for (const n of choices)
        select.appendChild(
          el('option', undefined, `Top ${n}`, {
            value: n,
            ...(n === current ? { selected: 'selected' } : {}),
          }),
        );
      select.addEventListener('change', () => {
        limit = Number(select.value);
        api.load();
      });
      append(label, el('span', 'vh', 'Number of pages'), select);
      return [label];
    },
  };
  return createPanel(spec, getCtx, host);
}

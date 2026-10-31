import type { FieldFacet, SearchFieldsData } from '../../protocol.js';
import type { Ctx, Host } from '../context.js';
import { append, el, swatch, visitorText, visuallyHidden } from '../dom.js';
import { createPanel, type Panel, type PanelSpec } from '../panel.js';
import { unavailableOf } from '../request.js';
import { emptyBlock, skeletonRows } from '../states.js';
import { explorerGet, type ExplorerHost } from './host.js';
import { NO_MATCHES } from './histogram.js';
import { ANY_VALUE } from './state.js';

const UNQUOTABLE = 'This value contains a double quote and cannot be added to a search.';

function bar(share: number): HTMLElement {
  const b = el('span', 'dy-xbar', null, { 'aria-hidden': 'true' });
  b.style.setProperty('--w', String(Math.max(0, Math.min(1, share))));
  return b;
}

function valueRow(
  facet: FieldFacet,
  value: string,
  count: number,
  matched: number,
  ctx: Ctx,
  x: ExplorerHost,
): HTMLElement {
  const li = el('li', 'dy-xval');
  const n = ctx.fmt.num(count);
  if (value.includes('"')) {
    append(li, visitorText('span', value, 'dy-xval-v', true), visuallyHidden(UNQUOTABLE));
  } else {
    const add = el('button', 'dy-xval-add', null, {
      type: 'button',
      'aria-label': `Only ${facet.key} = ${value} (${n} visits)`,
    });
    add.appendChild(visitorText('span', value, 'dy-xval-v', true));
    add.addEventListener('click', () => x.addClause(facet.key, value, false));
    const drop = el('button', 'dy-xval-drop', '−', {
      type: 'button',
      'aria-label': `Exclude ${facet.key} = ${value}`,
    });
    drop.addEventListener('click', () => x.addClause(facet.key, value, true));
    append(li, add, drop);
  }
  append(li, el('span', 'dy-xval-n', n), bar(matched === 0 ? 0 : count / matched));
  return li;
}

function facetBlock(facet: FieldFacet, matched: number, ctx: Ctx, x: ExplorerHost): HTMLElement {
  const block = el('section', 'dy-xfacet', null, { 'aria-label': `Field ${facet.key}` });
  block.appendChild(el('h3', 'dy-xfacet-key', facet.key));
  const list = el('ul', 'dy-xvals');
  for (const v of facet.values)
    list.appendChild(valueRow(facet, v.value, v.count, matched, ctx, x));
  if (facet.nullCount > 0) {
    const li = el('li', 'dy-xval dy-xval--none');
    const has = el('button', 'dy-xval-add', null, {
      type: 'button',
      'aria-label': `Only visits without a ${facet.key} value`,
    });
    append(has, swatch('unknown'), el('span', 'dy-xval-v', 'No value'));
    has.addEventListener('click', () => x.addClause(facet.key, ANY_VALUE, true));
    append(li, has, el('span', 'dy-xval-n', ctx.fmt.num(facet.nullCount)));
    list.appendChild(li);
  }
  if (facet.otherCount > 0) {
    const li = el('li', 'dy-xval dy-xval--other');
    append(
      li,
      swatch('other'),
      el('span', 'dy-xval-v', 'Other values'),
      el('span', 'dy-xval-n', ctx.fmt.num(facet.otherCount)),
    );
    list.appendChild(li);
  }
  block.appendChild(list);
  return block;
}

/** No. 2 of the explorer: top values per facet field among the matches (docs/DESIGN.md 14.3). */
export function createFieldsPanel(getCtx: () => Ctx, host: Host, x: ExplorerHost): Panel {
  const spec: PanelSpec<SearchFieldsData> = {
    id: 'xfields',
    no: 2,
    title: 'Fields',
    className: 'p-xfields',
    availability: (ctx) =>
      ctx.meta.widgets.explorer ? unavailableOf(ctx.meta.widgets.explorer) : null,
    request: (ctx, signal, panel) =>
      explorerGet<SearchFieldsData>(ctx, x, 'search/fields', signal, panel),
    isEmpty: (d) => d.matched === 0,
    skeleton: () => skeletonRows(5),
    empty: () => emptyBlock(NO_MATCHES),
    ready: (data, ctx) => {
      const wrap = el('div', 'dy-xfacets');
      for (const facet of data.fields) wrap.appendChild(facetBlock(facet, data.matched, ctx, x));
      return wrap;
    },
    summary: (d) => `Fields loaded for ${d.matched} matching visits`,
  };
  return createPanel(spec, getCtx, host);
}

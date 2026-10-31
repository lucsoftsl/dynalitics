import type { Failure, FailureKind } from './api.js';
import { append, el, svg, visuallyHidden } from './dom.js';
import type { Unavailable } from '../protocol.js';

export function emptyLedger(): SVGElement {
  const root = svg('svg', {
    width: 160,
    height: 56,
    viewBox: '0 0 160 56',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'dy-ledger',
  });
  [10, 24, 38].forEach((y) =>
    svg('line', { x1: 14, x2: 160, y1: y, y2: y, class: 'base-l' }, root),
  );
  svg('line', { x1: 0, x2: 160, y1: 52, y2: 52, class: 'base-l', 'stroke-dasharray': '1 4' }, root);
  svg('rect', { x: 0, y: 6, width: 8, height: 8, class: 'f-new' }, root);
  return root;
}

export interface EmptyCopy {
  readonly title: string;
  readonly body: string;
}

export function emptyBlock(
  copy: EmptyCopy,
  actions: readonly Node[] = [],
  bodyNodes?: Node,
): HTMLElement {
  const box = el('div', 'dy-state');
  append(box, emptyLedger(), el('h3', undefined, copy.title));
  box.appendChild(bodyNodes ?? el('p', undefined, copy.body));
  if (actions.length) {
    const row = el('div', 'dy-actions');
    append(row, ...actions);
    box.appendChild(row);
  }
  return box;
}

/** Calm, non-error state (docs/DESIGN.md 8.6): no red, no retry, no illustration. */
export function unavailableBlock(u: Unavailable, panelTitle: string): HTMLElement {
  const box = el('div', 'dy-state dy-na-state', null, { role: 'status' });
  append(
    box,
    el('span', 'dy-na-label', 'Not available'),
    el('h3', undefined, `${panelTitle} isn't available here.`),
    el('p', undefined, u.message),
    el('p', 'dy-ref', `reason: ${u.reason}`),
  );
  return box;
}

interface ErrorCopy {
  readonly stamp: string;
  readonly title: string;
  readonly body: string;
  readonly retry: boolean;
  readonly shorter: boolean;
}

const ERROR_COPY: Record<FailureKind, ErrorCopy> = {
  forbidden: {
    stamp: 'NOT AUTHORISED',
    title: "You can't view analytics.",
    body: 'The app that serves this page said no. Sign in with an account that is allowed to see analytics, then reload.',
    retry: false,
    shorter: false,
  },
  unexpected: {
    stamp: 'UNEXPECTED REPLY',
    title: "The analytics endpoint didn't return data.",
    body: "It returned something that isn't analytics JSON, or redirected somewhere else. This usually means a login page, single sign-on or a proxy in front of this route. Check the route and its authorisation.",
    retry: true,
    shorter: false,
  },
  unreachable: {
    stamp: 'UNREACHABLE',
    title: "Can't reach the analytics endpoint.",
    body: 'Check your connection and that the server is running. Nothing was lost; data stays in your database.',
    retry: true,
    shorter: false,
  },
  timeout: {
    stamp: 'TIMED OUT',
    title: 'That took too long.',
    body: 'The query exceeded its time limit. Choose a shorter range.',
    retry: true,
    shorter: true,
  },
  busy: {
    stamp: 'UNAVAILABLE',
    title: 'The database is busy or unavailable.',
    body: 'Try again in a moment.',
    retry: true,
    shorter: false,
  },
  bad_request: {
    stamp: 'BAD REQUEST',
    title: "That range isn't allowed.",
    body: 'Choose a shorter range.',
    retry: false,
    shorter: true,
  },
  not_found: {
    stamp: 'NOT FOUND',
    title: "This route doesn't exist.",
    body: 'The dashboard and server versions may not match. Update both packages.',
    retry: false,
    shorter: false,
  },
  server: {
    stamp: 'ERROR',
    title: 'Something went wrong on the server.',
    body: 'The server logged the details. Try again.',
    retry: true,
    shorter: false,
  },
};

const SSO_HINT =
  'If this page sits behind single sign-on, your sign-in may have expired: reload the page.';

export interface ErrorActions {
  readonly role: 'alert' | 'status';
  readonly cooldownLeftMs: number;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  /** Present only when the current range is longer than 7 days. */
  readonly onTrySevenDays: (() => void) | null;
  /** First /api/meta request: a cross-origin sign-in redirect looks like a network error. */
  readonly ssoHint?: boolean;
  /** A 400 on a normally clamped panel means stale meta: offer a reload instead of a shorter range. */
  readonly reloadOnBadRequest?: boolean;
}

function button(
  label: string,
  onClick: () => void,
  className = 'dy-btn dy-btn--text',
): HTMLButtonElement {
  const b = el('button', className, label, { type: 'button' });
  b.addEventListener('click', onClick);
  return b;
}

/** Fixed copy keyed by failure kind; the server's own message is never shown (docs/DESIGN.md 8.3). */
export function errorBlock(failure: Failure, actions: ErrorActions): HTMLElement {
  const copy = ERROR_COPY[failure.kind];
  const box = el('div', 'dy-state dy-err', null, { role: actions.role });
  append(
    box,
    el('span', 'dy-stamp', copy.stamp),
    el('h3', undefined, copy.title),
    el('p', undefined, copy.body),
  );
  const ref = failure.code ?? (failure.status ? `HTTP ${failure.status}` : '');
  const refLine = el('p', 'dy-ref', ref);
  if (failure.param) refLine.appendChild(el('span', 'v', ` (${failure.param})`));
  if (ref) box.appendChild(refLine);

  if (failure.kind === 'unreachable' && actions.ssoHint)
    box.appendChild(el('p', undefined, SSO_HINT));
  const row = el('div', 'dy-actions');
  const staleMeta = failure.kind === 'bad_request' && actions.reloadOnBadRequest === true;
  if (failure.kind === 'forbidden' || staleMeta)
    row.appendChild(button('Reload page', actions.onReload, 'dy-btn'));
  if (copy.shorter && !staleMeta && actions.onTrySevenDays)
    row.appendChild(button('Try 7 days', actions.onTrySevenDays));
  if (copy.retry) {
    const retry = button('Retry', actions.onRetry);
    if (actions.cooldownLeftMs > 0) {
      retry.disabled = true;
      retry.setAttribute('aria-busy', 'true');
      retry.textContent = 'Retrying...';
    }
    row.appendChild(retry);
  }
  if (row.childElementCount) box.appendChild(row);
  return box;
}

/** One line above a panel that still shows older data after a failed refresh. */
export function staleNotice(failure: Failure, shownAt: string, onRetry: () => void): HTMLElement {
  const copy = ERROR_COPY[failure.kind];
  const row = el('p', 'dy-stale');
  append(
    row,
    el('span', 'dy-stamp', copy.stamp),
    document.createTextNode(` Showing data from ${shownAt} UTC. `),
  );
  if (copy.retry) row.appendChild(button('Retry', onRetry));
  return row;
}

function skel(className: string, width?: string): HTMLElement {
  const node = el('div', `dy-skel ${className}`, null, { 'aria-hidden': 'true' });
  if (width) node.style.setProperty('--w', width);
  return node;
}

export function skeletonHeadline(): HTMLElement {
  const box = el('div', 'dy-skel-box');
  append(box, skel('dy-skel-num'), skel('dy-skel-line', '70%'), skel('dy-skel-line', '45%'));
  return box;
}

export function skeletonChart(height: number): HTMLElement {
  const box = skel('dy-skel-chart');
  box.style.setProperty('--h', `${height}px`);
  return box;
}

const SKEL_WIDTHS = ['100%', '82%', '74%', '60%', '51%', '44%', '33%', '28%', '20%', '14%'];

export function skeletonRows(count: number): HTMLElement {
  const box = el('div', 'dy-skel-box');
  for (let i = 0; i < count; i++)
    box.appendChild(skel('dy-skel-row', SKEL_WIDTHS[i % SKEL_WIDTHS.length]));
  return box;
}

export function loadingNote(title: string): HTMLElement {
  return visuallyHidden(`Loading ${title}`);
}

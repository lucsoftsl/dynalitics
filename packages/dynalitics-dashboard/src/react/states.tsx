import type { ReactElement, ReactNode } from 'react';
import type { Failure } from '../ui/api.js';
import type { Unavailable } from '../protocol.js';
import { ERROR_COPY, SSO_HINT } from './copy.js';
import { cssVars } from './css-vars.js';

export function EmptyLedger(): ReactElement {
  return (
    <svg
      width={160}
      height={56}
      viewBox="0 0 160 56"
      aria-hidden="true"
      focusable="false"
      className="dy-ledger"
    >
      {[10, 24, 38].map((y) => (
        <line key={y} x1={14} x2={160} y1={y} y2={y} className="base-l" />
      ))}
      <line x1={0} x2={160} y1={52} y2={52} className="base-l" strokeDasharray="1 4" />
      <rect x={0} y={6} width={8} height={8} className="f-new" />
    </svg>
  );
}

export function EmptyBlock(props: {
  title: string;
  body?: string;
  bodyNode?: ReactNode;
  actions?: ReactNode;
  extra?: ReactNode;
}): ReactElement {
  return (
    <div className="dy-state">
      <EmptyLedger />
      <h3>{props.title}</h3>
      {props.bodyNode ?? <p>{props.body}</p>}
      {props.actions ? <div className="dy-actions">{props.actions}</div> : null}
      {props.extra}
    </div>
  );
}

/** Calm, non-error state (docs/DESIGN.md 8.6): no red, no retry, no illustration. */
export function UnavailableBlock(props: {
  unavailable: Unavailable;
  panelTitle: string;
}): ReactElement {
  return (
    <div className="dy-state dy-na-state" role="status">
      <span className="dy-na-label">Not available</span>
      <h3>{`${props.panelTitle} isn't available here.`}</h3>
      <p>{props.unavailable.message}</p>
      <p className="dy-ref">{`reason: ${props.unavailable.reason}`}</p>
    </div>
  );
}

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

/** Fixed copy keyed by failure kind; the server's own message is never shown (docs/DESIGN.md 8.3). */
export function ErrorBlock(props: { failure: Failure; actions: ErrorActions }): ReactElement {
  const { failure, actions } = props;
  const copy = ERROR_COPY[failure.kind];
  const ref = failure.code ?? (failure.status ? `HTTP ${failure.status}` : '');
  const staleMeta = failure.kind === 'bad_request' && actions.reloadOnBadRequest === true;
  const reload = failure.kind === 'forbidden' || staleMeta;
  const trySeven = copy.shorter && !staleMeta && actions.onTrySevenDays !== null;
  const cooling = actions.cooldownLeftMs > 0;
  const hasActions = reload || trySeven || copy.retry;
  return (
    <div className="dy-state dy-err" role={actions.role}>
      <span className="dy-stamp">{copy.stamp}</span>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      {ref ? (
        <p className="dy-ref">
          {ref}
          {failure.param ? <span className="v">{` (${failure.param})`}</span> : null}
        </p>
      ) : null}
      {failure.kind === 'unreachable' && actions.ssoHint ? <p>{SSO_HINT}</p> : null}
      {hasActions ? (
        <div className="dy-actions">
          {reload ? (
            <button type="button" className="dy-btn" onClick={actions.onReload}>
              Reload page
            </button>
          ) : null}
          {trySeven ? (
            <button
              type="button"
              className="dy-btn dy-btn--text"
              onClick={actions.onTrySevenDays ?? undefined}
            >
              Try 7 days
            </button>
          ) : null}
          {copy.retry ? (
            <button
              type="button"
              className="dy-btn dy-btn--text"
              onClick={actions.onRetry}
              disabled={cooling}
              aria-busy={cooling ? true : undefined}
            >
              {cooling ? 'Retrying...' : 'Retry'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One line above a panel that still shows older data after a failed refresh. */
export function StaleNotice(props: {
  failure: Failure;
  shownAt: string;
  onRetry: () => void;
}): ReactElement {
  const copy = ERROR_COPY[props.failure.kind];
  return (
    <p className="dy-stale">
      <span className="dy-stamp">{copy.stamp}</span>
      {` Showing data from ${props.shownAt} UTC. `}
      {copy.retry ? (
        <button type="button" className="dy-btn dy-btn--text" onClick={props.onRetry}>
          Retry
        </button>
      ) : null}
    </p>
  );
}

function Skel(props: { className: string; width?: string; height?: string }): ReactElement {
  const vars: Record<string, string> = {};
  if (props.width) vars['--w'] = props.width;
  if (props.height) vars['--h'] = props.height;
  return (
    <div
      className={`dy-skel ${props.className}`}
      aria-hidden="true"
      style={Object.keys(vars).length ? cssVars(vars) : undefined}
    />
  );
}

export function SkeletonHeadline(): ReactElement {
  return (
    <div className="dy-skel-box">
      <Skel className="dy-skel-num" />
      <Skel className="dy-skel-line" width="70%" />
      <Skel className="dy-skel-line" width="45%" />
    </div>
  );
}

export function SkeletonChart(props: { height: number }): ReactElement {
  return <Skel className="dy-skel-chart" height={`${props.height}px`} />;
}

const SKEL_WIDTHS = ['100%', '82%', '74%', '60%', '51%', '44%', '33%', '28%', '20%', '14%'];

export function SkeletonRows(props: { count: number }): ReactElement {
  return (
    <div className="dy-skel-box">
      {Array.from({ length: props.count }, (_, i) => (
        <Skel
          key={i}
          className="dy-skel-row"
          width={SKEL_WIDTHS[i % SKEL_WIDTHS.length] ?? '100%'}
        />
      ))}
    </div>
  );
}

export function VisuallyHidden(props: { children: string }): ReactElement {
  return <span className="vh">{props.children}</span>;
}

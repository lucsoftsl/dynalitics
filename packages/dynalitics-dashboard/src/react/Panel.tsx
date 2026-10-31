import { useId, type ReactElement, type ReactNode } from 'react';
import type { Unavailable } from '../protocol.js';
import type { Ctx } from '../ui/context.js';
import { parseInstant } from '../ui/format.js';
import { cx } from './css-vars.js';
import { ErrorBlock, StaleNotice, UnavailableBlock } from './states.js';
import type { PanelController } from './use-panel.js';

export interface PanelShellProps<T> {
  readonly no: number;
  readonly title: string;
  readonly className: string;
  readonly sheet?: boolean;
  /** Head eyebrow; `No. n` when omitted. */
  readonly eyebrow?: string | undefined;
  /** A 400 on this panel means stale meta (it is normally clamped): offer a reload. */
  readonly reloadOnBadRequest?: boolean;
  readonly tools?: ReactNode;
  readonly panel: PanelController<T>;
  readonly skeleton: ReactNode;
  readonly empty: (ctx: Ctx) => ReactNode;
  readonly ready: (data: T, ctx: Ctx) => ReactNode;
}

/** Panel chrome shared by every widget: head, `aria-busy` body, live region and the state switch. */
export function PanelShell<T>(props: PanelShellProps<T>): ReactElement {
  const headingId = useId();
  const { panel } = props;
  const { state, ctx } = panel;
  const content = ((): ReactNode => {
    switch (state.status) {
      case 'loading':
        return (
          <div className={panel.skeletonShown ? 'dy-loading' : 'dy-loading dy-loading--wait'}>
            {props.skeleton}
          </div>
        );
      case 'ready':
        return ctx && state.data !== null ? props.ready(state.data, ctx) : null;
      case 'empty':
        return ctx ? props.empty(ctx) : null;
      case 'unavailable':
        return (
          <UnavailableBlock
            unavailable={state.unavailable as Unavailable}
            panelTitle={props.title}
          />
        );
      case 'error':
        return state.failure ? (
          <ErrorBlock
            failure={state.failure}
            actions={{
              role: panel.errorRole,
              cooldownLeftMs: panel.cooldownLeftMs,
              onRetry: panel.retry,
              onReload: panel.reloadPage,
              onTrySevenDays: ctx && ctx.range.days > 7 ? () => panel.setRange('7d') : null,
              reloadOnBadRequest: props.reloadOnBadRequest === true,
              ssoHint: ctx === null,
            }}
          />
        ) : null;
    }
  })();
  const shownAt =
    state.staleFailure && state.generatedAt && ctx
      ? ctx.fmt.time(parseInstant(state.generatedAt))
      : null;
  return (
    <section
      className={cx(
        'dy-panel',
        props.className,
        props.sheet && 'dy-panel--sheet',
        state.refreshing && 'is-refreshing-panel',
      )}
      aria-labelledby={headingId}
    >
      <div className="dy-progress" aria-hidden="true" />
      <header className="dy-panel-head">
        <p className="dy-eyebrow" aria-hidden="true">
          {props.eyebrow ?? `No. ${props.no}`}
        </p>
        <h2 className="dy-h2" id={headingId}>
          {props.title}
        </h2>
        <div className="dy-tools">{props.tools}</div>
      </header>
      <div className="dy-body">
        <div className={cx('dy-viz', state.refreshing && 'is-refreshing')} aria-busy={panel.busy}>
          {state.staleFailure && shownAt ? (
            <StaleNotice failure={state.staleFailure} shownAt={shownAt} onRetry={panel.retry} />
          ) : null}
          {content}
        </div>
      </div>
      <p className="vh" role="status" aria-live="polite">
        {panel.live}
      </p>
    </section>
  );
}

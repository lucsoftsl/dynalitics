import { useEffect, useId, type ReactElement } from 'react';
import { useInternal } from './internal-context.js';
import { DynaliticsProvider } from './provider.js';
import { errorsOn } from '../ui/panels/errors.js';
import { countryMapOn } from '../ui/geo.js';
import { ConsentRate } from './panels/ConsentRate.js';
import { CountryMap } from './panels/CountryMap.js';
import { Errors } from './panels/Errors.js';
import { NewVsReturning } from './panels/NewVsReturning.js';
import { RecentVisits } from './panels/RecentVisits.js';
import { TopPages } from './panels/TopPages.js';
import { VisitsOverTime } from './panels/VisitsOverTime.js';
import { RangeSelector } from './RangeSelector.js';
import { ErrorBlock } from './states.js';
import type { DashboardProps } from './types.js';

function Masthead(): ReactElement {
  const dyn = useInternal();
  return (
    <header className="dy-mast">
      <h1 className="dy-wordmark">dynalitics</h1>
      <RangeSelector />
      <div className="dy-mast-meta">
        <span className="dy-updated">
          Updated <time>{dyn.updatedAt === null ? '—' : dyn.fmt.time(dyn.updatedAt)}</time> UTC
        </span>
        <span className="dy-mast-btns">
          <button type="button" className="dy-btn" onClick={dyn.refresh}>
            Refresh
          </button>
          {dyn.theme.canToggle ? (
            <button
              type="button"
              className="dy-btn"
              aria-pressed={dyn.theme.isDark}
              onClick={dyn.theme.toggle}
            >
              Dark theme
            </button>
          ) : null}
        </span>
      </div>
    </header>
  );
}

function Grid(): ReactElement {
  const dyn = useInternal();
  const failure = dyn.status === 'error' ? dyn.failure : null;
  const errors = dyn.ctx !== null && errorsOn(dyn.ctx);
  const geo = dyn.ctx !== null && countryMapOn(dyn.ctx.meta);
  const { claimErrorRole } = dyn;
  // A page-level failure happens before any panel exists, so it is always the page's first error.
  useEffect(() => {
    if (failure) claimErrorRole();
  }, [failure, claimErrorRole]);
  return (
    <div className="dy-grid">
      {failure ? (
        // No point asking the other routes: an unauthorised caller would only trigger more 403s.
        <ErrorBlock
          failure={failure}
          actions={{
            role: 'alert',
            cooldownLeftMs: 0,
            onRetry: dyn.refresh,
            onReload: dyn.reloadPage,
            onTrySevenDays: null,
            ssoHint: true,
          }}
        />
      ) : (
        <>
          <VisitsOverTime />
          <TopPages />
          <NewVsReturning />
          <ConsentRate />
          {errors ? <Errors no={5} /> : null}
          {geo ? <CountryMap no={errors ? 6 : 5} /> : null}
          <RecentVisits no={5 + Number(errors) + Number(geo)} />
        </>
      )}
    </div>
  );
}

function Layout(props: { landmark: 'main' | 'region' }): ReactElement {
  const mainId = useId();
  const grid = <Grid />;
  return (
    <>
      <a className="dy-skip" href={`#${mainId}`}>
        Skip to analytics
      </a>
      <div className="dy-wrap">
        <Masthead />
        {props.landmark === 'main' ? (
          <main id={mainId} tabIndex={-1} className="dy-main">
            {grid}
          </main>
        ) : (
          <div id={mainId} tabIndex={-1} className="dy-main" role="region" aria-label="Analytics">
            {grid}
          </div>
        )}
      </div>
      <footer className="dy-foot">dynalitics · data stays in your database · times in UTC</footer>
    </>
  );
}

/** The whole dashboard: masthead, range selector, five panels (plus Errors and the country map when the server offers them). Needs the dynalitics read endpoint. */
export function DynaliticsDashboard(props: DashboardProps): ReactElement {
  const { landmark = 'main', ...provider } = props;
  return (
    <DynaliticsProvider {...provider}>
      <Layout landmark={landmark} />
    </DynaliticsProvider>
  );
}

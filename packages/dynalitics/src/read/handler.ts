import { bool, custom, fn, int, obj, oneOf, runRule } from '../config/validate.js';
import { DynaliticsConfigError } from '../errors.js';
import { getInternals } from '../internals.js';
import type { Dynalitics } from '../types.js';
import { createLock } from './lock/index.js';
import { lockOptionRules } from './lock/options.js';
import { createReporter, type ReadErrorInfo } from './report.js';
import { parseScope, type ScopeOption } from './scope.js';
import { KNOWN_ROUTES, createReadService } from './service.js';
import type { Authorize, DynaliticsHandler } from './types.js';

export type { ReadErrorInfo } from './report.js';

// createHandler is a thin composition (docs/SPEC.md 16.1): the lock layer (./lock) decides whether and how a request
// may run, the read service (./service.ts) answers it. The only thing that passes between them is `Grant`.

export interface HandlerOptions {
  /** REQUIRED. The handler refuses to be created, and refuses every request, without it. */
  authorize: Authorize;
  /** '/' or '/segment/...' (one optional trailing slash is dropped). Default '/'. */
  basePath?: string;
  dashboardHtml?: string;
  pii?: {
    /** Allow `?pii=reveal` for requests that `authorize` approved with `revealPii: true`. Default false. */
    reveal?: boolean;
    /** Mask userId unless revealed. Default true. */
    maskUserId?: boolean;
  };
  /**
   * Row scope for a table shared by several sites or tenants: every read statement gets
   * `AND column = <bound value>`. `'none'` acknowledges that the whole table is meant to be read. Omitting it logs a warning.
   */
  scope?: ScopeOption;
  limits?: {
    maxRangeDays?: number;
    maxBuckets?: number;
    topPagesMax?: number;
    recentMax?: number;
    timeoutMs?: number;
    concurrency?: number;
  };
  newVsReturning?: {
    enabled?: boolean;
    source?: 'computed' | 'column';
    ipIdentity?: 'auto' | 'always' | 'never';
    maxRangeDays?: number;
  };
  /** Log explorer (docs/SPEC.md 18). Default enabled, 31-day range cap. */
  explorer?: {
    enabled?: boolean;
    maxRangeDays?: number;
  };
  /**
   * Extended analytics (docs/SPEC.md 21): the country map. Default false. Also needs a custom field declared
   * `geo: 'country'`; without one the widget reports `column_not_mapped`.
   */
  extendedAnalyticsEnabled?: boolean;
  /** Fail closed (500) if authorize() has not settled by then. Default 5000. */
  authorizeTimeoutMs?: number;
  cacheTtlMs?: number;
  onError?: (info: ReadErrorInfo) => void;
}

const optionsRule = obj({
  ...lockOptionRules, // authorize, basePath, authorizeTimeoutMs, dashboardHtml: the lock layer's options
  pii: obj({ reveal: bool, maskUserId: bool }), // reveal: the lock's; maskUserId: the database side's
  scope: custom((v, _path, issues) => void issues.push(...parseScope(v).issues)),
  limits: obj({
    maxRangeDays: int({ min: 1, max: 3650 }),
    maxBuckets: int({ min: 1, max: 5000 }),
    topPagesMax: int({ min: 1, max: 1000 }),
    recentMax: int({ min: 1, max: 1000 }),
    timeoutMs: int({ min: 100, max: 120_000 }),
    concurrency: int({ min: 1, max: 64 }),
  }),
  newVsReturning: obj({
    enabled: bool,
    source: oneOf(['computed', 'column']),
    ipIdentity: oneOf(['auto', 'always', 'never']),
    maxRangeDays: int({ min: 1, max: 3650 }),
  }),
  explorer: obj({ enabled: bool, maxRangeDays: int({ min: 1, max: 3650 }) }),
  extendedAnalyticsEnabled: bool,
  cacheTtlMs: int({ min: 0, max: 600_000 }),
  onError: fn,
});

export function createHandler(dyn: Dynalitics, options: HandlerOptions): DynaliticsHandler {
  const issues = runRule(optionsRule, options, 'options');
  if (issues.length > 0) throw new DynaliticsConfigError(issues);
  const internals = getInternals(dyn);
  if (internals?.reader === undefined) {
    throw new DynaliticsConfigError([
      'createHandler needs a Dynalitics instance with a reader credential: pass connection: { reader } (or { writer, reader }).',
    ]);
  }
  const report = createReporter(options.onError, internals, KNOWN_ROUTES);
  const service = createReadService(
    internals,
    {
      limits: options.limits,
      newVsReturning: options.newVsReturning,
      explorer: options.explorer,
      extendedAnalyticsEnabled: options.extendedAnalyticsEnabled === true,
      scope: options.scope,
      cacheTtlMs: options.cacheTtlMs,
      maskUserId: options.pii?.maskUserId !== false,
    },
    report,
  );
  const lock = createLock(
    {
      authorize: options.authorize,
      basePath: options.basePath ?? '/',
      dashboardHtml: options.dashboardHtml,
      reveal: options.pii?.reveal === true,
      authorizeTimeoutMs: options.authorizeTimeoutMs ?? 5000,
    },
    report,
  );
  return {
    basePath: lock.basePath,
    cacheSize: service.cacheSize,
    handle: (request) =>
      lock.handle(request, (route, grant) => service.run(route, request.query, grant)),
  };
}

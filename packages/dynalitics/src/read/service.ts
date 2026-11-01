import type { Row } from '../dialect/types.js';
import { isDriverError } from '../driver/types.js';
import type { SafeCause } from '../errors.js';
import type { Internals } from '../internals.js';
import type { ErrorCode, MetaData, ResponseMeta, Unavailable } from '../protocol.js';
import { buildDimensions, planNewVsReturning, type NvrOptions } from './capabilities.js';
import { parseParams, type ParamContext, type ParsedParams, type RouteName } from './params.js';
import type { Report } from './report.js';
import * as routes from './routes.js';
import { parseScope, type ScopeOption } from './scope.js';
import { buildSearchFields, facetFields, fieldInfo } from './search/fields.js';
import { QUERY_LIMITS, parseQuery } from './search/parse.js';
import { createSemaphore } from './semaphore.js';
import type { DynaliticsRequest, Grant, ReadOutcome, ReadService } from './types.js';

// The database side of the read handler (docs/SPEC.md 15.1): routes, parameters, queries, aggregation, masking, scope,
// deadlines, cancellation and the micro-cache. It never sees authorize(), headers, cookies, the raw request or basePath:
// everything it knows about the caller is the `Grant`. Moved here from handler.ts with no logic change.

export interface ServiceLimits {
  maxRangeDays?: number;
  maxBuckets?: number;
  topPagesMax?: number;
  recentMax?: number;
  timeoutMs?: number;
  concurrency?: number;
}

export interface ServiceNewVsReturning {
  enabled?: boolean;
  source?: 'computed' | 'column';
  ipIdentity?: 'auto' | 'always' | 'never';
  maxRangeDays?: number;
}

export interface ServiceExplorer {
  /** Default true. When false the /api/search* routes are 404 and meta says `disabled_by_host`. */
  enabled?: boolean;
  /** Default 31, never more than limits.maxRangeDays. */
  maxRangeDays?: number;
}

export interface ServiceOptions {
  readonly limits?: ServiceLimits | undefined;
  readonly explorer?: ServiceExplorer | undefined;
  readonly newVsReturning?: ServiceNewVsReturning | undefined;
  readonly scope?: ScopeOption | undefined;
  readonly cacheTtlMs?: number | undefined;
  /** Mask userId unless revealed. */
  readonly maskUserId: boolean;
}

class ReadError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly cause2?: SafeCause,
  ) {
    super(code);
  }
}

const MAX_CACHE_ENTRIES = 200;
const DEFAULTS = { rangeDays: 7, interval: 'day', topPagesLimit: 10, recentLimit: 25 } as const;
export const NO_SCOPE_WARNING =
  'The read handler has no scope configured: it reads every row of the table. If the table is shared between sites or tenants, pass scope: { column, value } to createHandler; pass scope: "none" to acknowledge that reading everything is intended.';

interface CacheEntry {
  readonly expires: number;
  readonly body: Record<string, unknown>;
}

type Runner = (c: routes.RouteCtx) => Promise<routes.RouteResult<unknown>>;
interface RouteDef {
  readonly name: RouteName;
  readonly run: Runner;
  readonly interval: boolean;
  /** Explorer route: takes `q`, returns 404 when the explorer is disabled. */
  readonly search?: true;
}
const TAIL_MIN_INTERVAL_MS = 5000;
const TABLE = new Map<string, RouteDef>([
  [
    '/api/visits-over-time',
    { name: 'visits-over-time', run: routes.visitsOverTime, interval: true },
  ],
  ['/api/top-pages', { name: 'top-pages', run: routes.topPages, interval: false }],
  [
    '/api/new-vs-returning',
    { name: 'new-vs-returning', run: routes.newVsReturning, interval: true },
  ],
  ['/api/consent-rate', { name: 'consent-rate', run: routes.consentRate, interval: true }],
  ['/api/recent-visits', { name: 'recent-visits', run: routes.recentVisits, interval: false }],
  ['/api/search', { name: 'search', run: routes.search, interval: false, search: true }],
  [
    '/api/search/histogram',
    { name: 'search-histogram', run: routes.searchHistogram, interval: true, search: true },
  ],
  [
    '/api/search/fields',
    { name: 'search-fields', run: routes.searchFields, interval: false, search: true },
  ],
  ['/api/errors', { name: 'errors', run: routes.errors, interval: true }],
]);

/** Every path the handler routes, for the reporter: only these are ever echoed into `onError`. */
export const KNOWN_ROUTES: ReadonlySet<string> = new Set(['/', '/api/meta', ...TABLE.keys()]);

export type ReadServiceHandle = ReadService & {
  /** Number of micro-cache entries (always <= 200). For tests and diagnostics. */
  readonly cacheSize: () => number;
};

export function createReadService(
  internals: Internals,
  options: ServiceOptions,
  report: Report,
): ReadServiceHandle {
  const { reader, dialect, model } = internals;
  if (reader === undefined) throw new Error('createReadService needs a reader'); // createHandler checked this already
  const maskUserIds = options.maskUserId;
  const scope = parseScope(options.scope ?? 'none').entries;
  if (options.scope === undefined) internals.logger.warn(NO_SCOPE_WARNING);
  const limits = {
    maxRangeDays: options.limits?.maxRangeDays ?? 92,
    maxBuckets: options.limits?.maxBuckets ?? 800,
    topPagesMax: options.limits?.topPagesMax ?? 100,
    recentMax: options.limits?.recentMax ?? 100,
    newVsReturningMaxRangeDays: options.newVsReturning?.maxRangeDays ?? 31,
    explorerMaxRangeDays: options.explorer?.maxRangeDays ?? 31,
  };
  const explorerEnabled = options.explorer?.enabled !== false;
  const timeoutMs = options.limits?.timeoutMs ?? 10_000;
  const cacheTtlMs = options.cacheTtlMs ?? 0;
  const nvrOptions: NvrOptions = {
    enabled: options.newVsReturning?.enabled ?? true,
    source: options.newVsReturning?.source ?? 'computed',
    ipIdentity: options.newVsReturning?.ipIdentity ?? 'auto',
  };

  const dimensions = buildDimensions(model);
  const searchFields = buildSearchFields(model);
  const searchable = [...searchFields.values()].filter((f) => f.search);
  const splits = new Set(facetFields(searchFields).map((f) => f.key));
  const plan = planNewVsReturning(model, internals.ipMode, nvrOptions);
  const env = { dialect, model, scope: scope.map((s) => ({ name: s.column, value: s.value })) };
  const semaphore = createSemaphore(options.limits?.concurrency ?? 4);
  const cache = new Map<string, CacheEntry>(); // insertion order = recency (entries are moved on every hit)
  const has = (role: string): boolean => model.columns.some((c) => c.role === role);

  const execFor =
    (route: string) =>
    async (query: Parameters<routes.RouteCtx['exec']>[0]): Promise<readonly Row[]> => {
      const release = await semaphore.acquire(timeoutMs);
      if (release === null) throw new ReadError('unavailable');
      try {
        // The slot is held until the driver has settled, which it only does after the statement was cancelled on the
        // server (or the connection destroyed) at the deadline: a timed-out query cannot keep running unaccounted (F-05).
        return await reader.query(query, { timeoutMs });
      } catch (err) {
        const safe = isDriverError(err) ? err.safeCause : undefined;
        const code: ErrorCode = isDriverError(err)
          ? err.timeout
            ? 'timeout'
            : 'unavailable'
          : 'internal';
        report(route, code, 'a read query failed', safe);
        throw new ReadError(code);
      } finally {
        release();
      }
    };

  const metaData = (revealable: boolean): MetaData => ({
    version: 2,
    now: internals.now().toISOString(),
    intervals: ['hour', 'day', 'week', 'month'],
    limits: {
      maxRangeDays: limits.maxRangeDays,
      maxBuckets: limits.maxBuckets,
      topPagesMax: limits.topPagesMax,
      recentMax: limits.recentMax,
      newVsReturningMaxRangeDays: limits.newVsReturningMaxRangeDays,
    },
    defaults: { ...DEFAULTS },
    breakdowns: [...dimensions.keys()].map((key) => ({ key, label: key })),
    widgets: {
      visitsOverTime: { available: true },
      topPages: { available: true },
      consentRate: { available: true },
      newVsReturning: plan.available
        ? { available: true, source: plan.source, basis: plan.basis, approximate: plan.approximate }
        : { available: false, reason: plan.reason, message: plan.message },
      recentVisits: { available: true },
      errors: has('status')
        ? { available: true }
        : { available: false, ...routes.ERRORS_UNAVAILABLE },
      explorer: explorerEnabled
        ? { available: true }
        : {
            available: false,
            reason: 'disabled_by_host',
            message: 'The log explorer is switched off for this dashboard.',
          },
    },
    ...(explorerEnabled
      ? {
          explorer: {
            fields: fieldInfo(searchFields),
            limits: {
              ...QUERY_LIMITS,
              maxRangeDays: Math.min(limits.explorerMaxRangeDays, limits.maxRangeDays),
              facetTop: routes.FACET_TOP,
              tailMinIntervalMs: TAIL_MIN_INTERVAL_MS,
            },
          },
        }
      : {}),
    fields: {
      id: has('id'),
      ipAddress: has('ip'),
      userId: has('userId'),
      username: has('username'),
      email: has('email'),
      isFirstVisit: plan.available,
      status: has('status'),
      errorReason: has('errorReason'),
    },
    features: { recentVisitsCursor: has('id'), piiRevealable: revealable },
  });

  const paramContext = (): ParamContext => ({
    now: internals.now(),
    limits,
    defaults: DEFAULTS,
    breakdowns: new Set(dimensions.keys()),
    splits,
    hasCursor: has('id'),
  });

  const meta = (
    p: ParsedParams | undefined,
    name: RouteName,
    revealed: boolean,
    interval: boolean,
    cached: boolean,
  ): ResponseMeta => ({
    generatedAt: internals.now().toISOString(),
    ...(p === undefined ? {} : { from: p.from.toISOString(), to: p.to.toISOString() }),
    ...(p !== undefined && interval ? { interval: p.interval } : {}),
    piiMasked: !((name === 'recent-visits' || name === 'search') && revealed),
    cached,
  });

  function remember(key: string, entry: CacheEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  }

  const ok = (body: Record<string, unknown>): ReadOutcome => ({ kind: 'ok', body });
  const failed = (code: ErrorCode, param?: string): ReadOutcome => ({
    kind: 'error',
    code,
    ...(param === undefined ? {} : { param }),
  });

  async function serve(
    path: string,
    query: DynaliticsRequest['query'],
    grant: Grant,
  ): Promise<ReadOutcome> {
    if (path === '/api/meta') {
      const parsed = parseParams('meta', query, paramContext());
      if (!parsed.ok) return failed(parsed.code, parsed.param);
      return ok({
        success: true,
        data: metaData(grant.revealable),
        unavailable: null,
        error: null,
        meta: meta(undefined, 'meta', false, false, false),
      });
    }
    const route = TABLE.get(path);
    if (route === undefined || (route.search === true && !explorerEnabled))
      return failed('not_found');
    const parsed = parseParams(route.name, query, paramContext());
    if (!parsed.ok) return failed(parsed.code, parsed.param);
    let filter: routes.RouteCtx['filter'];
    if (route.search === true) {
      const pq = parseQuery(parsed.params.q, searchFields);
      if (!pq.ok)
        return {
          kind: 'error',
          code: 'invalid_query',
          query: { reason: pq.reason, position: pq.position },
        };
      filter = { clauses: pq.clauses, searchable };
    }
    const revealed = grant.reveal;

    // Principal-independent by construction: the key contains the mask mode and authorize() still ran for this request.
    const key = `${path}?${Object.keys(query)
      .sort()
      .map((k) => `${k}=${String(query[k])}`)
      .join('&')}|${revealed ? 1 : 0}`;
    const hit = cacheTtlMs > 0 ? cache.get(key) : undefined;
    if (hit !== undefined && hit.expires > Date.now()) {
      remember(key, hit);
      return ok({ ...hit.body, meta: { ...(hit.body['meta'] as ResponseMeta), cached: true } });
    }

    const result = await route.run({
      env,
      exec: execFor(path),
      params: parsed.params,
      plan,
      dimensions,
      reveal: revealed,
      maskUserId: maskUserIds,
      report: (message) => report(path, 'internal', message),
      searchFields,
      filter,
    });
    const unavailable: Unavailable | null = 'unavailable' in result ? result.unavailable : null;
    const body = {
      success: true,
      data: 'data' in result ? result.data : null,
      unavailable,
      error: null,
      meta: meta(parsed.params, route.name, revealed, route.interval, false),
    };
    if (cacheTtlMs > 0) remember(key, { expires: Date.now() + cacheTtlMs, body });
    return ok(body);
  }

  return {
    cacheSize: () => cache.size,
    /** Never throws: a failure becomes `{ kind: 'error' }` and, if unexpected, an onError report. */
    async run(route, query, grant) {
      try {
        return await serve(route, query, grant);
      } catch (err) {
        if (err instanceof ReadError) return failed(err.code);
        report(route, 'internal', 'unexpected error in the read handler');
        return failed('internal');
      }
    },
  };
}

import type { Row } from '../dialect/types.js';
import type {
  ConsentRateData,
  ErrorsData,
  Interval,
  NewVsReturningData,
  RecentVisit,
  RecentVisitsData,
  SearchData,
  SearchFieldsData,
  SearchHistogramData,
  TopPagesData,
  Unavailable,
  VisitPoint,
  VisitsOverTimeData,
} from '../protocol.js';
import { bucketStarts } from './buckets.js';
import type { Dimension, NvrPlan } from './capabilities.js';
import { MASKED_CUSTOM, maskEmail, maskIp, maskUserId, maskUsername } from './mask.js';
import { encodeCursor, type ParsedParams } from './params.js';
import * as q from './queries.js';
import { facetFields, type SearchField } from './search/fields.js';

export interface RouteCtx {
  readonly env: q.Env;
  readonly exec: (query: ReturnType<typeof q.visitsSeries>) => Promise<readonly Row[]>;
  readonly params: ParsedParams;
  readonly plan: NvrPlan;
  readonly dimensions: ReadonlyMap<string, Dimension>;
  readonly reveal: boolean;
  /** Mask userId unless revealed (pii.maskUserId, default true). */
  readonly maskUserId: boolean;
  /** Reports an internal inconsistency (never the request, never visitor data). */
  readonly report: (message: string) => void;
  /** Explorer allow-list (spec 18.1). */
  readonly searchFields: ReadonlyMap<string, SearchField>;
  /** Explorer routes only: the parsed `q`. Undefined for every other route. */
  readonly filter?: q.SearchFilter | undefined;
}
export type RouteResult<T> = { readonly data: T } | { readonly unavailable: Unavailable };

/** Text from a driver value; objects (which would stringify as "[object Object]") become ''. */
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean'
      ? String(v)
      : '';
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const iso = (d: Date): string => d.toISOString();
const rate = (granted: number, total: number): number | null =>
  total === 0 ? null : round3(granted / total);

function counts(rows: readonly Row[], key: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(text(r['bucket']), (out.get(text(r['bucket'])) ?? 0) + num(r[key]));
  return out;
}

const buckets = (p: ParsedParams): string[] => bucketStarts(p.from, p.to, p.interval).map(iso);
const sum = (xs: Iterable<number>): number => [...xs].reduce((a, b) => a + b, 0);

export async function visitsOverTime(c: RouteCtx): Promise<RouteResult<VisitsOverTimeData>> {
  const { breakdown } = c.params;
  const dim = breakdown === undefined ? undefined : c.dimensions.get(breakdown);
  return { data: await series(c, dim) };
}

/** Visits per bucket, optionally split by one dimension (10.7). Shared by visits-over-time and the explorer. */
async function series(c: RouteCtx, dim: Dimension | undefined): Promise<VisitsOverTimeData> {
  const { from, to, interval } = c.params;
  const range = { from, to, interval, filter: c.filter };
  const counted = counts(await c.exec(q.visitsSeries(c.env, range)), 'visits');
  const starts = buckets(c.params);
  const points: VisitPoint[] = starts.map((bucket) => ({
    bucket,
    visits: counted.get(bucket) ?? 0,
  }));
  const total = sum(points.map((p) => p.visits));
  const data: VisitsOverTimeData = { interval, points, total };
  if (dim === undefined) return data;

  const values = (await c.exec(q.breakdownTop(c.env, dim, range))).map((r) => text(r['v']));
  const rows = await c.exec(q.breakdownSeries(c.env, dim, range, values));
  const cells = new Map<string, Map<string, number>>(); // value ('' prefix keeps null apart) -> bucket -> n
  const NULL_KEY = '\u0000null';
  for (const r of rows) {
    const key = r['v'] === null || r['v'] === undefined ? NULL_KEY : `v:${text(r['v'])}`;
    const m = cells.get(key) ?? new Map<string, number>();
    m.set(text(r['bucket']), num(r['n']));
    cells.set(key, m);
  }
  const filled = (key: string): VisitPoint[] =>
    starts.map((bucket) => ({ bucket, visits: cells.get(key)?.get(bucket) ?? 0 }));
  const listed = [
    ...values.map((v) => ({ value: v, isOther: false, points: filled(`v:${v}`) })),
    { value: null, isOther: false, points: filled(NULL_KEY) },
  ];
  const other = points.map((p, i) => ({
    bucket: p.bucket,
    visits: Math.max(0, p.visits - sum(listed.map((s) => s.points[i]?.visits ?? 0))),
  }));
  return {
    ...data,
    breakdown: {
      key: dim.key,
      series: [...listed, { value: null, isOther: true, points: other }],
    },
  };
}

export async function topPages(c: RouteCtx): Promise<RouteResult<TopPagesData>> {
  const range = { from: c.params.from, to: c.params.to };
  const total = num((await c.exec(q.topTotal(c.env, range)))[0]?.['n']);
  const rows = await c.exec(q.topPages(c.env, range, c.params.limit));
  const pages = rows.map((r) => ({
    page: text(r['page']),
    visits: num(r['n']),
    share: total === 0 ? 0 : round3(num(r['n']) / total),
  }));
  return {
    data: {
      totalVisits: total,
      pages,
      otherVisits: Math.max(0, total - sum(pages.map((p) => p.visits))),
    },
  };
}

export async function consentRate(c: RouteCtx): Promise<RouteResult<ConsentRateData>> {
  const { from, to, interval } = c.params;
  const rows = await c.exec(q.consentSeries(c.env, { from, to, interval }));
  const granted = counts(rows, 'granted');
  const total = counts(rows, 'total');
  const points = buckets(c.params).map((bucket) => {
    const g = granted.get(bucket) ?? 0;
    const denied = Math.max(0, (total.get(bucket) ?? 0) - g);
    return { bucket, granted: g, denied, rate: rate(g, g + denied) };
  });
  const g = sum(points.map((p) => p.granted));
  const d = sum(points.map((p) => p.denied));
  return { data: { interval, points, totals: { granted: g, denied: d, rate: rate(g, g + d) } } };
}

export async function newVsReturning(c: RouteCtx): Promise<RouteResult<NewVsReturningData>> {
  const plan = c.plan;
  if (!plan.available) return { unavailable: { reason: plan.reason, message: plan.message } };
  const { from, to, interval } = c.params;
  const range = { from, to, interval };
  let inconsistent = false;
  let rows: (bucket: string) => { newCount: number; returning: number; unknown: number };

  if (plan.source === 'column') {
    const r = await c.exec(q.nvrColumn(c.env, range, plan));
    const total = counts(r, 'total');
    const nw = counts(r, 'new_count');
    const rt = counts(r, 'returning_count');
    rows = (b) => {
      const t = total.get(b) ?? 0;
      const n = Math.min(nw.get(b) ?? 0, t);
      const ret = Math.min(rt.get(b) ?? 0, t - n);
      return { newCount: n, returning: ret, unknown: t - n - ret };
    };
  } else {
    const totals = await c.exec(q.nvrTotals(c.env, range, plan));
    const total = counts(totals, 'total');
    const identified = counts(totals, 'identified');
    const fresh = new Map<string, number>();
    for (const kind of ['u', 'i'] as const) {
      if ((kind === 'u' ? plan.user : plan.ip) === undefined) continue;
      for (const [b, n] of counts(await c.exec(q.nvrNew(c.env, range, plan, kind)), 'n'))
        fresh.set(b, (fresh.get(b) ?? 0) + n);
    }
    rows = (b) => {
      const t = total.get(b) ?? 0;
      const id = Math.min(identified.get(b) ?? 0, t);
      // The queries run one after another, so rows may arrive in between. The output is clamped to stay consistent
      // (new + returning + unknown = total) but the discrepancy is REPORTED, never silently hidden (F-38).
      if ((fresh.get(b) ?? 0) > id || (identified.get(b) ?? 0) > t) inconsistent = true;
      const n = Math.min(fresh.get(b) ?? 0, id);
      return { newCount: n, returning: id - n, unknown: t - id };
    };
  }
  const points = buckets(c.params).map((bucket) => {
    const r = rows(bucket);
    return { bucket, new: r.newCount, returning: r.returning, unknown: r.unknown };
  });
  if (inconsistent) {
    c.report(
      'new-vs-returning: more first-time visitors than identified visits in a bucket (rows changed while the request ran?); the result was clamped',
    );
  }
  const totals = {
    new: sum(points.map((p) => p.new)),
    returning: sum(points.map((p) => p.returning)),
    unknown: sum(points.map((p) => p.unknown)),
  };
  return {
    data: {
      interval,
      source: plan.source,
      basis: plan.basis,
      approximate: plan.approximate,
      points,
      totals,
    },
  };
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));

export async function recentVisits(c: RouteCtx): Promise<RouteResult<RecentVisitsData>> {
  return { data: await visitPage(c) };
}

/** One page of visits, newest first, masked as in 10.6. Shared by recent-visits and the explorer. */
async function visitPage(c: RouteCtx): Promise<RecentVisitsData> {
  const { from, to, limit, cursor } = c.params;
  const rows = await c.exec(
    q.recentVisits(c.env, { from, to, limit, cursor, filter: c.filter }, c.plan),
  );
  const page = rows.slice(0, limit);
  const promoted = q.promotedColumns(c.env);
  const fields = [...c.env.model.customFields.values()];
  const idMapped = c.env.model.columns.some((col) => col.role === 'id');
  const hasStatus = c.env.model.columns.some((col) => col.role === 'status');
  const hasReason = c.env.model.columns.some((col) => col.role === 'errorReason');

  const visits: RecentVisit[] = page.map((r) => {
    const json = parseJson(r['custom_v']);
    const out: [string, string | number | boolean | null][] = [];
    for (const f of fields) {
      const promotedAt = promoted.findIndex((p) => p.key === f.key);
      const raw =
        promotedAt >= 0
          ? r[`pf${promotedAt}`]
          : json !== null && Object.hasOwn(json, f.key)
            ? json[f.key]
            : undefined;
      if (raw === undefined) continue;
      const value = raw === null ? null : (raw as string | number | boolean);
      out.push([f.key, f.personal && !c.reveal && value !== null ? MASKED_CUSTOM : value]);
    }
    const userId = textOrNull(r['user_v']);
    const ip = textOrNull(r['ip_v']);
    const email = textOrNull(r['email_v']);
    const name = textOrNull(r['name_v']);
    return {
      id: textOrNull(r['rid']),
      timestamp: text(r['ts_text']),
      pageVisited: text(r['page']),
      consent: num(r['consent_flag']) === 1,
      isFirstVisit:
        r['first_flag'] === null || r['first_flag'] === undefined
          ? null
          : num(r['first_flag']) === 1,
      ipAddress: c.reveal ? ip : maskIp(ip),
      userId: c.reveal || !c.maskUserId ? userId : maskUserId(userId),
      username: c.reveal ? name : maskUsername(name),
      email: c.reveal ? email : maskEmail(email),
      custom: out.length === 0 ? null : Object.fromEntries(out),
      ...(hasStatus
        ? {
            status:
              r['status_v'] === null || r['status_v'] === undefined ? null : num(r['status_v']),
          }
        : {}),
      ...(hasReason ? { errorReason: textOrNull(r['reason_v']) } : {}),
    };
  });
  const last = page[page.length - 1];
  const more = rows.length > limit && idMapped && last !== undefined;
  return {
    visits,
    nextCursor: more ? encodeCursor(new Date(text(last['ts_text'])), text(last['rid'])) : null,
  };
}

// --- explorer (spec 18.3) ------------------------------------------------------------------------------------------

export const FACET_TOP = 5;

const matchedCount = async (c: RouteCtx): Promise<number> =>
  num((await c.exec(q.topTotal(c.env, { ...c.params, filter: c.filter })))[0]?.['n']);

export async function search(c: RouteCtx): Promise<RouteResult<SearchData>> {
  const page = await visitPage(c);
  return { data: { ...page, matched: await matchedCount(c) } };
}

export async function searchHistogram(c: RouteCtx): Promise<RouteResult<SearchHistogramData>> {
  const split = c.params.split === undefined ? undefined : c.searchFields.get(c.params.split);
  return { data: await series(c, split?.dim) };
}

export async function searchFields(c: RouteCtx): Promise<RouteResult<SearchFieldsData>> {
  const matched = await matchedCount(c);
  const range = { from: c.params.from, to: c.params.to, filter: c.filter };
  const fields = [];
  // Sequential on purpose: every statement goes through the shared semaphore and deadline (spec 18.5).
  for (const f of facetFields(c.searchFields)) {
    const rows = await c.exec(q.breakdownTop(c.env, f.dim, range, FACET_TOP));
    const values = rows.map((r) => ({ value: text(r['v']), count: num(r['n']) }));
    const nullCount = num((await c.exec(q.nullCount(c.env, f.dim, range)))[0]?.['n']);
    const listed = sum(values.map((v) => v.count)) + nullCount;
    fields.push({ key: f.key, values, nullCount, otherCount: Math.max(0, matched - listed) });
  }
  return { data: { matched, fields } };
}

// --- errors (spec 20.4) --------------------------------------------------------------------------------------------

export const ERRORS_TOP = 10;
export const ERRORS_UNAVAILABLE: Unavailable = {
  reason: 'column_not_mapped',
  message:
    'Errors need the HTTP status of each visit. Map columns.status (true for the default status_code column) and pass status to track().',
};

const errorCounts = (total: number, c4: number, c5: number) => ({
  total,
  clientErrors: c4,
  serverErrors: c5,
  rate: total === 0 ? null : round3((c4 + c5) / total),
});

export async function errors(c: RouteCtx): Promise<RouteResult<ErrorsData>> {
  if (!c.env.model.columns.some((col) => col.role === 'status'))
    return { unavailable: ERRORS_UNAVAILABLE };
  const { from, to, interval } = c.params;
  const rows = await c.exec(q.errorsSeries(c.env, { from, to, interval }));
  const total = counts(rows, 'total');
  const c4 = counts(rows, 'c4');
  const c5 = counts(rows, 'c5');
  const points = buckets(c.params).map((bucket) => ({
    bucket,
    ...errorCounts(total.get(bucket) ?? 0, c4.get(bucket) ?? 0, c5.get(bucket) ?? 0),
  }));
  const pages = (await c.exec(q.errorPages(c.env, { from, to }, ERRORS_TOP))).map((r) => ({
    page: text(r['page']),
    errors: num(r['n']),
    serverErrors: num(r['c5']),
  }));
  const reasons = (await c.exec(q.errorReasons(c.env, { from, to }, ERRORS_TOP))).map((r) => ({
    reason: textOrNull(r['rsn']),
    status: num(r['st']),
    count: num(r['n']),
  }));
  return {
    data: {
      interval,
      points,
      totals: errorCounts(
        sum(points.map((p) => p.total)),
        sum(points.map((p) => p.clientErrors)),
        sum(points.map((p) => p.serverErrors)),
      ),
      pages,
      reasons,
      reasonsStored: c.env.model.columns.some((col) => col.role === 'errorReason'),
    },
  };
}

export type { Interval };

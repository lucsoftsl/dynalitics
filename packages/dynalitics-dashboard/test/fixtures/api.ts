import type {
  ApiResponse,
  BreakdownSeries,
  ConsentRateData,
  CountriesData,
  ErrorsData,
  Interval,
  MetaData,
  NewVsReturningData,
  RecentVisit,
  RecentVisitsData,
  SearchData,
  SearchFieldsData,
  SearchHistogramData,
  ResponseMeta,
  TopPagesData,
  VisitsOverTimeData,
} from '../../src/protocol.js';
import { WORLD_MAP } from '../../../dynalitics/src/read/geo/world-map.js';

/** Typed mock of the read-handler contract (docs/SPEC.md section 10, v0.2). */
export const NOW = '2026-10-30T12:05:00.000Z';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Scenario =
  | 'ok'
  | 'empty'
  | 'forbidden'
  | 'unreachable'
  | 'timeout'
  | 'slow'
  | 'html-reply'
  | 'nvr-unavailable'
  | 'nvr-exact'
  | 'sparse-fields'
  | 'no-cursor'
  | 'meta-forbidden'
  | 'hostile'
  | 'ramp'
  | 'explorer-off'
  | 'errors'
  | 'countries'
  | 'countries-no-explorer';

export interface MockReply {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  /** Server never answers (preview) / fetch rejects (tests). */
  readonly drop?: boolean;
  readonly delayMs?: number;
}

function metaOf(piiMasked: boolean, extra: Partial<ResponseMeta> = {}): ResponseMeta {
  return { generatedAt: NOW, piiMasked, cached: false, ...extra };
}

export function makeMeta(scenario: Scenario): MetaData {
  const ok = { available: true } as const;
  const nvrOff = scenario === 'nvr-unavailable';
  const outcome = scenario === 'errors';
  const geo = scenario === 'countries' || scenario === 'countries-no-explorer';
  const noExplorer = scenario === 'explorer-off' || scenario === 'countries-no-explorer';
  return {
    version: 2,
    now: NOW,
    intervals: ['hour', 'day', 'week', 'month'],
    limits: {
      maxRangeDays: 92,
      maxBuckets: 800,
      topPagesMax: 100,
      recentMax: 100,
      newVsReturningMaxRangeDays: 31,
    },
    defaults: { rangeDays: 7, interval: 'day', topPagesLimit: 10, recentLimit: 25 },
    breakdowns: [
      { key: 'consent', label: 'consent' },
      ...(outcome ? [{ key: 'statusClass', label: 'statusClass' }] : []),
      { key: 'plan', label: 'plan' },
    ],
    widgets: {
      visitsOverTime: ok,
      topPages: ok,
      consentRate: ok,
      newVsReturning: nvrOff
        ? {
            available: false,
            reason: 'identity_not_reliable',
            message:
              'New vs returning needs a user id or a non-truncated IP address, and neither is available.',
          }
        : {
            available: true,
            source: 'computed',
            basis: scenario === 'nvr-exact' ? 'user_id' : 'user_id_then_ip',
            approximate: scenario !== 'nvr-exact',
          },
      recentVisits: ok,
      ...(outcome ? { errors: ok } : {}),
      ...(geo ? { countryMap: ok } : {}),
      explorer: noExplorer
        ? {
            available: false,
            reason: 'disabled_by_host',
            message: 'The log explorer is switched off for this dashboard.',
          }
        : ok,
    },
    ...(geo ? { countryMap: { field: 'country' } } : {}),
    ...(noExplorer
      ? {}
      : {
          explorer: {
            fields: [
              { key: 'page', type: 'text' as const, search: true, facet: true },
              { key: 'consent', type: 'boolean' as const, search: false, facet: true },
              ...(outcome
                ? [
                    { key: 'statusClass', type: 'text' as const, search: false, facet: true },
                    { key: 'status', type: 'number' as const, search: false, facet: true },
                    { key: 'errorReason', type: 'text' as const, search: true, facet: true },
                  ]
                : []),
              { key: 'plan', type: 'text' as const, search: true, facet: true },
              ...(geo
                ? [{ key: 'country', type: 'text' as const, search: true, facet: true }]
                : []),
              { key: 'amount', type: 'number' as const, search: false, facet: false },
            ],
            limits: {
              maxQueryChars: 512,
              maxClauses: 12,
              maxValueChars: 128,
              maxRangeDays: 31,
              facetTop: 5,
              tailMinIntervalMs: 5000,
            },
          },
        }),
    fields: {
      id: scenario !== 'no-cursor',
      ipAddress: scenario !== 'sparse-fields',
      userId: true,
      username: scenario !== 'sparse-fields',
      email: false,
      isFirstVisit: !nvrOff,
      ...(outcome ? { status: true, errorReason: true } : {}),
    },
    features: {
      recentVisitsCursor: scenario !== 'no-cursor',
      piiRevealable: scenario === 'ok' || scenario === 'hostile',
    },
  };
}

const STEP: Record<Interval, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 31 * DAY };

/** Bucket starts covering [from, to), UTC-aligned like the server (weeks start Monday). */
export function bucketStarts(fromMs: number, toMs: number, interval: Interval): number[] {
  const step = STEP[interval];
  let start = Math.floor(fromMs / step) * step;
  if (interval === 'week') start -= ((new Date(start).getUTCDay() + 6) % 7) * DAY;
  const out: number[] = [];
  for (let t = start; t < toMs; t += step) out.push(t);
  return out;
}

function wave(i: number, base: number, amp: number): number {
  return Math.max(3, Math.round(base + amp * Math.sin(i * 1.3 + 1) + ((i * 37) % 11)));
}

interface Counts {
  readonly bucket: string;
  readonly visits: number;
  readonly granted: number;
  readonly denied: number;
  readonly newV: number;
  readonly returning: number;
  readonly unknown: number;
}

export function countsFor(
  fromMs: number,
  toMs: number,
  interval: Interval,
  empty: boolean,
  ramp = false,
): Counts[] {
  const base = interval === 'hour' ? 40 : interval === 'day' ? 380 : 2900;
  return bucketStarts(fromMs, toMs, interval).map((t, i, all) => {
    const raw = empty
      ? 0
      : ramp
        ? Math.round(base * 0.05 + (i * i * base) / (all.length * all.length))
        : wave(i, base, base * 0.2);
    const visits = i === all.length - 1 && !empty ? Math.round(raw * 0.4) : raw;
    const granted = Math.round(visits * 0.82);
    const denied = visits - granted;
    const unknown = denied + Math.round(granted * 0.05);
    const known = visits - unknown;
    const newV = Math.round(known * 0.34);
    return {
      bucket: new Date(t).toISOString(),
      visits,
      granted,
      denied,
      newV,
      returning: known - newV,
      unknown,
    };
  });
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

const PAGES: readonly [string, number][] = [
  ['/pricing', 31],
  ['/', 28],
  ['/docs/getting-started', 12],
  ['/blog/why-we-log-to-your-own-database', 8],
  ['/login', 6],
  ['/search?q=<img src=x onerror=alert(1)>', 4],
  ['/account/settings/notifications/email-preferences/unsubscribe/confirm', 3],
  ['/changelog', 2],
];

export const HOSTILE_PAGES: readonly string[] = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  'javascript:alert(document.domain)',
  '/‮evil/gpj.exe',
  '/' + 'a'.repeat(5000),
  '\u0000‮⁦mixed⁩ bidi',
  '&lt;b&gt;already-escaped&lt;/b&gt; &amp;',
  "'; DROP TABLE visits;--",
];

const OUTCOMES: readonly [number, string | null][] = [
  [200, null],
  [200, null],
  [404, null],
  [200, null],
  [503, 'ECONNREFUSED'],
  [301, null],
  [500, 'TypeError'],
  [422, 'validation.failed'],
];

function visitRows(hostile: boolean, outcome = false): RecentVisit[] {
  const rows: RecentVisit[] = [];
  const hostileText = (i: number) => HOSTILE_PAGES[i % HOSTILE_PAGES.length] as string;
  for (let i = 0; i < 60; i++) {
    const consent = i % 4 !== 1;
    const page = hostile ? hostileText(i) : (PAGES[i % PAGES.length]?.[0] as string);
    rows.push({
      id: String(18231 - i),
      timestamp: new Date(Date.parse(NOW) - 4 * 60_000 - i * 97_000).toISOString(),
      pageVisited: page,
      consent,
      isFirstVisit: !consent ? null : i % 3 === 0 ? true : i % 5 === 0 ? null : false,
      ipAddress: !consent ? null : i % 6 === 0 ? null : '203.0.x.x',
      userId: !consent || i % 2 ? null : `u_***${40 + i}`,
      username: !consent || i % 2 ? null : hostile ? hostileText(i + 1) : 'j***',
      email: null,
      custom: null,
      ...(outcome
        ? {
            status: i % 9 === 8 ? null : (OUTCOMES[i % OUTCOMES.length]?.[0] ?? 200),
            errorReason: i % 9 === 8 ? null : (OUTCOMES[i % OUTCOMES.length]?.[1] ?? null),
          }
        : {}),
    });
  }
  return rows;
}

const REVEALED: Readonly<Record<string, string>> = { '203.0.x.x': '203.0.113.77', 'j***': 'jane' };
const unmaskUserId = (id: string): string => id.replace('***', '');

function reveal(rows: readonly RecentVisit[]): RecentVisit[] {
  return rows.map((r) => ({
    ...r,
    ipAddress: r.ipAddress ? (REVEALED[r.ipAddress] ?? r.ipAddress) : null,
    username: r.username ? (REVEALED[r.username] ?? r.username) : null,
    userId: r.userId ? unmaskUserId(r.userId) : null,
  }));
}

const PLAN_WEIGHTS: readonly [string | null, boolean, number][] = [
  ['pro', false, 30],
  ['free', false, 25],
  ['team', false, 15],
  ['edu', false, 10],
  ['enterprise', false, 8],
  ['hobby', false, 5],
  [null, false, 4],
  [null, true, 3],
];

/** Deterministic split of each bucket's visits; rounding remainder goes to the last series. */
export function breakdownFor(
  key: string,
  counts: readonly Counts[],
): { key: string; series: BreakdownSeries[] } {
  const spec: readonly [string | null, boolean, number][] =
    key === 'consent'
      ? [
          ['true', false, 82],
          ['false', false, 18],
        ]
      : key === 'statusClass'
        ? [
            ['2xx', false, 88],
            ['4xx', false, 6],
            ['3xx', false, 3],
            ['5xx', false, 2],
            [null, false, 1],
          ]
        : PLAN_WEIGHTS;
  const total = spec.reduce((a, [, , w]) => a + w, 0);
  const series = spec.map(([value, isOther, weight]): BreakdownSeries => ({
    value,
    isOther,
    points: counts.map((c) => ({
      bucket: c.bucket,
      visits: Math.floor((c.visits * weight) / total),
    })),
  }));
  const last = series[series.length - 1]!;
  const fixed = [...series];
  fixed[fixed.length - 1] = {
    ...last,
    points: last.points.map((p, i) => ({
      bucket: p.bucket,
      visits: p.visits + (counts[i]!.visits - series.reduce((a, s) => a + s.points[i]!.visits, 0)),
    })),
  };
  return { key, series: fixed };
}

/** Deterministic: ~6% 4xx and ~2% 5xx of each bucket, one 5xx spike, fixed pages and reasons. */
export function errorsFor(counts: readonly Counts[], interval: Interval): ErrorsData {
  const points = counts.map((c, i) => {
    const total = c.visits;
    const clientErrors = Math.floor(total * 0.06);
    const serverErrors = Math.floor(total * (i === counts.length - 2 ? 0.12 : 0.02));
    const failed = clientErrors + serverErrors;
    return {
      bucket: c.bucket,
      total,
      clientErrors,
      serverErrors,
      rate: total === 0 ? null : Math.round((failed / total) * 1000) / 1000,
    };
  });
  const total = sum(points.map((p) => p.total));
  const c4 = sum(points.map((p) => p.clientErrors));
  const c5 = sum(points.map((p) => p.serverErrors));
  return {
    interval,
    points,
    totals: {
      total,
      clientErrors: c4,
      serverErrors: c5,
      rate: total === 0 ? null : Math.round(((c4 + c5) / total) * 1000) / 1000,
    },
    pages:
      total === 0
        ? []
        : [
            { page: '/checkout', errors: 41, serverErrors: 29 },
            { page: '/api/cart', errors: 22, serverErrors: 6 },
            { page: '/wp-login.php', errors: 17, serverErrors: 0 },
          ],
    reasons:
      total === 0
        ? []
        : [
            { reason: null, status: 404, count: 31 },
            { reason: 'ECONNREFUSED', status: 503, count: 24 },
            { reason: 'validation.failed', status: 422, count: 9 },
            { reason: 'TypeError', status: 500, count: 7 },
          ],
    reasonsStored: true,
  };
}

function envelope<T>(data: T, meta: ResponseMeta): ApiResponse<T> {
  return { success: true, data, unavailable: null, error: null, meta };
}

function failure(
  status: number,
  code: 'forbidden' | 'timeout' | 'internal' | 'unavailable' | 'range_too_large' | 'not_found',
  param?: string,
): MockReply {
  return {
    status,
    body: {
      success: false,
      data: null,
      unavailable: null,
      error: { code, message: 'x', ...(param ? { param } : {}) },
    },
  };
}

function window_(q: URLSearchParams): { from: number; to: number; interval: Interval } {
  return {
    from: Date.parse(q.get('from') ?? NOW),
    to: Date.parse(q.get('to') ?? NOW),
    interval: (q.get('interval') ?? 'day') as Interval,
  };
}

/** Pure mock of the five routes + meta. `path` is the part after `/api/`. */
/** Visits by country (SPEC 21.2): a fixed mix scaled to the range's total. */
export function countriesFor(counts: readonly Counts[], empty: boolean): CountriesData {
  const total = empty ? 0 : counts.reduce((a, c) => a + c.visits, 0);
  const mix: [string, number][] = [
    ['ES', 0.42],
    ['US', 0.18],
    ['DE', 0.09],
    ['GB', 0.07],
    ['FR', 0.05],
    ['HU', 0.04],
    ['BR', 0.03],
    ['JP', 0.02],
    ['SG', 0.02],
    ['AU', 0.01],
  ];
  const countries = mix
    .map(([code, share]) => ({ code, visits: Math.round(total * share) }))
    .filter((c) => c.visits > 0);
  const known = countries.reduce((a, c) => a + c.visits, 0);
  return { total, countries, unknown: Math.max(0, total - known) };
}

export function mockReply(scenario: Scenario, path: string, q: URLSearchParams): MockReply {
  if (scenario === 'unreachable') return { status: 0, drop: true };
  if (scenario === 'html-reply')
    return { status: 200, text: '<!doctype html><title>Sign in</title>' };
  if (scenario === 'meta-forbidden' || (scenario === 'forbidden' && path === 'meta'))
    return failure(403, 'forbidden');
  const empty = scenario === 'empty';
  const delayMs = scenario === 'slow' ? 1500 : 0;
  const withDelay = (r: MockReply): MockReply => ({ ...r, delayMs });
  if (path === 'meta') return { status: 200, body: envelope(makeMeta(scenario), metaOf(true)) };
  if (scenario === 'forbidden') return failure(403, 'forbidden');
  if (scenario === 'timeout' && path !== 'top-pages') return failure(504, 'timeout');
  const hostile = scenario === 'hostile';
  const w = window_(q);
  const counts = countsFor(w.from, w.to, w.interval, empty, scenario === 'ramp');
  switch (path) {
    case 'visits-over-time': {
      const breakdownKey = q.get('breakdown');
      const data: VisitsOverTimeData = {
        interval: w.interval,
        points: counts.map((c) => ({ bucket: c.bucket, visits: c.visits })),
        total: sum(counts.map((c) => c.visits)),
        ...(breakdownKey ? { breakdown: breakdownFor(breakdownKey, counts) } : {}),
      };
      return withDelay({
        status: 200,
        body: envelope(data, metaOf(true, { interval: w.interval })),
      });
    }
    case 'top-pages': {
      const limit = Number(q.get('limit') ?? 10);
      const pool = hostile ? HOSTILE_PAGES.map((p, i): [string, number] => [p, 20 - i]) : PAGES;
      const rows = empty ? [] : pool.slice(0, limit);
      const total = empty ? 0 : 800;
      const weights = sum(pool.map(([, n]) => n));
      const pages = rows.map(([page, n]) => ({
        page,
        visits: Math.round((n / weights) * total),
        share: Math.round((n / weights) * 1000) / 1000,
      }));
      const data: TopPagesData = {
        totalVisits: total,
        pages,
        otherVisits: empty ? 0 : total - sum(pages.map((p) => p.visits)),
      };
      return withDelay({ status: 200, body: envelope(data, metaOf(true)) });
    }
    case 'new-vs-returning': {
      if (scenario === 'nvr-unavailable') {
        return {
          status: 200,
          body: {
            success: true,
            data: null,
            error: null,
            unavailable: {
              reason: 'identity_not_reliable',
              message: makeMeta(scenario).widgets.newVsReturning.available
                ? ''
                : (makeMeta(scenario).widgets.newVsReturning as { message: string }).message,
            },
            meta: metaOf(true),
          },
        };
      }
      const span = (w.to - w.from) / DAY;
      if (span > 31.01) return failure(400, 'range_too_large', 'from');
      const points = counts.map((c) => ({
        bucket: c.bucket,
        new: c.newV,
        returning: c.returning,
        unknown: c.unknown,
      }));
      const data: NewVsReturningData = {
        interval: w.interval,
        source: 'computed',
        basis: scenario === 'nvr-exact' ? 'user_id' : 'user_id_then_ip',
        approximate: scenario !== 'nvr-exact',
        points,
        totals: {
          new: sum(points.map((p) => p.new)),
          returning: sum(points.map((p) => p.returning)),
          unknown: sum(points.map((p) => p.unknown)),
        },
      };
      return withDelay({ status: 200, body: envelope(data, metaOf(true)) });
    }
    case 'consent-rate': {
      const points = counts.map((c) => ({
        bucket: c.bucket,
        granted: c.granted,
        denied: c.denied,
        rate: c.visits === 0 ? null : Math.round((c.granted / c.visits) * 1000) / 1000,
      }));
      const g = sum(points.map((p) => p.granted));
      const d = sum(points.map((p) => p.denied));
      const data: ConsentRateData = {
        interval: w.interval,
        points,
        totals: {
          granted: g,
          denied: d,
          rate: g + d === 0 ? null : Math.round((g / (g + d)) * 1000) / 1000,
        },
      };
      return withDelay({ status: 200, body: envelope(data, metaOf(true)) });
    }
    case 'recent-visits': {
      const limit = Number(q.get('limit') ?? 25);
      const revealed = q.get('pii') === 'reveal' && makeMeta(scenario).features.piiRevealable;
      const all = empty ? [] : visitRows(hostile, scenario === 'errors');
      const start = Number(/^p(\d+)$/.exec(q.get('cursor') ?? '')?.[1] ?? 0);
      const page = all.slice(start, start + limit);
      const more = scenario !== 'no-cursor' && start + limit < all.length;
      const data: RecentVisitsData = {
        visits: revealed ? reveal(page) : page,
        nextCursor: more ? `p${start + limit}` : null,
      };
      return withDelay({ status: 200, body: envelope(data, metaOf(!revealed)) });
    }
    case 'errors':
      if (scenario !== 'errors') return failure(500, 'internal');
      return withDelay({
        status: 200,
        body: envelope(errorsFor(counts, w.interval), metaOf(true, { interval: w.interval })),
      });
    case 'countries':
      if (makeMeta(scenario).countryMap === undefined) return failure(404, 'not_found');
      return withDelay({ status: 200, body: envelope(countriesFor(counts, empty), metaOf(true)) });
    case 'world-map':
      if (makeMeta(scenario).countryMap === undefined) return failure(404, 'not_found');
      return withDelay({ status: 200, body: envelope(WORLD_MAP, metaOf(true)) });
    case 'search':
    case 'search/histogram':
    case 'search/fields':
      return withDelay(searchReply(path, q, w, counts, hostile, empty));
    default:
      return failure(500, 'internal');
  }
}

/** A tiny model of SPEC 18: `q` is matched as a lower-case substring of the page; `zzz` matches nothing. */
function searchReply(
  path: string,
  q: URLSearchParams,
  w: ReturnType<typeof window_>,
  counts: ReturnType<typeof countsFor>,
  hostile: boolean,
  empty: boolean,
): MockReply {
  const text = (q.get('q') ?? '').trim();
  if ((w.to - w.from) / DAY > 31.01) return failure(400, 'range_too_large', 'from');
  if (/(^|\s)-?(email|ip|campaign):/.test(text)) {
    return {
      status: 400,
      body: {
        success: false,
        data: null,
        unavailable: null,
        error: {
          code: 'invalid_query',
          message: 'Unknown field, or a field that cannot be searched.',
          reason: 'unknown_field',
          position: Math.max(0, text.search(/(email|ip|campaign):/) - (text.includes('-') ? 1 : 0)),
        },
      },
    };
  }
  const words = text
    .split(/\s+/)
    .filter((t) => t && !t.includes(':'))
    .map((t) => t.toLowerCase());
  const none = empty || words.includes('zzz');
  const all = none
    ? []
    : visitRows(hostile).filter((v) => words.every((t) => v.pageVisited.toLowerCase().includes(t)));
  const share = visitRows(hostile).length === 0 ? 0 : all.length / visitRows(hostile).length;
  const scaled = counts.map((c) => ({ ...c, visits: none ? 0 : Math.round(c.visits * share) }));
  const matched = sum(scaled.map((c) => c.visits));
  if (path === 'search/histogram') {
    const split = q.get('split');
    const data: SearchHistogramData = {
      interval: w.interval,
      points: scaled.map((c) => ({ bucket: c.bucket, visits: c.visits })),
      total: matched,
      ...(split ? { breakdown: breakdownFor(split, scaled) } : {}),
    };
    return { status: 200, body: envelope(data, metaOf(true, { interval: w.interval })) };
  }
  if (path === 'search/fields') {
    const pages = new Map<string, number>();
    for (const v of all) pages.set(v.pageVisited, (pages.get(v.pageVisited) ?? 0) + 1);
    const top = [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const granted = all.filter((v) => v.consent).length;
    const data: SearchFieldsData = {
      matched: all.length,
      fields: [
        {
          key: 'page',
          values: top.map(([value, count]) => ({ value, count })),
          nullCount: 0,
          otherCount: all.length - sum(top.map(([, n]) => n)),
        },
        {
          key: 'consent',
          values: [
            { value: 'true', count: granted },
            { value: 'false', count: all.length - granted },
          ].filter((v) => v.count > 0),
          nullCount: 0,
          otherCount: 0,
        },
        {
          key: 'plan',
          values: none ? [] : [{ value: 'pro', count: 3 }],
          nullCount: all.length > 3 ? all.length - 3 : 0,
          otherCount: 0,
        },
      ],
    };
    return { status: 200, body: envelope(data, metaOf(true)) };
  }
  const limit = Number(q.get('limit') ?? 25);
  const start = Number(/^p(\d+)$/.exec(q.get('cursor') ?? '')?.[1] ?? 0);
  const data: SearchData = {
    visits: all.slice(start, start + limit),
    nextCursor: start + limit < all.length ? `p${start + limit}` : null,
    matched: all.length,
  };
  return { status: 200, body: envelope(data, metaOf(true)) };
}

/** A `fetch` that answers from the mock; rejects like a network failure when the scenario drops. */
export function mockFetch(
  scenario: Scenario,
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = new URL(input, 'http://dyn.test');
    const path = url.pathname.replace(/^.*\/api\//, '');
    const reply = mockReply(scenario, path, url.searchParams);
    if (reply.drop) return Promise.reject(new TypeError('Failed to fetch'));
    if (init?.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const body = reply.text ?? JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(body, {
        status: reply.status,
        headers: { 'content-type': reply.text ? 'text/html' : 'application/json' },
      }),
    );
  };
}

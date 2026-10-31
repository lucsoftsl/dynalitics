// Wire types of the dynalitics read API (docs/SPEC.md section 10, v0.2). Types only.
// This file is a vendored copy of packages/dynalitics/src/protocol.ts; the dashboard must not
// depend on the server package. `npm run check:protocol -w dynalitics-dashboard` diffs the two.

export type Interval = 'hour' | 'day' | 'week' | 'month';

export type ErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_parameter'
  | 'range_too_large'
  | 'timeout'
  | 'unavailable'
  | 'internal';

export type UnavailableReason =
  'no_identity_column' | 'identity_not_reliable' | 'disabled_by_host' | 'column_not_mapped';

export interface Unavailable {
  reason: UnavailableReason;
  message: string;
}

export interface ResponseMeta {
  generatedAt: string;
  from?: string;
  to?: string;
  interval?: Interval;
  piiMasked: boolean;
  cached: boolean;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  param?: string;
}

export type ApiResponse<T> =
  | { success: true; data: T; unavailable: null; error: null; meta: ResponseMeta }
  | { success: true; data: null; unavailable: Unavailable; error: null; meta: ResponseMeta }
  | { success: false; data: null; unavailable: null; error: ApiErrorBody };

export type WidgetAvailability =
  { available: true } | { available: false; reason: UnavailableReason; message: string };

export type NewVsReturningSource = 'computed' | 'column';
export type NewVsReturningBasis = 'user_id' | 'ip' | 'user_id_then_ip';

export type NewVsReturningAvailability =
  | {
      available: true;
      source: NewVsReturningSource;
      basis: NewVsReturningBasis;
      approximate: boolean;
    }
  | { available: false; reason: UnavailableReason; message: string };

export interface Breakdown {
  key: string;
  label: string;
}

export interface MetaData {
  version: 2;
  now: string;
  intervals: readonly Interval[];
  limits: {
    maxRangeDays: number;
    maxBuckets: number;
    topPagesMax: number;
    recentMax: number;
    newVsReturningMaxRangeDays: number;
  };
  defaults: { rangeDays: number; interval: Interval; topPagesLimit: number; recentLimit: number };
  breakdowns: readonly Breakdown[];
  widgets: {
    visitsOverTime: WidgetAvailability;
    topPages: WidgetAvailability;
    consentRate: WidgetAvailability;
    newVsReturning: NewVsReturningAvailability;
    recentVisits: WidgetAvailability;
  };
  fields: {
    id: boolean;
    ipAddress: boolean;
    userId: boolean;
    username: boolean;
    email: boolean;
    isFirstVisit: boolean;
  };
  features: { recentVisitsCursor: boolean; piiRevealable: boolean };
}

export interface VisitPoint {
  bucket: string;
  visits: number;
}

export interface BreakdownSeries {
  value: string | null;
  isOther: boolean;
  points: readonly VisitPoint[];
}

export interface VisitsOverTimeData {
  interval: Interval;
  points: readonly VisitPoint[];
  total: number;
  breakdown?: { key: string; series: readonly BreakdownSeries[] };
}

export interface TopPage {
  page: string;
  visits: number;
  share: number;
}

export interface TopPagesData {
  totalVisits: number;
  pages: readonly TopPage[];
  otherVisits: number;
}

export interface NewVsReturningCounts {
  new: number;
  returning: number;
  unknown: number;
}

export interface NewVsReturningData {
  interval: Interval;
  source: NewVsReturningSource;
  basis: NewVsReturningBasis;
  approximate: boolean;
  points: readonly (NewVsReturningCounts & { bucket: string })[];
  totals: NewVsReturningCounts;
}

export interface ConsentCounts {
  granted: number;
  denied: number;
  rate: number | null;
}

export interface ConsentRateData {
  interval: Interval;
  points: readonly (ConsentCounts & { bucket: string })[];
  totals: ConsentCounts;
}

export interface RecentVisit {
  id: string | null;
  timestamp: string;
  pageVisited: string;
  consent: boolean;
  isFirstVisit: boolean | null;
  ipAddress: string | null;
  userId: string | null;
  username: string | null;
  email: string | null;
  custom: Readonly<Record<string, string | number | boolean | null>> | null;
}

export interface RecentVisitsData {
  visits: readonly RecentVisit[];
  nextCursor: string | null;
}

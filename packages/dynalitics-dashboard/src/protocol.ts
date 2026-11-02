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
  | 'invalid_query'
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

/** Why an explorer query was refused (spec 18.4). The message for each is a fixed sentence. */
export type QueryErrorReason =
  | 'too_long'
  | 'too_many_clauses'
  | 'unbalanced_quote'
  | 'empty_value'
  | 'value_too_long'
  | 'unknown_field'
  | 'bad_value';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  param?: string;
  /** Only for `invalid_query`. */
  reason?: QueryErrorReason;
  /** Only for `invalid_query`: 0-based character offset in `q`. */
  position?: number;
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
    /** v0.6. Absent from older servers: treat a missing key as unavailable. */
    explorer?: WidgetAvailability;
    /** v0.8 (spec 20). Absent from older servers: treat a missing key as unavailable. */
    errors?: WidgetAvailability;
    /** v0.9 (spec 21). Absent from older servers: treat a missing key as unavailable. */
    countryMap?: WidgetAvailability;
  };
  /** v0.6 (spec 18.1). Absent when the explorer is disabled or the server predates it. */
  explorer?: ExplorerMeta;
  /** v0.9 (spec 21.1). Present only while the country map is available: the custom field holding the code. */
  countryMap?: { field: string };
  fields: {
    id: boolean;
    ipAddress: boolean;
    userId: boolean;
    username: boolean;
    email: boolean;
    isFirstVisit: boolean;
    /** v0.8. Absent from older servers: false. */
    status?: boolean;
    errorReason?: boolean;
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
  /** v0.8: the HTTP status, null when not stored. Absent from older servers. */
  status?: number | null;
  /** v0.8: the error code, null when not stored. Absent from older servers. */
  errorReason?: string | null;
}

export interface RecentVisitsData {
  visits: readonly RecentVisit[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors (spec section 20, v0.8)
// ---------------------------------------------------------------------------------------------------------------------

/** Only rows with a stored status count: `total` is responses with a status, not visits. */
export interface ErrorCounts {
  total: number;
  /** 4xx */
  clientErrors: number;
  /** 5xx */
  serverErrors: number;
  /** (4xx + 5xx) / total, 3 decimals; null when total is 0. */
  rate: number | null;
}

export interface ErrorPage {
  page: string;
  /** 4xx + 5xx */
  errors: number;
  serverErrors: number;
}

export interface ErrorReasonCount {
  /** null: the error had no stored reason. */
  reason: string | null;
  status: number;
  count: number;
}

export interface ErrorsData {
  interval: Interval;
  points: readonly (ErrorCounts & { bucket: string })[];
  totals: ErrorCounts;
  pages: readonly ErrorPage[];
  reasons: readonly ErrorReasonCount[];
  /** False when no errorReason column is mapped: every reason is then null. */
  reasonsStored: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Log explorer (spec section 18, v0.6)
// ---------------------------------------------------------------------------------------------------------------------

export type SearchFieldType = 'text' | 'boolean' | 'number';

export interface SearchFieldInfo {
  key: string;
  type: SearchFieldType;
  /** Bare terms (no `key:`) match this field. */
  search: boolean;
  /** Shown in the field sidebar and usable as `split`. */
  facet: boolean;
}

export interface ExplorerMeta {
  fields: readonly SearchFieldInfo[];
  limits: {
    maxQueryChars: number;
    maxClauses: number;
    maxValueChars: number;
    maxRangeDays: number;
    facetTop: number;
    tailMinIntervalMs: number;
  };
}

export interface SearchData {
  visits: readonly RecentVisit[];
  nextCursor: string | null;
  matched: number;
}

/** Same shape as visits-over-time; `breakdown` holds the split series when `split` was given. */
export type SearchHistogramData = VisitsOverTimeData;

export interface FacetValue {
  value: string;
  count: number;
}

export interface FieldFacet {
  key: string;
  values: readonly FacetValue[];
  nullCount: number;
  otherCount: number;
}

export interface SearchFieldsData {
  matched: number;
  fields: readonly FieldFacet[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Country map (spec section 21, v0.9)
// ---------------------------------------------------------------------------------------------------------------------

export interface CountryVisits {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string;
  visits: number;
}

export interface CountriesData {
  total: number;
  /** Most visits first, then code. */
  countries: readonly CountryVisits[];
  /** Visits without a usable country code. */
  unknown: number;
}

export interface CountryShape {
  code: string;
  /** SVG path data: only M, l, z and integers. */
  d: string;
}

export interface WorldMapData {
  width: number;
  height: number;
  countries: readonly CountryShape[];
}

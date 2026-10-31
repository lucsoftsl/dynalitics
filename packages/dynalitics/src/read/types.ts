import type { ErrorCode } from '../protocol.js';

export interface DynaliticsRequest {
  /** Upper-case. */
  readonly method: string;
  /** Relative to basePath, starts with '/', no query string. */
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  /** Lower-case names. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The original request object (Express req, Fetch Request...), for authorize(). */
  readonly raw: unknown;
}

export interface DynaliticsResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DynaliticsHandler {
  /** Normalised: '' for the root, otherwise '/segment/...' without a trailing slash. */
  readonly basePath: string;
  /** Number of micro-cache entries (always <= 200). For tests and diagnostics. */
  readonly cacheSize?: () => number;
  handle(req: DynaliticsRequest): Promise<DynaliticsResponse>;
}

export type AuthResult = boolean | { allowed: boolean; revealPii?: boolean };
export type Authorize = (req: DynaliticsRequest) => AuthResult | Promise<AuthResult>;

// ---------------------------------------------------------------------------------------------------------------------
// The seam between the lock layer (src/read/lock) and the database side (src/read/service.ts), docs/SPEC.md 15.1.
// The lock decides WHETHER and HOW a request may run; the service decides WHAT it returns. They meet at `run`.
// ---------------------------------------------------------------------------------------------------------------------

/** Built by the lock layer after authorize() has said yes. Everything the database side may know about the caller. */
export interface Grant {
  /** True only if: `pii.reveal` option AND authorize `revealPii === true` AND `?pii=reveal`. Drives masking and the cache key. */
  readonly reveal: boolean;
  /**
   * True if the first two of those hold, i.e. this caller MAY ask for personal data. Reported to the UI as
   * `features.piiRevealable` by /api/meta, which carries no `?pii`. (SPEC 15.1 lists only `reveal`; see the report.)
   */
  readonly revealable: boolean;
}

export type ReadOutcome =
  /** `body` is an ApiResponse envelope (protocol.ts), JSON-serialisable; the lock sends it as HTTP 200. */
  | { readonly kind: 'ok'; readonly body: Readonly<Record<string, unknown>> }
  /** Never carries text from the driver. `param` names the offending query parameter for `invalid_parameter`. */
  | { readonly kind: 'error'; readonly code: ErrorCode; readonly param?: string };

/** Database side. Never sees authorize(), headers, cookies, the raw request or basePath. Never throws. */
export interface ReadService {
  /** `route` is canonical and already routed ('/api/meta', '/api/top-pages', ...). `query` is untouched. */
  run(route: string, query: DynaliticsRequest['query'], grant: Grant): Promise<ReadOutcome>;
}

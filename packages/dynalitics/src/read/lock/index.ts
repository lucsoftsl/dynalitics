import type { ErrorCode } from '../../protocol.js';
import { errorResponse, json } from '../http.js';
import type {
  Authorize,
  DynaliticsRequest,
  DynaliticsResponse,
  Grant,
  ReadOutcome,
} from '../types.js';
import { authorizeWithDeadline } from './authorize.js';
import { normalizeBasePath } from './base-path.js';
import { gate } from './gate.js';
import { htmlResponse } from './serve-html.js';

/**
 * The lock layer (docs/SPEC.md 15, 16). It decides whether and how a request may run and never sees SQL. The database
 * side is reached through one callback, `next(route, grant)`, and ONLY after a strict authorize() success, a GET, and a
 * canonical path. This module must not import the service, queries, drivers or the database (a test enforces it).
 */
export interface LockOptions {
  /** REQUIRED. Read strictly: only `true` or `{ allowed: true }` grants. */
  readonly authorize: Authorize;
  /** '/' or '/segment/...'; validated by the caller (options rule) and normalised here. */
  readonly basePath: string;
  readonly dashboardHtml: string | undefined;
  /** The `pii.reveal` option. */
  readonly reveal: boolean;
  /** authorize() has this long to settle, then the request is refused with 500. */
  readonly authorizeTimeoutMs: number;
}

/** Reports a failure of the lock itself. The route is whatever the host's reporter chooses to echo; no request data. */
export type LockReport = (
  route: string,
  code: Extract<ErrorCode, 'internal'> | 'authorize_invalid_result',
  message: string,
) => void;

export type Next = (route: string, grant: Grant) => Promise<ReadOutcome>;

export interface Lock {
  /** Normalised: '' for the root, otherwise '/segment/...' without a trailing slash. */
  readonly basePath: string;
  handle(request: DynaliticsRequest, next: Next): Promise<DynaliticsResponse>;
}

export function createLock(options: LockOptions, report: LockReport): Lock {
  const basePath = normalizeBasePath(options.basePath);
  const cfg = { revealOption: options.reveal };

  return {
    basePath,
    async handle(request, next) {
      const outcome = await authorizeWithDeadline(
        options.authorize,
        request,
        options.authorizeTimeoutMs,
      );
      if (outcome.kind === 'failed') {
        report(request.path, 'internal', 'authorize() threw or timed out; the request was refused');
        return errorResponse('internal');
      }
      const { auth } = outcome;
      if (auth.invalid) {
        report(
          request.path,
          'authorize_invalid_result',
          'authorize() returned something other than true, false or { allowed: boolean }; the request was refused',
        );
        return errorResponse('forbidden');
      }
      if (!auth.allowed) return errorResponse('forbidden');

      const decision = gate(request, auth, cfg);
      if (decision.kind === 'refuse') return errorResponse(decision.code);
      if (decision.kind === 'page') {
        return options.dashboardHtml === undefined
          ? errorResponse('not_found')
          : htmlResponse(options.dashboardHtml, basePath);
      }
      try {
        const result = await next(decision.route, decision.grant);
        return result.kind === 'ok'
          ? json(200, result.body)
          : errorResponse(result.code, result.param, result.query);
      } catch {
        // The service promises never to throw. If it does anyway, the request fails closed.
        report(request.path, 'internal', 'unexpected error in the read handler');
        return errorResponse('internal');
      }
    },
  };
}

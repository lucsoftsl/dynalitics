import type { ErrorCode } from '../../protocol.js';
import type { DynaliticsRequest, Grant } from '../types.js';
import type { Auth } from './authorize.js';
import { CANONICAL_PATH } from './base-path.js';

export interface GateConfig {
  /** The `pii.reveal` option. */
  readonly revealOption: boolean;
}

export type Decision =
  | { readonly kind: 'refuse'; readonly code: ErrorCode }
  /** GET '/': the dashboard page (the caller answers 404 when no page was supplied). */
  | { readonly kind: 'page' }
  | { readonly kind: 'run'; readonly route: string; readonly grant: Grant };

/**
 * The reveal conditions, computed once, here: `pii.reveal` option AND authorize `revealPii === true` AND `?pii=reveal`.
 * `?pii` is only read for equality; the service still validates it strictly and answers 400 for anything else.
 */
export function computeGrant(
  auth: Auth,
  query: DynaliticsRequest['query'],
  cfg: GateConfig,
): Grant {
  const revealable = cfg.revealOption && auth.revealPii;
  return { revealable, reveal: revealable && query['pii'] === 'reveal' };
}

/**
 * Called only for a request authorize() allowed. Order matters and is part of the contract: method, then canonical
 * path (F-17), then the page, and only then a route is handed to the database side.
 */
export function gate(request: DynaliticsRequest, auth: Auth, cfg: GateConfig): Decision {
  if (request.method !== 'GET') return { kind: 'refuse', code: 'method_not_allowed' };
  // Exact matching on canonical paths only: '//', '..', '%', ';', trailing slashes and the like never route.
  if (!CANONICAL_PATH.test(request.path)) return { kind: 'refuse', code: 'not_found' };
  if (request.path === '/') return { kind: 'page' };
  return { kind: 'run', route: request.path, grant: computeGrant(auth, request.query, cfg) };
}

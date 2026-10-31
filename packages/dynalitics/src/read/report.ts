import type { SafeCause } from '../errors.js';
import type { Internals } from '../internals.js';
import type { ErrorCode } from '../protocol.js';
import { ERROR_STATUS } from './http.js';

/**
 * What the handler reports to `onError` (F-40): the route, the HTTP status it answered with, a code, a fixed message and
 * a sanitised cause. Never the request, its headers or the query string, so logging it cannot leak cookies or tokens.
 */
export interface ReadErrorInfo {
  route: string;
  status: number;
  code: ErrorCode | 'authorize_invalid_result';
  message: string;
  cause?: SafeCause;
}

export type Report = (
  route: string,
  code: ReadErrorInfo['code'],
  message: string,
  cause?: SafeCause,
) => void;

/**
 * Shared by both layers. The route is only echoed for known routes, so a hostile path can never reach the log. The
 * host's `onError` is called inside a try/catch: a throwing callback must never break the handler.
 */
export function createReporter(
  onError: ((info: ReadErrorInfo) => void) | undefined,
  internals: Pick<Internals, 'report'>,
  knownRoutes: ReadonlySet<string>,
): Report {
  return (route, code, message, cause) => {
    const status = code === 'authorize_invalid_result' ? 403 : ERROR_STATUS[code];
    const info: ReadErrorInfo = {
      route: knownRoutes.has(route) ? route : '(other)',
      status,
      code,
      message,
      ...(cause === undefined ? {} : { cause }),
    };
    try {
      if (onError !== undefined) onError(info);
      else {
        internals.report({
          code: code === 'authorize_invalid_result' ? 'authorize_invalid_result' : 'internal',
          message: `${info.route}: ${message}`,
          ...(cause === undefined ? {} : { cause }),
        });
      }
    } catch {
      // the host's callback must never break the handler
    }
  };
}

import type { ErrorCode, QueryErrorReason } from '../protocol.js';
import type { DynaliticsResponse } from './types.js';

/** Sent on every response, JSON and HTML alike. */
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_parameter: 400,
  range_too_large: 400,
  invalid_query: 400,
  timeout: 504,
  unavailable: 503,
  internal: 500,
};

/** Fixed, generic sentences. Never SQL, driver text, table names or connection details. */
const ERROR_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  forbidden: 'Not authorised.',
  not_found: 'Unknown route.',
  method_not_allowed: 'Only GET is supported.',
  invalid_parameter: 'Invalid parameter.',
  range_too_large: 'The requested time range is too large.',
  invalid_query: 'Invalid query.',
  timeout: 'The query took too long. Narrow the time range.',
  unavailable: 'The analytics database is not available right now.',
  internal: 'Internal error.',
};

export function json(
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): DynaliticsResponse {
  return {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
    body: JSON.stringify(body),
  };
}

/** Spec 18.4: one fixed sentence per reason. The query text itself is never echoed. */
export const QUERY_ERROR_MESSAGE: Readonly<Record<QueryErrorReason, string>> = {
  too_long: 'The query is longer than 512 characters.',
  too_many_clauses: 'The query has more than 12 parts.',
  unbalanced_quote: 'A quote is not closed.',
  empty_value: 'A field or term has no value.',
  value_too_long: 'A value is longer than 128 characters.',
  unknown_field: 'Unknown field, or a field that cannot be searched.',
  bad_value: "The value does not fit the field's type.",
};

export interface QueryErrorDetail {
  readonly reason: QueryErrorReason;
  readonly position: number;
}

export function errorResponse(
  code: ErrorCode,
  param?: string,
  query?: QueryErrorDetail,
): DynaliticsResponse {
  const message =
    query !== undefined
      ? QUERY_ERROR_MESSAGE[query.reason]
      : param === undefined
        ? ERROR_MESSAGE[code]
        : `${ERROR_MESSAGE[code]} (${param})`;
  return json(
    ERROR_STATUS[code],
    {
      success: false,
      data: null,
      unavailable: null,
      error: {
        code,
        message,
        ...(param === undefined ? {} : { param }),
        ...(query === undefined ? {} : { reason: query.reason, position: query.position }),
      },
    },
    code === 'method_not_allowed' ? { Allow: 'GET' } : {},
  );
}

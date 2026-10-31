import type { ErrorCode, ResponseMeta, Unavailable } from '../protocol.js';

/** Why a request failed, already mapped to the buckets of docs/DESIGN.md section 8.3. */
export type FailureKind =
  | 'forbidden'
  | 'unexpected'
  | 'unreachable'
  | 'timeout'
  | 'busy'
  | 'bad_request'
  | 'not_found'
  | 'server';

export interface Failure {
  readonly kind: FailureKind;
  readonly status: number;
  readonly code?: ErrorCode;
  readonly param?: string;
}

export type ApiResult<T> =
  | { readonly kind: 'data'; readonly data: T; readonly meta: ResponseMeta }
  | { readonly kind: 'unavailable'; readonly unavailable: Unavailable; readonly meta: ResponseMeta }
  | { readonly kind: 'error'; readonly failure: Failure }
  | { readonly kind: 'aborted' };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface Api {
  get<T>(
    path: string,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<ApiResult<T>>;
}

const BASE_PATTERN = /^\/[A-Za-z0-9/_-]*$/;

/** Same-origin path prefix only (docs/SPEC.md 10.8); anything else becomes the page root. */
export function normalizeBase(raw: string | null | undefined): string {
  if (!raw || !BASE_PATTERN.test(raw)) return '';
  return raw.replace(/\/+$/, '');
}

const SERVER_CODES: Partial<Record<ErrorCode, FailureKind>> = {
  forbidden: 'forbidden',
  not_found: 'not_found',
  timeout: 'timeout',
  unavailable: 'busy',
  range_too_large: 'bad_request',
  invalid_parameter: 'bad_request',
  method_not_allowed: 'unexpected',
};

function failureFromStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'bad_request';
  if (status === 503) return 'busy';
  if (status === 504) return 'timeout';
  return status >= 500 ? 'server' : 'unexpected';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(kind: FailureKind, status: number, extra?: Partial<Failure>): ApiResult<never> {
  return { kind: 'error', failure: { kind, status, ...extra } };
}

export function interpretEnvelope<T>(status: number, body: unknown): ApiResult<T> {
  if (!isRecord(body) || typeof body['success'] !== 'boolean') {
    return fail(status === 401 || status === 403 ? 'forbidden' : 'unexpected', status);
  }
  if (body['success'] === false) {
    const err = isRecord(body['error']) ? body['error'] : {};
    const code = typeof err['code'] === 'string' ? (err['code'] as ErrorCode) : undefined;
    const kind = (code && SERVER_CODES[code]) || failureFromStatus(status);
    const param = typeof err['param'] === 'string' ? err['param'] : undefined;
    return fail(kind, status, {
      ...(code ? { code } : {}),
      ...(param ? { param } : {}),
    });
  }
  const meta = isRecord(body['meta']) ? (body['meta'] as unknown as ResponseMeta) : null;
  if (!meta) return fail('unexpected', status);
  const un = body['unavailable'];
  if (isRecord(un) && typeof un['reason'] === 'string' && typeof un['message'] === 'string') {
    return { kind: 'unavailable', unavailable: un as unknown as Unavailable, meta };
  }
  if (isRecord(body['data'])) return { kind: 'data', data: body['data'] as T, meta };
  return fail('unexpected', status);
}

export function createApi(base: string, fetchFn: FetchFn): Api {
  return {
    async get<T>(path: string, params: Readonly<Record<string, string>>, signal?: AbortSignal) {
      const query = new URLSearchParams(params).toString();
      const url = `${base}/api/${path}${query ? `?${query}` : ''}`;
      let response: Response;
      try {
        response = await fetchFn(url, {
          credentials: 'same-origin',
          redirect: 'manual',
          headers: { accept: 'application/json' },
          ...(signal ? { signal } : {}),
        });
      } catch {
        return signal?.aborted ? { kind: 'aborted' } : fail('unreachable', 0);
      }
      if (signal?.aborted) return { kind: 'aborted' };
      // An API route never redirects: a redirect means a login page, SSO or a proxy in front of it.
      if (response.redirected || response.type === 'opaqueredirect')
        return fail('unexpected', response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return signal?.aborted
          ? { kind: 'aborted' }
          : fail(
              failureFromStatus(response.status) === 'forbidden' ? 'forbidden' : 'unexpected',
              response.status,
            );
      }
      if (signal?.aborted) return { kind: 'aborted' };
      return interpretEnvelope<T>(response.status, body);
    },
  };
}

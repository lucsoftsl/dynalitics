import type { ApiResult, Failure } from './api.js';
import type { Unavailable } from '../protocol.js';

/** Per-panel state machine (docs/DESIGN.md section 8). Pure: every function returns a new state. */
export type PanelStatus = 'loading' | 'ready' | 'empty' | 'unavailable' | 'error';

export interface PanelState<T> {
  readonly status: PanelStatus;
  readonly reqId: number;
  readonly refreshing: boolean;
  readonly data: T | null;
  readonly generatedAt: string | null;
  readonly unavailable: Unavailable | null;
  readonly failure: Failure | null;
  /** A refresh failed but older data is still shown. */
  readonly staleFailure: Failure | null;
}

export function initialState<T>(): PanelState<T> {
  return {
    status: 'loading',
    reqId: 0,
    refreshing: false,
    data: null,
    generatedAt: null,
    unavailable: null,
    failure: null,
    staleFailure: null,
  };
}

const hasData = (s: PanelState<unknown>): boolean => s.status === 'ready' || s.status === 'empty';

export function begin<T>(state: PanelState<T>): PanelState<T> {
  const reqId = state.reqId + 1;
  if (hasData(state)) return { ...state, reqId, refreshing: true };
  return { ...initialState<T>(), reqId };
}

export function resolve<T>(
  state: PanelState<T>,
  reqId: number,
  result: ApiResult<T>,
  isEmpty: (data: T) => boolean,
): PanelState<T> {
  if (reqId !== state.reqId || result.kind === 'aborted') return state;
  switch (result.kind) {
    case 'data':
      return {
        ...initialState<T>(),
        status: isEmpty(result.data) ? 'empty' : 'ready',
        reqId,
        data: result.data,
        generatedAt: result.meta.generatedAt,
      };
    case 'unavailable':
      return {
        ...initialState<T>(),
        status: 'unavailable',
        reqId,
        unavailable: result.unavailable,
      };
    case 'error':
      if (hasData(state)) return { ...state, refreshing: false, staleFailure: result.failure };
      return { ...initialState<T>(), status: 'error', reqId, failure: result.failure };
  }
}

/** Replace the data of a settled panel (load more, reveal toggle) without a new request. */
export function withData<T>(
  state: PanelState<T>,
  data: T,
  isEmpty: (data: T) => boolean,
): PanelState<T> {
  return { ...state, status: isEmpty(data) ? 'empty' : 'ready', data, staleFailure: null };
}

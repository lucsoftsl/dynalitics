import type { ApiResult, Failure } from '../api.js';
import type { Ctx } from '../context.js';
import type { PanelApi } from '../panel.js';
import type { Window } from '../ranges.js';
import type { ANY_VALUE, ExplorerState, Zoom } from './state.js';

/** What the explorer panels may ask of the explorer view (docs/DESIGN.md 14). */
export interface ExplorerHost {
  readonly state: () => ExplorerState;
  readonly window: (ctx: Ctx) => Window | null;
  readonly onQueryError: (failure: Failure) => void;
  readonly onMatched: (matched: number) => void;
  readonly zoom: (zoom: Zoom) => void;
  readonly addClause: (key: string, value: string | typeof ANY_VALUE, negate: boolean) => void;
  /** True while the current load was started by the live tail, not by the user. */
  readonly isTailTick: () => boolean;
  /** Counts a request in flight (the tail never overlaps one); call the returned function when it settles. */
  readonly begin: () => () => void;
  /** Server time of a successful response, for the masthead's "Updated". */
  readonly onData: (generatedAt: string) => void;
  /** Any other failure of an explorer request (the tail stops on it). */
  readonly onFailure: (failure: Failure) => void;
}

/**
 * GET an explorer route with `q` and the explorer window. A query the server refuses (`invalid_query`) is shown
 * under the query bar, and the panel keeps what it had (docs/DESIGN.md 14.3) instead of turning into an error.
 */
export async function explorerGet<T>(
  ctx: Ctx,
  x: ExplorerHost,
  path: string,
  signal: AbortSignal,
  panel: PanelApi<T>,
  extra: (w: Window) => Readonly<Record<string, string>> = () => ({}),
): Promise<ApiResult<T>> {
  const w = x.window(ctx);
  if (!w) return { kind: 'error', failure: { kind: 'unexpected', status: 0 } };
  const { q } = x.state();
  const done = x.begin();
  let result: ApiResult<T>;
  try {
    result = await ctx.api.get<T>(
      path,
      { from: w.from, to: w.to, ...(q ? { q } : {}), ...extra(w) },
      signal,
    );
  } finally {
    done();
  }
  if (result.kind === 'data') x.onData(result.meta.generatedAt);
  if (result.kind !== 'error') return result;
  if (result.failure.code !== 'invalid_query') {
    x.onFailure(result.failure);
    return result;
  }
  x.onQueryError(result.failure);
  const before = panel.getState();
  if (before.data === null) return result;
  return {
    kind: 'data',
    data: before.data,
    meta: { generatedAt: before.generatedAt ?? ctx.meta.now, piiMasked: true, cached: false },
  };
}

import type { Unavailable, WidgetAvailability, NewVsReturningAvailability } from '../protocol.js';
import type { ApiResult } from './api.js';
import type { Ctx } from './context.js';
import { windowFor, type Window } from './ranges.js';

export function unavailableOf(
  w: WidgetAvailability | NewVsReturningAvailability,
): Unavailable | null {
  return w.available ? null : { reason: w.reason, message: w.message };
}

/** Builds the query from the current range (server clock) and issues the GET. */
export function requestWindow<T>(
  ctx: Ctx,
  path: string,
  signal: AbortSignal,
  params: (w: Window) => Readonly<Record<string, string>>,
  capDays?: number,
): Promise<ApiResult<T>> {
  const win = windowFor(ctx.range, ctx.meta.now, capDays);
  if (!win) return Promise.resolve({ kind: 'error', failure: { kind: 'unexpected', status: 0 } });
  return ctx.api.get<T>(path, params(win), signal);
}

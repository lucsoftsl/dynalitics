import { useCallback, useEffect, useRef, useState } from 'react';
import type { Unavailable } from '../protocol.js';
import type { ApiResult, Failure } from '../ui/api.js';
import type { Ctx } from '../ui/context.js';
import type { RangeKey } from '../ui/ranges.js';
import { begin, initialState, resolve, withData, type PanelState } from '../ui/state.js';
import { useInternal } from './internal-context.js';

const SKELETON_DELAY_MS = 200;
const RETRY_COOLDOWN_MS = 2000;

export interface PanelConfig<T> {
  readonly title: string;
  /** Set when /api/meta says the widget is off: no request is made. */
  readonly availability: (ctx: Ctx) => Unavailable | null;
  readonly request: (ctx: Ctx, signal: AbortSignal) => Promise<ApiResult<T>>;
  readonly isEmpty: (data: T) => boolean;
  readonly summary: (data: T, ctx: Ctx) => string;
  /** Changes when the widget's own request parameters change (split, page size, reveal). */
  readonly requestKey: string;
}

export interface PanelController<T> {
  readonly state: PanelState<T>;
  readonly ctx: Ctx | null;
  readonly skeletonShown: boolean;
  readonly errorRole: 'alert' | 'status';
  readonly cooldownLeftMs: number;
  readonly live: string;
  readonly busy: boolean;
  readonly reloadPage: () => void;
  readonly setRange: (key: RangeKey) => void;
  /** The latest state, for async callbacks that must not act on a stale closure. */
  readonly getState: () => PanelState<T>;
  readonly load: () => void;
  readonly retry: () => void;
  /** Replace the data without a new request (load more). */
  readonly patch: (data: T) => void;
  readonly say: (text: string) => void;
}

/** Per-panel state machine (docs/DESIGN.md section 8) on top of src/ui/state.ts. */
export function usePanel<T>(config: PanelConfig<T>): PanelController<T> {
  const dyn = useInternal();
  const { ctx, loadToken } = dyn;
  const configRef = useRef(config);
  configRef.current = config;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [state, setState] = useState<PanelState<T>>(() => initialState<T>());
  const stateRef = useRef(state);
  const commit = useCallback((next: PanelState<T>) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const [skeletonShown, setSkeletonShown] = useState(false);
  const [errorRole, setErrorRole] = useState<'alert' | 'status'>('status');
  const [live, setLive] = useState('');
  const [retryAt, setRetryAt] = useState(Number.NEGATIVE_INFINITY);
  const [, forceTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { claimErrorRole } = dyn;

  const settle = useCallback(
    (id: number, result: ApiResult<T>, forCtx: Ctx) => {
      const cfg = configRef.current;
      const next = resolve(stateRef.current, id, result, cfg.isEmpty);
      if (next === stateRef.current) return;
      const failedNow = next.status === 'error' && stateRef.current.status !== 'error';
      commit(next);
      if (failedNow) setErrorRole(claimErrorRole());
      clearTimeout(skeletonTimer.current);
      if (next.status === 'ready' && next.data) setLive(cfg.summary(next.data, forCtx));
      else if (next.status === 'error') setLive(`${cfg.title} failed to load.`);
    },
    [commit, claimErrorRole],
  );

  const load = useCallback(() => {
    const c = ctxRef.current;
    if (!c) return;
    abortRef.current?.abort();
    clearTimeout(skeletonTimer.current);
    const cfg = configRef.current;
    const unavailable = cfg.availability(c);
    if (unavailable) {
      commit({
        ...initialState<T>(),
        status: 'unavailable',
        reqId: stateRef.current.reqId + 1,
        unavailable,
      });
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    commit(begin(stateRef.current));
    setSkeletonShown(false);
    skeletonTimer.current = setTimeout(() => {
      setSkeletonShown(true);
      if (stateRef.current.status === 'loading') setLive(`Loading ${cfg.title}`);
    }, SKELETON_DELAY_MS);
    const id = stateRef.current.reqId;
    void cfg.request(c, abort.signal).then((result) => settle(id, result, c));
  }, [commit, settle]);

  useEffect(() => {
    if (!ctx) return;
    load();
    return () => {
      abortRef.current?.abort();
      clearTimeout(skeletonTimer.current);
    };
  }, [ctx, loadToken, config.requestKey, load]);

  // A failed /api/meta is the page's failure; a lone widget shows it in its own slot.
  const metaFailure: Failure | null = dyn.status === 'error' ? dyn.failure : null;
  useEffect(() => {
    if (metaFailure) setErrorRole(claimErrorRole());
  }, [metaFailure, claimErrorRole]);
  const effective: PanelState<T> = metaFailure
    ? { ...initialState<T>(), status: 'error', failure: metaFailure }
    : state;

  const cooldownLeftMs =
    effective.status === 'error' ? Math.max(0, RETRY_COOLDOWN_MS - (Date.now() - retryAt)) : 0;
  useEffect(() => {
    if (effective.status !== 'error' || cooldownLeftMs <= 0) return;
    const timer = setTimeout(() => forceTick((n) => n + 1), cooldownLeftMs);
    return () => clearTimeout(timer);
  }, [effective.status, cooldownLeftMs, retryAt]);

  const retry = useCallback(() => {
    setRetryAt(Date.now());
    if (ctxRef.current) load();
    else dyn.refresh();
  }, [load, dyn]);

  return {
    state: effective,
    ctx,
    skeletonShown,
    errorRole,
    cooldownLeftMs,
    live,
    busy: effective.status === 'loading' || effective.refreshing,
    reloadPage: dyn.reloadPage,
    setRange: (key) => dyn.setRange(key),
    getState: () => stateRef.current,
    load,
    retry,
    patch: (data) => commit(withData(stateRef.current, data, configRef.current.isEmpty)),
    say: setLive,
  };
}

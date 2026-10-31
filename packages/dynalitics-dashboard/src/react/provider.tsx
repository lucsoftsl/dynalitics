import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { MetaData } from '../protocol.js';
import { createApi, type Failure, type FetchFn } from '../ui/api.js';
import type { Ctx } from '../ui/context.js';
import { createFormatters, parseInstant } from '../ui/format.js';
import { parseMeta } from '../ui/meta.js';
import {
  initialRange,
  offeredRanges,
  rangeByKey,
  type RangeDef,
  type RangeKey,
} from '../ui/ranges.js';
import { cx } from './css-vars.js';
import { safeEndpoint } from './endpoint.js';
import { Defs } from './defs.js';
import { DynaliticsContext, type InternalValue } from './internal-context.js';
import { withRequestInit } from './request-init.js';
import type { MetaStatus, ProviderProps } from './types.js';
import { useTheme } from './use-theme.js';

interface Core {
  readonly status: MetaStatus;
  readonly ctx: Ctx | null;
  readonly failure: Failure | null;
  readonly loadToken: number;
}

const INITIAL: Core = { status: 'loading', ctx: null, failure: null, loadToken: 0 };

function chooseRange(meta: MetaData, wanted: RangeKey | null): RangeDef | undefined {
  const fallback = rangeByKey(initialRange(meta, ''));
  if (wanted && offeredRanges(meta).some((r) => r.key === wanted)) return rangeByKey(wanted);
  return fallback;
}

export function DynaliticsProvider(props: ProviderProps): ReactElement {
  const {
    endpoint = '',
    getRequestInit,
    fetch: fetchProp,
    locale,
    defaultRange,
    onRangeChange,
    reloadPage,
    theme: themeSetting = 'system',
    className,
    children,
  } = props;
  const base = safeEndpoint(endpoint);
  const fmt = useMemo(() => createFormatters(locale), [locale]);
  const theme = useTheme(themeSetting);

  // Latest props without re-creating the api (inline arrow props are common).
  const latest = useRef({ getRequestInit, fetchProp, onRangeChange, reloadPage, defaultRange });
  latest.current = { getRequestInit, fetchProp, onRangeChange, reloadPage, defaultRange };

  const api = useMemo(() => {
    const raw: FetchFn = (input, init) => (latest.current.fetchProp ?? fetch)(input, init);
    return createApi(
      base,
      withRequestInit(raw, () => latest.current.getRequestInit),
    );
  }, [base]);

  const [core, setCore] = useState<Core>(INITIAL);
  const coreRef = useRef(core);
  coreRef.current = core;
  const [selected, setSelected] = useState<RangeKey | null>(null);
  const selectedRef = useRef<RangeKey | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const errorShown = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const result = await api.get<unknown>('meta', {}, abort.signal);
      if (abort.signal.aborted || result.kind === 'aborted') return;
      const meta = result.kind === 'data' ? parseMeta(result.data) : null;
      const prev = coreRef.current;
      if (!meta) {
        // Keep the old meta when we have one: panels reload and report their own failures.
        if (prev.ctx) setCore({ ...prev, loadToken: prev.loadToken + 1 });
        else
          setCore({
            status: 'error',
            ctx: null,
            failure: result.kind === 'error' ? result.failure : { kind: 'unexpected', status: 0 },
            loadToken: prev.loadToken + 1,
          });
        return;
      }
      const wanted = prev.ctx ? selectedRef.current : (latest.current.defaultRange ?? null);
      const range = chooseRange(meta, wanted);
      if (!range) return;
      selectedRef.current = range.key;
      setSelected(range.key);
      setCore({
        status: 'ready',
        ctx: { api, fmt, meta, range },
        failure: null,
        loadToken: prev.loadToken + 1,
      });
    })();
    return () => abort.abort();
  }, [api, fmt, refreshToken]);

  const setRange = useCallback((key: RangeKey) => {
    if (!coreRef.current.ctx || selectedRef.current === key) return;
    selectedRef.current = key;
    setSelected(key);
    latest.current.onRangeChange?.(key);
    setRefreshToken((t) => t + 1);
  }, []);
  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);
  const touchUpdated = useCallback((iso: string) => {
    const t = parseInstant(iso);
    if (!Number.isNaN(t)) setUpdatedAt(t);
  }, []);
  const claimErrorRole = useCallback((): 'alert' | 'status' => {
    const role = errorShown.current ? 'status' : 'alert';
    errorShown.current = true;
    return role;
  }, []);
  const reload = useCallback(() => {
    const custom = latest.current.reloadPage;
    if (custom) custom();
    else location.reload();
  }, []);

  const ranges = useMemo(() => (core.ctx ? offeredRanges(core.ctx.meta) : []), [core.ctx]);
  const value = useMemo<InternalValue>(
    () => ({
      status: core.status,
      ctx: core.ctx,
      failure: core.failure,
      fmt,
      ranges,
      rangeKey: selected,
      setRange,
      refresh,
      loadToken: core.loadToken,
      updatedAt,
      touchUpdated,
      claimErrorRole,
      reloadPage: reload,
      theme,
    }),
    [
      core,
      fmt,
      ranges,
      selected,
      setRange,
      refresh,
      updatedAt,
      touchUpdated,
      claimErrorRole,
      reload,
      theme,
    ],
  );

  return (
    <DynaliticsContext.Provider value={value}>
      <div className={cx('dy-root', className)} data-theme={theme.attr}>
        <Defs />
        {children}
      </div>
    </DynaliticsContext.Provider>
  );
}

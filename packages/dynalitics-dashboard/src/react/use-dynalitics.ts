import { useInternal } from './internal-context.js';
import type { MetaStatus, RangeKey } from './types.js';

/** What a custom layout may read and do. Panels use richer internals that are not part of the API. */
export interface DynaliticsState {
  /** `error` means /api/meta could not be read (not authorised, unreachable, unexpected reply). */
  readonly status: MetaStatus;
  /** The selected range, once the server has answered. */
  readonly range: RangeKey | null;
  /** The ranges the server allows. */
  readonly ranges: readonly RangeKey[];
  readonly setRange: (range: RangeKey) => void;
  /** Re-read /api/meta and reload every widget. */
  readonly refresh: () => void;
  /** Milliseconds since the epoch of the last successful visits response, or null. */
  readonly updatedAt: number | null;
  readonly isDark: boolean;
}

export function useDynalitics(): DynaliticsState {
  const v = useInternal();
  return {
    status: v.status,
    range: v.rangeKey,
    ranges: v.ranges.map((r) => r.key),
    setRange: v.setRange,
    refresh: v.refresh,
    updatedAt: v.updatedAt,
    isDark: v.theme.isDark,
  };
}

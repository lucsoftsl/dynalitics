import { createContext, useContext } from 'react';
import type { Failure } from '../ui/api.js';
import type { Ctx } from '../ui/context.js';
import type { Formatters } from '../ui/format.js';
import type { RangeDef, RangeKey } from '../ui/ranges.js';
import type { MetaStatus } from './types.js';
import type { ThemeState } from './use-theme.js';

// Internal: panels read the checked /api/meta and the shared request context from here. It is not part of
// the public API (its types come from src/ui, which is bundled into dist/react/index.js, not shipped as files).

export interface InternalValue {
  readonly status: MetaStatus;
  /** Present once /api/meta has been read and checked. */
  readonly ctx: Ctx | null;
  /** The meta failure when `status` is `error`. */
  readonly failure: Failure | null;
  readonly fmt: Formatters;
  readonly ranges: readonly RangeDef[];
  /** The range shown in the control (panels follow once the next /api/meta has arrived). */
  readonly rangeKey: RangeKey | null;
  readonly setRange: (key: RangeKey) => void;
  /** Re-reads /api/meta, then every panel reloads. */
  readonly refresh: () => void;
  /** Changes whenever panels must (re)load. */
  readonly loadToken: number;
  readonly updatedAt: number | null;
  readonly touchUpdated: (generatedAt: string) => void;
  /** First error on a page is `alert`, later ones `status` (docs/DESIGN.md 8.3). */
  readonly claimErrorRole: () => 'alert' | 'status';
  readonly reloadPage: () => void;
  readonly theme: ThemeState;
}

export const DynaliticsContext = createContext<InternalValue | null>(null);

export function useInternal(): InternalValue {
  const value = useContext(DynaliticsContext);
  if (!value)
    throw new Error('dynalitics: this component must be rendered inside <DynaliticsProvider>');
  return value;
}

import type { Api } from './api.js';
import type { Formatters } from './format.js';
import type { MetaData } from '../protocol.js';
import type { RangeDef } from './ranges.js';

/** Immutable snapshot the panels read from; a new one is made when meta or the range changes. */
export interface Ctx {
  readonly api: Api;
  readonly fmt: Formatters;
  readonly meta: MetaData;
  readonly range: RangeDef;
}

/** Page-level services that panels may call. */
export interface Host {
  readonly now: () => number;
  readonly setRange: (key: RangeDef['key']) => void;
  readonly reloadPage: () => void;
  readonly refresh: () => void;
  /** Called with the server time of the last successful hero response. */
  readonly touchUpdated: (generatedAt: string) => void;
  /** First error on a page is `alert`, later ones `status` (docs/DESIGN.md 8.3). */
  readonly claimErrorRole: () => 'alert' | 'status';
}

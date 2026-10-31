import type { SqlDialect } from './dialect/types.js';
import type { Driver } from './driver/types.js';
import type { ColumnModel, IpMode } from './model/types.js';
import type { Logger } from './logger.js';
import type { Redactor } from './redact.js';
import type { Dynalitics, ErrorInfo } from './types.js';

/** What the read handler needs from a Dynalitics instance. Not part of the public API. */
export interface Internals {
  readonly reader: Driver | undefined;
  readonly dialect: SqlDialect;
  readonly model: ColumnModel;
  readonly ipMode: IpMode;
  readonly redact: Redactor;
  readonly report: (info: ErrorInfo) => void;
  readonly logger: Logger;
  readonly now: () => Date;
}

const registry = new WeakMap<object, Internals>();

export function registerInternals(dyn: Dynalitics, internals: Internals): void {
  registry.set(dyn, internals);
}

export function getInternals(dyn: Dynalitics): Internals | undefined {
  return registry.get(dyn);
}

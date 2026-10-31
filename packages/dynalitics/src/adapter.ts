/**
 * 'dynalitics/adapter': the contract an adapter package implements (spec 5.2, v0.5).
 * Imports no driver and no network code.
 */
export {
  ADAPTER_API_VERSION,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DriverError,
  IDLE_TIMEOUT_MS,
  errCode,
  errMessage,
  isDriverError,
  isTransientError,
  scrubMessage,
  toDriverError,
} from './driver/types.js';
export type { Classification, Driver, DriverAdapter, DriverOptions } from './driver/types.js';
export type { CompiledQuery, Row } from './dialect/types.js';
export type { Dialect } from './model/types.js';
export type { Redactor } from './redact.js';
export type { Credential } from './types.js';

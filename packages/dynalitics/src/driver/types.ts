import { DynaliticsError, type SafeCause } from '../errors.js';
import type { CompiledQuery, Row } from '../dialect/types.js';
import type { Redactor } from '../redact.js';
import { sanitizeError } from '../redact.js';
import type { Dialect } from '../model/types.js';
import type { Credential } from '../types.js';
import type { ADAPTER_API_VERSION } from '../adapter-version.js';

export interface DriverOptions {
  readonly credential: Credential;
  /** Pool size for pools dynalitics creates. */
  readonly max: number;
  readonly connectTimeoutMs: number;
  readonly redact: Redactor;
  /** Default request timeout for pools dynalitics creates. */
  readonly requestTimeoutMs?: number;
}

/** Runtime part of an adapter: a thin wrapper around a pool. All SQL text comes from the dialect. */
export interface Driver {
  query(q: CompiledQuery, opts: { timeoutMs: number }): Promise<readonly Row[]>;
  isTransient(err: unknown): boolean;
  /** No-op when the pool belongs to the host. */
  close(): Promise<void>;
}

/**
 * What an adapter package (dynalitics-postgres, -mysql, -mssql) exports. The only code that imports a driver.
 */
export interface DriverAdapter {
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly dialect: Dialect;
  /** e.g. 'dynalitics-postgres'; shown in errors only. */
  readonly packageName: string;
  /** Called once per credential. Must build every error with toDriverError and never close a host pool. */
  createDriver(options: DriverOptions): Promise<Driver>;
}

/** Cross-copy brand: an adapter that resolved a second copy of dynalitics still produces recognisable errors. */
const DRIVER_ERROR_BRAND: unique symbol = Symbol.for('dynalitics.DriverError') as never;

/** The only error type drivers throw: redacted message, sanitised cause, never the raw driver error. */
export class DriverError extends DynaliticsError {
  readonly [DRIVER_ERROR_BRAND] = true;
  readonly transient: boolean;
  readonly timeout: boolean;
  /** A data or constraint error caused by ONE row's values (as opposed to one that would fail every row). */
  readonly data: boolean;
  /** The database user lacks a privilege (batch-wide: retrying row by row cannot help). */
  readonly permission: boolean;

  constructor(
    safeCause: SafeCause,
    transient: boolean,
    timeout: boolean,
    data = false,
    permission = false,
  ) {
    super('DYNALITICS_DRIVER', safeCause.message, safeCause);
    this.transient = transient;
    this.timeout = timeout;
    this.data = data;
    this.permission = permission;
  }
}

export interface Classification {
  readonly transient: boolean;
  readonly timeout: boolean;
  /** Data/constraint error: its message may contain the offending visitor value, so it is never forwarded. */
  readonly data?: boolean;
  readonly permission?: boolean;
  /** Connection, authentication and network classes: the (redacted, scrubbed) message is forwarded. */
  readonly forward?: boolean;
}

const MAX_MESSAGE = 300;
const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\([^()]*\)/g;

/** Drops quoted literals and parenthesised values (where databases print offending values) and caps the length. */
export function scrubMessage(message: string): string {
  return message
    .replace(QUOTED, (m) => (m.startsWith('(') ? '(…)' : m.startsWith('"') ? '"…"' : "'…'"))
    .slice(0, MAX_MESSAGE);
}

/**
 * Message policy (F-02): data/constraint errors forward no text (it can contain the offending value), permission
 * errors a fixed sentence, connection/auth/network/timeout classes their redacted and scrubbed message, and every
 * other class only its name and code.
 */
export function toDriverError(
  err: unknown,
  redact: Redactor,
  classify: (err: unknown) => Classification,
): DriverError {
  const { transient, timeout, data = false, permission = false, forward = false } = classify(err);
  const base = sanitizeError(err, redact);
  const withCode = base.code === undefined ? '' : ` (${base.code})`;
  const head = { name: base.name, ...(base.code === undefined ? {} : { code: base.code }) };
  let message: string;
  if (data) message = `data or constraint error${withCode}; the offending value is not shown`;
  else if (permission) message = 'permission denied; the database user lacks a required privilege';
  else if (forward || timeout || transient) message = scrubMessage(base.message);
  else message = `database error${withCode}; details are not forwarded`;
  return new DriverError({ ...head, message }, transient, timeout, data, permission);
}

/** `instanceof DriverError`, also true for a DriverError built by another copy of this package (spec v0.5, A5). */
export function isDriverError(err: unknown): err is DriverError {
  return (
    err instanceof DriverError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as Record<symbol, unknown>)[DRIVER_ERROR_BRAND] === true)
  );
}

export const isTransientError = (err: unknown): boolean => isDriverError(err) && err.transient;

export const errCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : '';
};
export const errMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).toLowerCase();

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 30_000;

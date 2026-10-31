import type { CompiledQuery, Row } from '../../src/dialect/types.js';
import { DriverError, type Driver } from '../../src/driver/types.js';

export interface FakeDriver extends Driver {
  readonly calls: CompiledQuery[];
  closed: number;
  /** Return a value to answer, throw to fail. Default: success with no rows. */
  handler: (q: CompiledQuery, callIndex: number) => readonly Row[] | Promise<readonly Row[]>;
}

export const transientError = (): DriverError =>
  new DriverError({ name: 'Error', code: 'ECONNRESET', message: 'connection reset' }, true, false);
/** A data or constraint error that is specific to one row. */
export const permanentError = (msg = 'violates constraint'): DriverError =>
  new DriverError({ name: 'Error', code: '23505', message: msg }, false, false, true);
/** A permanent error that would fail every row identically (permission, missing object, read-only). */
export const batchWideError = (msg = 'permission denied'): DriverError =>
  new DriverError({ name: 'Error', code: '42501', message: msg }, false, false, false);

export function fakeDriver(handler?: FakeDriver['handler']): FakeDriver {
  const calls: CompiledQuery[] = [];
  const d: FakeDriver = {
    calls,
    closed: 0,
    handler: handler ?? (() => []),
    query(q) {
      calls.push(q);
      return Promise.resolve(d.handler(q, calls.length - 1));
    },
    isTransient: (e) => e instanceof DriverError && e.transient,
    close() {
      d.closed++;
      return Promise.resolve();
    },
  };
  return d;
}

/** The database user lacks INSERT (batch-wide, flagged so the writer can hint at the missing grant). */
export const permissionError = (): DriverError =>
  new DriverError(
    {
      name: 'Error',
      code: '42501',
      message: 'permission denied; the database user lacks a required privilege',
    },
    false,
    false,
    false,
    true,
  );

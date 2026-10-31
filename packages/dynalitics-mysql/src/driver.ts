import mysqlModule from 'mysql2/promise';
import {
  errCode,
  isTransientError,
  toDriverError,
  type Classification,
  type Driver,
  type DriverOptions,
  type Row,
} from 'dynalitics/adapter';

type MyResult = [unknown, unknown];
interface MyConn {
  execute(q: { sql: string }, params: unknown[]): Promise<MyResult>;
  query(sql: string): Promise<MyResult>;
  release(): void;
  destroy(): void;
}
interface MyPool {
  getConnection?(): Promise<MyConn>;
  execute(q: { sql: string; timeout?: number }, params: unknown[]): Promise<MyResult>;
  query?(sql: string): Promise<MyResult>;
  end?(): Promise<void>;
}
interface MyModule {
  createPool(config: Record<string, unknown>): MyPool;
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_QUERY_TIMEOUT',
]);
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_QUERY_TIMEOUT',
  'ETIMEDOUT',
]);
const DATA_CODES: ReadonlySet<string> = new Set([
  'ER_DUP_ENTRY',
  'ER_TRUNCATED_WRONG_VALUE',
  'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
  'ER_DATA_TOO_LONG',
  'ER_BAD_NULL_ERROR',
  'ER_WARN_DATA_OUT_OF_RANGE',
  'ER_NO_REFERENCED_ROW_2',
  'ER_ROW_IS_REFERENCED_2',
  'ER_CHECK_CONSTRAINT_VIOLATED',
  'ER_INVALID_CHARACTER_STRING',
  'ER_WRONG_VALUE_COUNT_ON_ROW',
]);
const DATA_ERRNOS: ReadonlySet<number> = new Set([
  1048, 1062, 1264, 1292, 1300, 1366, 1406, 1451, 1452, 3819,
]);
const PERMISSION_CODES: ReadonlySet<string> = new Set([
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
]);
const AUTH_CODES: ReadonlySet<string> = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ENOTFOUND',
]);
/** The server stops a SELECT at the hint's deadline; the client destroys the connection this long afterwards. */
const BACKSTOP_MS = 500;
const MAX_PREPARED_STATEMENTS = 64;

export function classifyMysql(err: unknown): Classification {
  const code = errCode(err);
  const errno = (err as { errno?: unknown } | null)?.errno;
  const transient = TRANSIENT_CODES.has(code);
  return {
    transient,
    timeout: TIMEOUT_CODES.has(code),
    data: DATA_CODES.has(code) || (typeof errno === 'number' && DATA_ERRNOS.has(errno)),
    permission: PERMISSION_CODES.has(code),
    forward: transient || AUTH_CODES.has(code),
  };
}

// mysql2 prepared statements want 1/0 for booleans.
const toParam = (v: unknown): unknown => (typeof v === 'boolean' ? (v ? 1 : 0) : v);

/** MySQL kills a SELECT on its own once it exceeds the hint, so a stuck query cannot outlive the deadline. */
export function withExecutionHint(sql: string, timeoutMs: number): string {
  return /^\s*SELECT\b/i.test(sql)
    ? sql.replace(
        /^\s*SELECT\b/i,
        (m) => `${m} /*+ MAX_EXECUTION_TIME(${Math.max(1, Math.trunc(timeoutMs))}) */`,
      )
    : sql;
}

export async function createMysqlDriver(o: DriverOptions): Promise<Driver> {
  let pool: MyPool;
  let owned = false;
  if ('pool' in o.credential) {
    pool = o.credential.pool as MyPool;
  } else {
    const mysql = mysqlModule as unknown as MyModule;
    pool = mysql.createPool({
      uri: o.credential.connectionString,
      connectionLimit: o.max,
      connectTimeout: o.connectTimeoutMs,
      timezone: 'Z',
      dateStrings: true,
      multipleStatements: false,
      // Prepared statements are cached per connection and counted globally by the server (max_prepared_stmt_count).
      maxPreparedStatements: MAX_PREPARED_STATEMENTS,
    });
    owned = true;
  }

  async function viaConnection(
    conn: MyConn,
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
  ): Promise<unknown> {
    let destroyed = false;
    try {
      // SHOW statements cannot be prepared; they take no parameters, so plain query() is safe.
      const running = sql.startsWith('SHOW ')
        ? conn.query(sql)
        : conn.execute({ sql: withExecutionHint(sql, timeoutMs) }, params.map(toParam));
      running.catch(() => undefined);
      const [rows] = await new Promise<MyResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          destroyed = true;
          conn.destroy();
          reject(
            Object.assign(new Error('Query execution was interrupted: deadline exceeded'), {
              code: 'ER_QUERY_TIMEOUT',
            }),
          );
        }, timeoutMs + BACKSTOP_MS);
        running.then(
          (r) => (clearTimeout(timer), resolve(r)),
          (e: unknown) => (clearTimeout(timer), reject(e as Error)),
        );
      });
      return rows;
    } finally {
      if (!destroyed) conn.release(); // never hand a destroyed connection back to the pool
    }
  }

  return {
    async query(q, { timeoutMs }) {
      try {
        let rows: unknown;
        if (pool.getConnection === undefined) {
          // Host pools without getConnection(): client-side deadline only (the host must set max_execution_time).
          [rows] =
            q.sql.startsWith('SHOW ') && pool.query !== undefined
              ? await pool.query(q.sql)
              : await pool.execute(
                  { sql: withExecutionHint(q.sql, timeoutMs), timeout: timeoutMs },
                  q.params.map(toParam),
                );
        } else {
          rows = await viaConnection(await pool.getConnection(), q.sql, q.params, timeoutMs);
        }
        return Array.isArray(rows) ? (rows as Row[]) : [];
      } catch (err) {
        throw toDriverError(err, o.redact, classifyMysql);
      }
    },
    isTransient: isTransientError,
    async close() {
      if (owned) await pool.end?.();
    },
  };
}

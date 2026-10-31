import mssqlModule from 'mssql';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  errCode,
  isTransientError,
  toDriverError,
  type Classification,
  type Driver,
  type DriverOptions,
  type Row,
} from 'dynalitics/adapter';

interface MsRequest {
  input(name: string, value: unknown): unknown;
  cancel?(): void;
  query(sql: string): Promise<{ recordset?: Row[] }>;
}
interface MsPool {
  request(): MsRequest;
  connect?(): Promise<unknown>;
  close?(): Promise<void>;
}
interface MsModule {
  ConnectionPool: {
    new (config: Record<string, unknown>): MsPool;
    parseConnectionString(cs: string): Record<string, unknown>;
  };
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ETIMEOUT',
  'ESOCKET',
  'ECONNCLOSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
]);
const DEADLOCK = 1205;
// null insert, FK, truncation, unique-key and conversion errors: these quote the offending value
const DATA_NUMBERS: ReadonlySet<number> = new Set([
  220, 245, 515, 547, 2601, 2627, 2628, 8114, 8115, 8152,
]);

const PERMISSION_NUMBERS: ReadonlySet<number> = new Set([229, 230, 262, 297]);

export function classifyMssql(err: unknown): Classification {
  const code = errCode(err);
  const number = (err as { number?: unknown } | null)?.number;
  const transient = TRANSIENT_CODES.has(code) || number === DEADLOCK;
  return {
    transient,
    timeout: code === 'ETIMEOUT',
    data: typeof number === 'number' && DATA_NUMBERS.has(number),
    permission: typeof number === 'number' && PERMISSION_NUMBERS.has(number),
    forward: transient || code === 'ELOGIN',
  };
}

export async function createMssqlDriver(o: DriverOptions): Promise<Driver> {
  let pool: MsPool;
  let owned = false;
  if ('pool' in o.credential) {
    pool = o.credential.pool as MsPool;
  } else {
    const mssql = mssqlModule as unknown as MsModule;
    const parsed = mssql.ConnectionPool.parseConnectionString(o.credential.connectionString);
    pool = new mssql.ConnectionPool({
      ...parsed,
      pool: { max: o.max, idleTimeoutMillis: IDLE_TIMEOUT_MS },
      connectionTimeout: o.connectTimeoutMs,
      requestTimeout: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    try {
      await pool.connect?.();
    } catch (err) {
      throw toDriverError(err, o.redact, classifyMssql);
    }
    owned = true;
  }
  return {
    async query(q, { timeoutMs }) {
      const req = pool.request();
      let cancelled = false;
      // cancel() makes the server stop the statement; the promise below rejects only once that has happened.
      const timer = setTimeout(() => {
        cancelled = true;
        req.cancel?.();
      }, timeoutMs);
      try {
        q.params.forEach((value, i) => req.input(`p${i + 1}`, value));
        const res = await req.query(q.sql);
        return res.recordset ?? [];
      } catch (err) {
        const reported = cancelled
          ? Object.assign(new Error('Timeout: the request was cancelled at its deadline'), {
              code: 'ETIMEOUT',
            })
          : err;
        throw toDriverError(reported, o.redact, classifyMssql);
      } finally {
        clearTimeout(timer);
      }
    },
    isTransient: isTransientError,
    async close() {
      if (owned) await pool.close?.();
    },
  };
}

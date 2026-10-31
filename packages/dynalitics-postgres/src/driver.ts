import pgModule from 'pg';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  errCode,
  errMessage,
  isTransientError,
  toDriverError,
  type Classification,
  type Driver,
  type DriverOptions,
  type Row,
} from 'dynalitics/adapter';

interface PgClient {
  readonly processID?: number;
  query(q: { text: string; values: unknown[] }): Promise<{ rows: Row[] }>;
  release(destroy?: boolean): void;
}
interface PgPool {
  connect?(): Promise<PgClient>;
  query(q: { text: string; values: unknown[]; query_timeout?: number }): Promise<{ rows: Row[] }>;
  end?(): Promise<void>;
  on?(event: string, listener: () => void): unknown;
}
interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53400',
  '40001',
  '40P01',
]);
const CANCEL_GUARD_MS = 2000;

export function classifyPg(err: unknown): Classification {
  const code = errCode(err);
  const msg = errMessage(err);
  const timeout =
    msg.includes('read timeout') || msg.includes('statement timeout') || code === '57014';
  const transient =
    timeout ||
    TRANSIENT_CODES.has(code) ||
    code.startsWith('08') ||
    msg.includes('connection terminated') ||
    msg.includes('connection timeout');
  return {
    transient,
    timeout,
    // SQLSTATE class 22 (data exception) and 23 (integrity constraint violation)
    data: /^(22|23)/.test(code),
    permission: code === '42501',
    // connection (08), network, server shutdown (57P0x) and invalid authorization (28xxx) classes
    forward: transient || code.startsWith('28') || code === 'ENOTFOUND' || code === 'EAI_AGAIN',
  };
}

/** Asks the server to stop the backend (own-role queries only), never waiting longer than CANCEL_GUARD_MS. */
async function cancelBackend(pool: PgPool, pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const attempt = pool
    .query({ text: 'SELECT pg_cancel_backend($1)', values: [pid], query_timeout: CANCEL_GUARD_MS })
    .then(
      () => undefined,
      () => undefined,
    );
  await Promise.race([
    attempt,
    new Promise<void>((resolve) => setTimeout(resolve, CANCEL_GUARD_MS).unref?.()),
  ]);
}

export async function createPostgresDriver(o: DriverOptions): Promise<Driver> {
  let pool: PgPool;
  let owned = false;
  if ('pool' in o.credential) {
    pool = o.credential.pool as PgPool;
  } else {
    const pg = pgModule as unknown as PgModule;
    pool = new pg.Pool({
      connectionString: o.credential.connectionString,
      max: o.max,
      connectionTimeoutMillis: o.connectTimeoutMs,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      statement_timeout: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    // An idle client dying must not crash the host process with an unhandled 'error' event.
    pool.on?.('error', () => undefined);
    owned = true;
  }

  /** Host pools without connect(): client-side deadline only (the host must set statement_timeout). */
  async function viaPool(
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
  ): Promise<Row[]> {
    return (await pool.query({ text: sql, values: [...params], query_timeout: timeoutMs })).rows;
  }

  async function viaClient(
    connect: () => Promise<PgClient>,
    sql: string,
    params: readonly unknown[],
    timeoutMs: number,
  ): Promise<Row[]> {
    const client = await connect();
    let destroy = false;
    try {
      const running = client.query({ text: sql, values: [...params] });
      running.catch(() => undefined); // an abandoned query may reject later; that must never be unhandled
      const result = await new Promise<{ rows: Row[] }>((resolve, reject) => {
        const timer = setTimeout(() => {
          destroy = true;
          // The slot is only freed after the cancel was attempted and the connection is being destroyed.
          void cancelBackend(pool, client.processID).then(() =>
            reject(new Error('Query read timeout')),
          );
        }, timeoutMs);
        running.then(
          (r) => (clearTimeout(timer), resolve(r)),
          (e: unknown) => (clearTimeout(timer), reject(e as Error)),
        );
      });
      return result.rows;
    } finally {
      client.release(destroy);
    }
  }

  return {
    async query(q, { timeoutMs }) {
      try {
        return pool.connect === undefined
          ? await viaPool(q.sql, q.params, timeoutMs)
          : await viaClient(
              () => pool.connect?.() as Promise<PgClient>,
              q.sql,
              q.params,
              timeoutMs,
            );
      } catch (err) {
        throw toDriverError(err, o.redact, classifyPg);
      }
    },
    isTransient: isTransientError,
    async close() {
      if (owned) await pool.end?.();
    },
  };
}

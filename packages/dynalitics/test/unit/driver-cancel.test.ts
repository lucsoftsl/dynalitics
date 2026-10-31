import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRedactor } from '../../src/redact.js';

interface FakeClient {
  processID: number;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}
interface FakeConn {
  execute: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}
interface FakeReq {
  inputs: unknown[];
  cancel: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

interface State {
  pgClient: unknown;
  pgPoolQueries: { text: string; values: unknown[] }[];
  pgCancelFails: boolean;
  myConn: unknown;
  myConfig: unknown;
  msReq: unknown;
}
const s = vi.hoisted((): State => ({
  pgClient: undefined,
  pgPoolQueries: [],
  pgCancelFails: false,
  myConn: undefined,
  myConfig: undefined,
  msReq: undefined,
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      on(): void {}
      connect(): Promise<unknown> {
        return Promise.resolve(s.pgClient);
      }
      query(q: { text: string; values: unknown[] }): Promise<unknown> {
        s.pgPoolQueries.push(q);
        return s.pgCancelFails
          ? Promise.reject(new Error('cannot cancel'))
          : Promise.resolve({ rows: [] });
      }
      end(): Promise<void> {
        return Promise.resolve();
      }
    },
  },
}));
vi.mock('mysql2/promise', () => ({
  default: {
    createPool: (cfg: unknown) => {
      s.myConfig = cfg;
      return { getConnection: () => Promise.resolve(s.myConn), end: () => Promise.resolve() };
    },
  },
}));
vi.mock('mssql', () => ({
  default: {
    ConnectionPool: class {
      static parseConnectionString(): Record<string, unknown> {
        return {};
      }
      connect(): Promise<this> {
        return Promise.resolve(this);
      }
      request(): unknown {
        return s.msReq;
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  },
}));

const { createDriver } = await import('../../src/driver/index.js');
const { DriverError } = await import('../../src/driver/types.js');
const opts = { max: 2, connectTimeoutMs: 1000, redact: createRedactor([]) };
const settle = (p: Promise<unknown>): Promise<unknown> => p.catch((e: unknown) => e);

beforeEach(() => {
  vi.useFakeTimers();
  s.pgPoolQueries = [];
  s.pgCancelFails = false;
});
afterEach(() => vi.useRealTimers());

describe('PostgreSQL: a timed-out query is cancelled on the server and its connection destroyed (F-05)', () => {
  const client = (query: FakeClient['query']): FakeClient => ({
    processID: 4242,
    query,
    release: vi.fn(),
  });

  test('normal queries use one pooled client and give it back', async () => {
    const c = client(vi.fn().mockResolvedValue({ rows: [{ a: 1 }] }));
    s.pgClient = c;
    const d = await createDriver('postgres', {
      ...opts,
      credential: { connectionString: 'postgres://u:pw12345@h/db' },
    });
    expect(await d.query({ sql: 'SELECT $1', params: ['x'] }, { timeoutMs: 1000 })).toEqual([
      { a: 1 },
    ]);
    expect(c.query).toHaveBeenCalledWith({ text: 'SELECT $1', values: ['x'] });
    expect(c.release).toHaveBeenCalledWith(false);
    expect(s.pgPoolQueries).toEqual([]);
  });

  test('on timeout: pg_cancel_backend(pid) is issued, the client is destroyed, and only THEN does the call settle', async () => {
    const c = client(vi.fn(() => new Promise(() => undefined)));
    s.pgClient = c;
    const d = await createDriver('postgres', {
      ...opts,
      credential: { connectionString: 'postgres://u:pw12345@h/db' },
    });
    let settled = false;
    const p = settle(d.query({ sql: 'SELECT pg_sleep(30)', params: [] }, { timeoutMs: 1000 })).then(
      (e) => ((settled = true), e),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(c.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = (await p) as InstanceType<typeof DriverError>;
    expect(s.pgPoolQueries).toEqual([
      { text: 'SELECT pg_cancel_backend($1)', values: [4242], query_timeout: 2000 },
    ]);
    expect(c.release).toHaveBeenCalledWith(true);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.timeout).toBe(true);
  });

  test('if the cancel request itself fails, the connection is still destroyed', async () => {
    s.pgCancelFails = true;
    const c = client(vi.fn(() => new Promise(() => undefined)));
    s.pgClient = c;
    const d = await createDriver('postgres', {
      ...opts,
      credential: { connectionString: 'postgres://u:pw12345@h/db' },
    });
    const p = settle(d.query({ sql: 'x', params: [] }, { timeoutMs: 500 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(((await p) as InstanceType<typeof DriverError>).timeout).toBe(true);
    expect(c.release).toHaveBeenCalledWith(true);
  });

  test('a late rejection of the abandoned query does not become an unhandled rejection', async () => {
    let rejectLate: (e: Error) => void = () => undefined;
    const c = client(vi.fn(() => new Promise((_r, rej) => (rejectLate = rej))));
    s.pgClient = c;
    const d = await createDriver('postgres', {
      ...opts,
      credential: { connectionString: 'postgres://u:pw12345@h/db' },
    });
    const p = settle(d.query({ sql: 'x', params: [] }, { timeoutMs: 100 }));
    await vi.advanceTimersByTimeAsync(100);
    await p;
    rejectLate(new Error('Connection terminated'));
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('MySQL: server-side MAX_EXECUTION_TIME hint plus a client backstop that destroys the connection (F-05, F-35)', () => {
  const conn = (execute: FakeConn['execute']): FakeConn => ({
    execute,
    query: vi.fn().mockResolvedValue([[{ g: 'x' }], []]),
    release: vi.fn(),
    destroy: vi.fn(),
  });
  const cred = { connectionString: 'mysql://u:pw12345@h/db' };

  test('SELECT statements carry the hint; other statements and SHOW do not', async () => {
    const c = conn(vi.fn().mockResolvedValue([[{ n: 1 }], []]));
    s.myConn = c;
    const d = await createDriver('mysql', { ...opts, credential: cred });
    await d.query({ sql: 'SELECT 1', params: [] }, { timeoutMs: 1500 });
    await d.query({ sql: 'INSERT INTO t VALUES (?)', params: [true] }, { timeoutMs: 1500 });
    await d.query({ sql: 'SHOW GRANTS FOR CURRENT_USER()', params: [] }, { timeoutMs: 1500 });
    expect(c.execute.mock.calls[0]?.[0]).toEqual({
      sql: 'SELECT /*+ MAX_EXECUTION_TIME(1500) */ 1',
    });
    expect(c.execute.mock.calls[1]).toEqual([{ sql: 'INSERT INTO t VALUES (?)' }, [1]]);
    expect(c.query).toHaveBeenCalledWith('SHOW GRANTS FOR CURRENT_USER()');
    expect(c.release).toHaveBeenCalledTimes(3);
    expect(c.destroy).not.toHaveBeenCalled();
  });

  test('if the server does not stop the query, the connection is destroyed shortly after the deadline', async () => {
    const c = conn(vi.fn(() => new Promise(() => undefined)));
    s.myConn = c;
    const d = await createDriver('mysql', { ...opts, credential: cred });
    const p = settle(d.query({ sql: 'SELECT SLEEP(30)', params: [] }, { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1499);
    expect(c.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = (await p) as InstanceType<typeof DriverError>;
    expect(c.destroy).toHaveBeenCalledTimes(1);
    expect(c.release).not.toHaveBeenCalled(); // never hand a destroyed connection back
    expect(err.timeout).toBe(true);
  });

  test('a server-side kill (ER_QUERY_TIMEOUT) is classified as a timeout and the connection is returned', async () => {
    const c = conn(
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error('Query execution was interrupted, maximum statement execution time exceeded'),
            { code: 'ER_QUERY_TIMEOUT', errno: 3024 },
          ),
        ),
    );
    s.myConn = c;
    const d = await createDriver('mysql', { ...opts, credential: cred });
    const err = (await settle(
      d.query({ sql: 'SELECT 1', params: [] }, { timeoutMs: 1000 }),
    )) as InstanceType<typeof DriverError>;
    expect(err.timeout).toBe(true);
    expect(c.release).toHaveBeenCalledTimes(1);
  });

  test('owned pools bound the client-side prepared-statement cache', async () => {
    s.myConn = conn(vi.fn());
    await createDriver('mysql', { ...opts, credential: cred });
    expect(s.myConfig).toMatchObject({ maxPreparedStatements: 64 });
  });
});

describe('SQL Server: request.cancel() on the deadline (F-05)', () => {
  test('cancels, waits for the cancelled request to reject, and reports a timeout', async () => {
    let reject: (e: Error) => void = () => undefined;
    const req: FakeReq = {
      inputs: [],
      cancel: vi.fn(() => reject(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }))),
      query: vi.fn(() => new Promise((_r, rej) => (reject = rej))),
    };
    (req as unknown as { input: (n: string, v: unknown) => void }).input = (n, v) =>
      void req.inputs.push([n, v]);
    s.msReq = req;
    const d = await createDriver('mssql', {
      ...opts,
      credential: { connectionString: 'Server=h;Password=Pw123456' },
    });
    const p = settle(d.query({ sql: "WAITFOR DELAY '00:00:30'", params: [] }, { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    const err = (await p) as InstanceType<typeof DriverError>;
    expect(req.cancel).toHaveBeenCalledTimes(1);
    expect(err.timeout).toBe(true);
    expect(err.transient).toBe(true);
  });
});

describe('F-02: which driver messages are forwarded', () => {
  const secret = 'jane.canary@example.com';
  const run = async (code: string, message: string, extra: Record<string, unknown> = {}) => {
    const c = {
      processID: 1,
      query: vi.fn().mockRejectedValue(Object.assign(new Error(message), { code, ...extra })),
      release: vi.fn(),
    };
    s.pgClient = c;
    const d = await createDriver('postgres', {
      ...opts,
      credential: { connectionString: 'postgres://u:pw12345@h/db' },
    });
    return (await settle(d.query({ sql: 'x', params: [] }, { timeoutMs: 1000 }))) as InstanceType<
      typeof DriverError
    >;
  };

  test('connection and auth classes keep their (redacted, scrubbed) message', async () => {
    expect((await run('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.5:5432')).message).toBe(
      'connect ECONNREFUSED 10.0.0.5:5432',
    );
    expect((await run('28P01', 'password authentication failed for user "app"')).message).toBe(
      'password authentication failed for user "…"',
    );
  });
  test('data/constraint classes forward NO text', async () => {
    const e = await run('22P02', `invalid input syntax for type integer: "${secret}"`);
    expect(e.message).toBe('data or constraint error (22P02); the offending value is not shown');
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain('canary');
  });
  test('permission errors get a fixed sentence and a flag, not the driver text', async () => {
    const e = await run('42501', `permission denied for table events (${secret})`);
    expect(e.permission).toBe(true);
    expect(e.message).toBe('permission denied; the database user lacks a required privilege');
  });
  test('every other class forwards only name and code', async () => {
    const e = await run('42601', `syntax error at or near "${secret}"`);
    expect(e.message).toBe('database error (42601); details are not forwarded');
    expect(e.data).toBe(false);
    expect(e.permission).toBe(false);
  });
});

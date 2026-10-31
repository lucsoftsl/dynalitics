import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRedactor } from '../../src/redact.js';

const CANARY = 'Sup3rS3cretPw';
const CS = `postgres://app:${CANARY}@db.example.com:5432/x`;

interface State {
  pgCalls: unknown[];
  pgPoolConfig: unknown;
  pgEnded: number;
  pgResult: { rows: unknown[] };
  pgError: Error | undefined;
  myCalls: unknown[];
  myConfig: unknown;
  myEnded: number;
  myError: Error | undefined;
  msInputs: unknown[];
  msConfig: unknown;
  msClosed: number;
  msError: Error | undefined;
  msSql: string;
}
const state = vi.hoisted((): State => ({
  pgCalls: [],
  pgPoolConfig: undefined,
  pgEnded: 0,
  pgResult: { rows: [{ a: 1 }] },
  pgError: undefined,
  myCalls: [],
  myConfig: undefined,
  myEnded: 0,
  myError: undefined,
  msInputs: [],
  msConfig: undefined,
  msClosed: 0,
  msError: undefined,
  msSql: '',
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(cfg: unknown) {
        state.pgPoolConfig = cfg;
      }
      on(): void {}
      query(q: unknown): Promise<unknown> {
        state.pgCalls.push(q);
        return state.pgError === undefined
          ? Promise.resolve(state.pgResult)
          : Promise.reject(state.pgError);
      }
      end(): Promise<void> {
        state.pgEnded++;
        return Promise.resolve();
      }
    },
  },
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: (cfg: unknown) => {
      state.myConfig = cfg;
      return {
        execute: (q: unknown, params: unknown) => {
          state.myCalls.push({ via: 'execute', q, params });
          return state.myError === undefined
            ? Promise.resolve([[{ b: 2 }], []])
            : Promise.reject(state.myError);
        },
        query: (sql: unknown) => {
          state.myCalls.push({ via: 'query', sql });
          return Promise.resolve([[{ 'Grants for x': 'GRANT USAGE ON *.* TO x' }], []]);
        },
        end: () => {
          state.myEnded++;
          return Promise.resolve();
        },
      };
    },
  },
}));

vi.mock('mssql', () => {
  class Request {
    inputs: unknown[] = [];
    input(name: string, value: unknown): void {
      this.inputs.push([name, value]);
    }
    query(sql: string): Promise<unknown> {
      state.msSql = sql;
      state.msInputs = this.inputs;
      return state.msError === undefined
        ? Promise.resolve({ recordset: [{ c: 3 }] })
        : Promise.reject(state.msError);
    }
  }
  class ConnectionPool {
    static parseConnectionString(cs: string): Record<string, unknown> {
      return { parsedFrom: cs };
    }
    constructor(cfg: unknown) {
      state.msConfig = cfg;
    }
    connect(): Promise<this> {
      return Promise.resolve(this);
    }
    request(): Request {
      return new Request();
    }
    close(): Promise<void> {
      state.msClosed++;
      return Promise.resolve();
    }
  }
  return { default: { ConnectionPool } };
});

const { createDriver } = await import('../../src/driver/index.js');
const { DriverError } = await import('../../src/driver/types.js');
const redact = createRedactor([CS, CANARY]);
const opts = { max: 3, connectTimeoutMs: 1000, redact };

beforeEach(() => {
  Object.assign(state, {
    pgCalls: [],
    pgEnded: 0,
    pgError: undefined,
    myCalls: [],
    myEnded: 0,
    myError: undefined,
    msInputs: [],
    msClosed: 0,
    msError: undefined,
  });
});

describe('postgres driver', () => {
  test('creates an owned pool, binds params, passes the timeout, returns rows', async () => {
    const d = await createDriver('postgres', { ...opts, credential: { connectionString: CS } });
    const rows = await d.query({ sql: 'SELECT $1', params: ['x'] }, { timeoutMs: 1234 });
    expect(rows).toEqual([{ a: 1 }]);
    expect(state.pgCalls[0]).toEqual({ text: 'SELECT $1', values: ['x'], query_timeout: 1234 });
    expect(state.pgPoolConfig).toMatchObject({
      connectionString: CS,
      max: 3,
      connectionTimeoutMillis: 1000,
    });
    await d.close();
    expect(state.pgEnded).toBe(1);
  });

  test('does not end a pool owned by the host', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() };
    const d = await createDriver('postgres', { ...opts, credential: { pool } });
    await d.query({ sql: 'SELECT 1', params: [] }, { timeoutMs: 1 });
    await d.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  test('errors are redacted, sanitised and classified', async () => {
    state.pgError = Object.assign(new Error(`password authentication failed ${CS} ${CANARY}`), {
      code: 'ECONNRESET',
      config: { password: CANARY },
    });
    const d = await createDriver('postgres', { ...opts, credential: { connectionString: CS } });
    const err = await d
      .query({ sql: 'SELECT 1', params: [] }, { timeoutMs: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(CANARY);
    expect((err as InstanceType<typeof DriverError>).transient).toBe(true);
    expect(d.isTransient(err)).toBe(true);
    expect(d.isTransient(new Error('plain'))).toBe(false);
  });

  test('classifies timeouts and permanent errors', async () => {
    const d = await createDriver('postgres', { ...opts, credential: { connectionString: CS } });
    state.pgError = new Error('Query read timeout');
    const t = (await d
      .query({ sql: 'x', params: [] }, { timeoutMs: 1 })
      .catch((e: unknown) => e)) as InstanceType<typeof DriverError>;
    expect(t.timeout).toBe(true);
    state.pgError = Object.assign(new Error('permission denied for table t'), { code: '42501' });
    const p = (await d
      .query({ sql: 'x', params: [] }, { timeoutMs: 1 })
      .catch((e: unknown) => e)) as InstanceType<typeof DriverError>;
    expect(p.transient).toBe(false);
  });
});

describe('mysql driver', () => {
  test('uses prepared statements, converts booleans to 1/0, returns rows', async () => {
    const d = await createDriver('mysql', {
      ...opts,
      credential: { connectionString: 'mysql://u:pw12345@h/db' },
    });
    const rows = await d.query(
      { sql: 'SELECT ?', params: [true, false, null, 'x', 5] },
      { timeoutMs: 99 },
    );
    expect(rows).toEqual([{ b: 2 }]);
    expect(state.myCalls[0]).toEqual({
      via: 'execute',
      q: { sql: 'SELECT /*+ MAX_EXECUTION_TIME(99) */ ?', timeout: 99 },
      params: [1, 0, null, 'x', 5],
    });
    expect(state.myConfig).toMatchObject({
      uri: 'mysql://u:pw12345@h/db',
      connectionLimit: 3,
      connectTimeout: 1000,
      timezone: 'Z',
      dateStrings: true,
      multipleStatements: false,
    });
    await d.close();
    expect(state.myEnded).toBe(1);
  });

  test('SHOW statements go through query() because they cannot be prepared', async () => {
    const d = await createDriver('mysql', {
      ...opts,
      credential: { connectionString: 'mysql://u:pw12345@h/db' },
    });
    const rows = await d.query(
      { sql: 'SHOW GRANTS FOR CURRENT_USER()', params: [] },
      { timeoutMs: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(state.myCalls[0]).toMatchObject({ via: 'query' });
  });

  test('INSERT results (non-array) come back as an empty row list', async () => {
    const pool = {
      execute: vi.fn().mockResolvedValue([{ affectedRows: 2 }, undefined]),
      end: vi.fn(),
    };
    const d = await createDriver('mysql', { ...opts, credential: { pool } });
    expect(await d.query({ sql: 'INSERT', params: [] }, { timeoutMs: 1 })).toEqual([]);
  });

  test('classifies deadlocks as transient and others as permanent', async () => {
    const d = await createDriver('mysql', {
      ...opts,
      credential: { connectionString: 'mysql://u:pw12345@h/db' },
    });
    state.myError = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });
    const e1 = await d.query({ sql: 'x', params: [] }, { timeoutMs: 1 }).catch((e: unknown) => e);
    expect(d.isTransient(e1)).toBe(true);
    state.myError = Object.assign(new Error('INSERT command denied to user'), {
      code: 'ER_TABLEACCESS_DENIED_ERROR',
    });
    const e2 = await d.query({ sql: 'x', params: [] }, { timeoutMs: 1 }).catch((e: unknown) => e);
    expect(d.isTransient(e2)).toBe(false);
  });
});

describe('mssql driver', () => {
  test('binds @pN parameters and returns the recordset', async () => {
    const d = await createDriver('mssql', {
      ...opts,
      credential: { connectionString: 'Server=h;User Id=u;Password=Pw123456;' },
    });
    const rows = await d.query({ sql: 'SELECT @p1, @p2', params: ['a', true] }, { timeoutMs: 5 });
    expect(rows).toEqual([{ c: 3 }]);
    expect(state.msInputs).toEqual([
      ['p1', 'a'],
      ['p2', true],
    ]);
    expect(state.msConfig).toMatchObject({
      parsedFrom: 'Server=h;User Id=u;Password=Pw123456;',
      pool: { max: 3 },
      connectionTimeout: 1000,
    });
    await d.close();
    expect(state.msClosed).toBe(1);
  });

  test('timeouts and connection resets are classified', async () => {
    const d = await createDriver('mssql', {
      ...opts,
      credential: { connectionString: 'Server=h;Password=Pw123456' },
    });
    state.msError = Object.assign(new Error('Timeout: Request failed to complete'), {
      code: 'ETIMEOUT',
    });
    const e = (await d
      .query({ sql: 'x', params: [] }, { timeoutMs: 1 })
      .catch((x: unknown) => x)) as InstanceType<typeof DriverError>;
    expect(e.timeout).toBe(true);
    expect(d.isTransient(e)).toBe(true);
    state.msError = Object.assign(new Error('deadlock victim'), { number: 1205 });
    const e2 = await d.query({ sql: 'x', params: [] }, { timeoutMs: 1 }).catch((x: unknown) => x);
    expect(d.isTransient(e2)).toBe(true);
  });
});

describe('F-02: visitor values never leak through driver error messages', () => {
  const email = 'jane.canary@example.com';
  const make = async (dialect: 'postgres' | 'mysql' | 'mssql') =>
    createDriver(dialect, {
      ...opts,
      credential: {
        connectionString:
          dialect === 'mssql'
            ? 'Server=h;Password=Pw123456;'
            : `${dialect === 'postgres' ? 'postgres' : 'mysql'}://u:pw12345@h/db`,
      },
    });

  test.each([
    [
      'postgres',
      'pgError',
      Object.assign(new Error(`invalid input syntax for type integer: "${email}"`), {
        code: '22P02',
      }),
    ],
    [
      'postgres',
      'pgError',
      Object.assign(new Error(`duplicate key value violates unique constraint "u" (${email})`), {
        code: '23505',
      }),
    ],
    [
      'mysql',
      'myError',
      Object.assign(new Error(`Incorrect integer value: '${email}' for column 'uid' at row 1`), {
        code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
        errno: 1366,
      }),
    ],
    [
      'mysql',
      'myError',
      Object.assign(new Error(`Duplicate entry '${email}' for key 'email'`), {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
      }),
    ],
    [
      'mssql',
      'msError',
      Object.assign(
        new Error(`Violation of UNIQUE KEY constraint. The duplicate key value is (${email}).`),
        { number: 2627 },
      ),
    ],
  ] as const)('data/constraint errors on %s carry no message text', async (dialect, slot, err) => {
    const d = await make(dialect);
    (state as unknown as Record<string, unknown>)[slot] = err;
    const e = (await d
      .query({ sql: 'x', params: [] }, { timeoutMs: 1 })
      .catch((x: unknown) => x)) as InstanceType<typeof DriverError>;
    const dump = JSON.stringify(e, Object.getOwnPropertyNames(e)) + String(e.stack);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain('canary');
    expect(e.data).toBe(true);
    expect(e.transient).toBe(false);
    expect(e.message).toMatch(/^data or constraint error/);
  });

  test('other errors keep their message but quoted literals are scrubbed', async () => {
    const d = await make('postgres');
    state.pgError = Object.assign(
      new Error(
        `could not translate host name "db.internal" to address; value 'secret-token' near "${email}"`,
      ),
      { code: '08006' },
    );
    const e = (await d
      .query({ sql: 'x', params: [] }, { timeoutMs: 1 })
      .catch((x: unknown) => x)) as InstanceType<typeof DriverError>;
    expect(e.message).toContain('could not translate host name');
    expect(e.message).not.toContain(email);
    expect(e.message).not.toContain('secret-token');
    expect(e.data).toBe(false);
  });

  test('messages are length-capped', async () => {
    const d = await make('postgres');
    state.pgError = Object.assign(new Error('x'.repeat(5000)), { code: '08006' });
    const e = (await d
      .query({ sql: 'x', params: [] }, { timeoutMs: 1 })
      .catch((x: unknown) => x)) as Error;
    expect(e.message.length).toBeLessThanOrEqual(300);
  });
});

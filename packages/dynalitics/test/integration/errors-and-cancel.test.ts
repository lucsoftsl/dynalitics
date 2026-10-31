import { afterEach, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { adapterDriverFactory } from '../helpers/adapters.js';

const createDriver = await adapterDriverFactory();
import { DriverError } from '../../src/driver/types.js';
import type { Logger } from '../../src/logger.js';
import type { Dialect } from '../../src/model/types.js';
import { createRedactor } from '../../src/redact.js';
import type { Dynalitics, ErrorInfo } from '../../src/types.js';
import { ADAPTERS, ENABLED, setupFixture, type Fixture } from './support.js';

const CANARY_EMAIL = 'jane.canary@example.com';
const CANARY_NAME = 'canary-name-xyz';
const CANARY_NUMBER = '987654';

function capture() {
  const logs: string[] = [];
  const errors: ErrorInfo[] = [];
  const logger: Logger = {
    info: (m) => void logs.push(m),
    warn: (m) => void logs.push(m),
    error: (m) => void logs.push(m),
  };
  return { logs, errors, logger, onError: (e: ErrorInfo) => void errors.push(e) };
}

interface DataCase {
  name: string;
  /** DDL (run by the admin) that makes the table reject the tracked values. */
  alter: (fx: Fixture) => string[];
  visits: Parameters<Dynalitics['track']>[0][];
  /** Expected number of lost rows. */
  failed: number;
  dialects: Dialect[];
}

const col = (fx: Fixture, n: string): string => fx.q(n);
const tbl = (fx: Fixture): string => fx.table.split('.').map(fx.q).join('.');
const base = { consent: true as const, username: CANARY_NAME };

const CASES: DataCase[] = [
  {
    name: 'type mismatch (the value is printed by the database)',
    alter: (fx) => [
      fx.dialect === 'postgres'
        ? `ALTER TABLE ${tbl(fx)} ALTER COLUMN ${col(fx, 'user_id')} TYPE integer USING NULL`
        : `ALTER TABLE ${tbl(fx)} MODIFY ${col(fx, 'user_id')} INT NULL`,
    ],
    visits: [{ pageVisited: '/a', ...base, userId: CANARY_EMAIL, email: CANARY_EMAIL }],
    failed: 1,
    dialects: ['postgres', 'mysql'],
  },
  {
    name: 'unique violation',
    alter: (fx) => [
      `CREATE UNIQUE INDEX ${col(fx, `uq_${fx.bareTable}`)} ON ${tbl(fx)} (${col(fx, 'email')})`,
    ],
    visits: [
      { pageVisited: '/first', ...base, email: CANARY_EMAIL },
      { pageVisited: '/dup', ...base, email: CANARY_EMAIL },
    ],
    failed: 1,
    dialects: ['postgres', 'mysql', 'mssql'],
  },
  {
    name: 'value too long',
    alter: (fx) => [
      fx.dialect === 'postgres'
        ? `ALTER TABLE ${tbl(fx)} ALTER COLUMN ${col(fx, 'email')} TYPE varchar(5)`
        : fx.dialect === 'mysql'
          ? `ALTER TABLE ${tbl(fx)} MODIFY ${col(fx, 'email')} VARCHAR(5) NULL`
          : `ALTER TABLE ${tbl(fx)} ALTER COLUMN ${col(fx, 'email')} NVARCHAR(5) NULL`,
    ],
    visits: [{ pageVisited: '/a', ...base, email: CANARY_EMAIL }],
    failed: 1,
    dialects: ['postgres', 'mysql', 'mssql'],
  },
  {
    name: 'NOT NULL violation (the failing row is printed by the database)',
    alter: (fx) => [
      fx.dialect === 'postgres'
        ? `ALTER TABLE ${tbl(fx)} ALTER COLUMN ${col(fx, 'email')} SET NOT NULL`
        : fx.dialect === 'mysql'
          ? `ALTER TABLE ${tbl(fx)} MODIFY ${col(fx, 'email')} VARCHAR(320) NOT NULL`
          : `ALTER TABLE ${tbl(fx)} ALTER COLUMN ${col(fx, 'email')} NVARCHAR(320) NOT NULL`,
    ],
    visits: [{ pageVisited: '/a', ...base }],
    failed: 1,
    dialects: ['postgres', 'mysql', 'mssql'],
  },
  {
    name: 'numeric out of range',
    alter: (fx) => [
      fx.dialect === 'postgres'
        ? `ALTER TABLE ${tbl(fx)} ALTER COLUMN ${col(fx, 'user_id')} TYPE smallint USING NULL`
        : `ALTER TABLE ${tbl(fx)} MODIFY ${col(fx, 'user_id')} SMALLINT NULL`,
    ],
    visits: [{ pageVisited: '/a', ...base, userId: Number(CANARY_NUMBER) }],
    failed: 1,
    dialects: ['postgres', 'mysql'],
  },
];

describe.each(ENABLED)(
  'F-02: visitor values never leave through error reporting: %s',
  (dialect) => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      await Promise.allSettled(cleanups.splice(0).map((f) => f()));
    });

    test.each(CASES.filter((c) => c.dialects.includes(dialect)))('$name', async (c) => {
      const fx = await setupFixture(dialect, {});
      cleanups.push(() => fx.cleanup());
      for (const stmt of c.alter(fx)) await fx.run(stmt);
      const cap = capture();
      const dyn = await createDynalitics({
        adapter: ADAPTERS[dialect],
        connection: { writer: { connectionString: fx.writerUrl } },
        table: fx.table,
        validateOnStart: 'skip', // the table was deliberately altered
        queue: { retry: { attempts: 1 } },
        logger: cap.logger,
        onError: cap.onError,
      });
      cleanups.push(() => dyn.close().then(() => undefined));
      for (const v of c.visits) await dyn.track(v);
      const res = await dyn.flush();
      expect(res.failed).toBe(c.failed);

      const failure = cap.errors.find((e) => e.code === 'insert_failed');
      expect(failure, 'the failure must be reported').toBeDefined();
      expect(failure?.cause?.message).toMatch(/^data or constraint error/);
      const everything = JSON.stringify([cap.errors, cap.logs, dyn.stats()]);
      for (const secret of [CANARY_EMAIL, 'canary', CANARY_NAME, CANARY_NUMBER]) {
        expect(everything, `leaked ${secret}`).not.toContain(secret);
      }
    });
  },
);

/** SQL that sleeps 30 s, and a query that counts server sessions currently running it. */
const SLEEP: Record<Dialect, { run: string; count: string }> = {
  postgres: {
    run: 'SELECT pg_sleep(30)',
    count:
      "SELECT COUNT(*) AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%pg_sleep(30)%' AND query NOT LIKE '%pg_stat_activity%'",
  },
  mysql: {
    run: 'SELECT SLEEP(30)',
    count:
      "SELECT COUNT(*) AS n FROM information_schema.processlist WHERE info LIKE '%SLEEP(30)%' AND info NOT LIKE '%processlist%'",
  },
  mssql: {
    run: "WAITFOR DELAY '00:00:30'",
    count:
      "SELECT COUNT(*) AS n FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE t.text LIKE '%WAITFOR DELAY%00:00:30%' AND t.text NOT LIKE '%dm_exec_requests%'",
  },
};

describe.each(ENABLED)('F-05: a timed-out read leaves no server session running: %s', (dialect) => {
  test('a 30 s sleep with a 1 s deadline is cancelled on the SERVER within 2 s, and the pool stays usable', async () => {
    const fx = await setupFixture(dialect, {});
    const reader = await createDriver(dialect, {
      credential: { connectionString: fx.readerUrl }, // the real SELECT-only role
      max: 2,
      connectTimeoutMs: 10_000,
      redact: createRedactor([]),
    });
    try {
      const started = Date.now();
      const err = await reader
        .query({ sql: SLEEP[dialect].run, params: [] }, { timeoutMs: 1000 })
        .catch((e: unknown) => e);
      if (dialect === 'mysql') {
        // MySQL ends SLEEP() at the hint's deadline by returning 1 instead of raising an error; either way it stops.
        expect(err instanceof DriverError ? err.timeout : Array.isArray(err)).toBe(true);
      } else {
        expect(err).toBeInstanceOf(DriverError);
        expect((err as DriverError).timeout).toBe(true);
      }
      expect(Date.now() - started).toBeLessThan(5000); // the call settles shortly after the deadline, not after 30 s

      let sessions = Number.POSITIVE_INFINITY;
      for (let waited = 0; waited <= 2000 && sessions !== 0; waited += 200) {
        const rows = await fx.admin.query(
          { sql: SLEEP[dialect].count, params: [] },
          { timeoutMs: 10_000 },
        );
        sessions = Number(rows[0]?.['n']);
        if (sessions !== 0) await new Promise((r) => setTimeout(r, 200));
      }
      expect(sessions, 'the sleeping query must be gone from the server').toBe(0);

      const after = await reader.query(
        { sql: dialect === 'mssql' ? 'SELECT 1 AS ok' : 'SELECT 1 AS ok', params: [] },
        { timeoutMs: 5000 },
      );
      expect(Number(after[0]?.['ok'])).toBe(1);
    } finally {
      await reader.close();
      await fx.cleanup();
    }
  });
});

describe.each(ENABLED.filter((d) => d === 'mysql'))(
  'F-05: a heavy MySQL scan is killed by the server hint and reported as a timeout: %s',
  (dialect) => {
    test('MAX_EXECUTION_TIME ends a runaway SELECT; the error is a timeout and no session remains', async () => {
      const fx = await setupFixture(dialect, {});
      const reader = await createDriver(dialect, {
        credential: { connectionString: fx.readerUrl },
        max: 2,
        connectTimeoutMs: 10_000,
        redact: createRedactor([]),
      });
      const heavy =
        'SELECT COUNT(*) AS n FROM information_schema.columns a, information_schema.columns b, information_schema.columns c, information_schema.columns d';
      try {
        const started = Date.now();
        const err = await reader
          .query({ sql: heavy, params: [] }, { timeoutMs: 1000 })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DriverError);
        expect((err as DriverError).timeout).toBe(true);
        expect(Date.now() - started).toBeLessThan(5000);
        let sessions = Number.POSITIVE_INFINITY;
        for (let waited = 0; waited <= 2000 && sessions !== 0; waited += 200) {
          const rows = await fx.admin.query(
            {
              sql: "SELECT COUNT(*) AS n FROM information_schema.processlist WHERE info LIKE '%information_schema.columns d%' AND info NOT LIKE '%processlist%'",
              params: [],
            },
            { timeoutMs: 10_000 },
          );
          sessions = Number(rows[0]?.['n']);
          if (sessions !== 0) await new Promise((r) => setTimeout(r, 200));
        }
        expect(sessions).toBe(0);
      } finally {
        await reader.close();
        await fx.cleanup();
      }
    });
  },
);

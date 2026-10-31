import { randomBytes } from 'node:crypto';
import { createDriver } from '../../src/driver/index.js';
import type { Driver } from '../../src/driver/types.js';
import { createRedactor } from '../../src/redact.js';
import type { Dialect, SchemaConfig } from '../../src/model/types.js';
import { generateGrants, generateSql } from '../../src/schema/index.js';

// Throw-away credentials of the docker/compose.yml test containers (127.0.0.1 only). Override with env vars.
const ADMIN_URL: Record<Dialect, string> = {
  postgres:
    process.env['DYNALITICS_TEST_PG_URL'] ??
    'postgres://dyn_admin:dyn_test_pw_1@127.0.0.1:55432/dynalitics_test',
  mysql:
    process.env['DYNALITICS_TEST_MYSQL_URL'] ??
    'mysql://root:dyn_test_pw_1@127.0.0.1:53306/dynalitics_test',
  mssql:
    process.env['DYNALITICS_TEST_MSSQL_URL'] ??
    'Server=127.0.0.1,51433;Database=dynalitics_test;User Id=sa;Password=Dyn_test_pw_1!;Encrypt=false;TrustServerCertificate=true',
};
const MSSQL_MASTER_URL = ADMIN_URL.mssql.replace('Database=dynalitics_test', 'Database=master');
const SCHEMA: Record<Dialect, string> = {
  postgres: 'public',
  mysql: 'dynalitics_test',
  mssql: 'dbo',
};

export const ENABLED: readonly Dialect[] = (
  process.env['DYNALITICS_TEST_DIALECTS'] ?? 'postgres,mysql'
)
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Dialect => s === 'postgres' || s === 'mysql' || s === 'mssql');

const hex = (n: number): string => randomBytes(n).toString('hex');
const redact = createRedactor([]);
const open = (dialect: Dialect, url: string, max = 2): Promise<Driver> =>
  createDriver(dialect, {
    credential: { connectionString: url },
    max,
    connectTimeoutMs: 10_000,
    redact,
    requestTimeoutMs: 30_000,
  });

export function userUrl(
  dialect: Dialect,
  user: string,
  password: string,
  mysqlDatabase = 'dynalitics_test',
): string {
  switch (dialect) {
    case 'postgres':
      return `postgres://${user}:${password}@127.0.0.1:55432/dynalitics_test`;
    case 'mysql':
      return `mysql://${user}:${password}@127.0.0.1:53306/${mysqlDatabase}`;
    case 'mssql':
      return `Server=127.0.0.1,51433;Database=dynalitics_test;User Id=${user};Password=${password};Encrypt=false;TrustServerCertificate=true`;
  }
}

export interface Fixture {
  readonly dialect: Dialect;
  /** The schema (database on MySQL) the table lives in. Dropped again by cleanup() when the fixture created it. */
  readonly schemaName: string;
  readonly table: string;
  readonly bareTable: string;
  readonly adminUrl: string;
  readonly writerUrl: string;
  readonly readerUrl: string;
  readonly writerName: string;
  readonly readerName: string;
  readonly admin: Driver;
  run(sql: string): Promise<void>;
  rows(extra?: string): Promise<Record<string, unknown>[]>;
  readonly q: (name: string) => string;
  cleanup(): Promise<void>;
}

/** Names that setupFixture created and that are still present in the database (tables, roles or users). */
export async function leftovers(
  dialect: Dialect,
  names: readonly string[],
): Promise<readonly string[]> {
  if (names.length === 0) return [];
  const admin = await open(dialect, ADMIN_URL[dialect]);
  try {
    const found = new Set<string>();
    const ask = async (sql: string): Promise<void> => {
      for (const row of await admin.query({ sql, params: [] }, { timeoutMs: 30_000 })) {
        found.add(String(row['n']));
      }
    };
    const list = names.map((n) => `'${n}'`).join(', ');
    if (dialect === 'postgres') {
      await ask(`SELECT rolname AS n FROM pg_roles WHERE rolname IN (${list})`);
      await ask(`SELECT tablename AS n FROM pg_tables WHERE tablename IN (${list})`);
      await ask(`SELECT nspname AS n FROM pg_namespace WHERE nspname IN (${list})`);
    } else if (dialect === 'mysql') {
      await ask(`SELECT User AS n FROM mysql.user WHERE User IN (${list})`);
      await ask(
        `SELECT table_name AS n FROM information_schema.tables WHERE table_name IN (${list})`,
      );
      await ask(
        `SELECT schema_name AS n FROM information_schema.schemata WHERE schema_name IN (${list})`,
      );
    } else {
      await ask(`SELECT name AS n FROM sys.server_principals WHERE name IN (${list})`);
      await ask(`SELECT name AS n FROM sys.database_principals WHERE name IN (${list})`);
      await ask(`SELECT name AS n FROM sys.tables WHERE name IN (${list})`);
      await ask(`SELECT name AS n FROM sys.schemas WHERE name IN (${list})`);
    }
    return [...found].sort();
  } finally {
    await admin.close();
  }
}

/** Executes a printed script the way a human would: statement by statement, skipping comments. */
export function statementsOf(script: string): string[] {
  return script
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

async function ensureMssqlDatabase(): Promise<void> {
  const master = await open('mssql', MSSQL_MASTER_URL);
  try {
    await master.query(
      { sql: "IF DB_ID('dynalitics_test') IS NULL CREATE DATABASE dynalitics_test", params: [] },
      { timeoutMs: 60_000 },
    );
  } finally {
    await master.close();
  }
}

const TEARDOWN_ATTEMPTS = 4;
const TEARDOWN_BACKOFF_MS = 50;
// One teardown at a time per process: concurrent DROP ROLE / DROP OWNED on PostgreSQL's shared role catalog
// fails with "tuple concurrently updated" and used to leave roles behind.
let teardownChain: Promise<unknown> = Promise.resolve();

function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const result = teardownChain.then(job);
  teardownChain = result.catch(() => undefined);
  return result;
}

async function withRetry(
  sql: string,
  run: (sql: string) => Promise<void>,
): Promise<Error | undefined> {
  let last: unknown;
  for (let attempt = 1; attempt <= TEARDOWN_ATTEMPTS; attempt++) {
    try {
      await run(sql);
      return undefined;
    } catch (err) {
      last = err;
      // Other test files run in other worker processes and can still collide on the role catalog.
      await new Promise((r) => setTimeout(r, TEARDOWN_BACKOFF_MS * attempt));
    }
  }
  return new Error(`${sql}: ${last instanceof Error ? last.message : String(last)}`);
}

/** Drops the table, then the roles/users. Throws one error listing every statement that still failed after retries. */
function teardown(
  dialect: Dialect,
  run: (sql: string) => Promise<void>,
  q: (name: string) => string,
  table: string,
  accounts: readonly string[],
  ownedSchema?: string,
): Promise<void> {
  return exclusive(async () => {
    const statements = [`DROP TABLE IF EXISTS ${table.split('.').map(q).join('.')}`];
    if (ownedSchema !== undefined) {
      statements.push(
        dialect === 'mysql'
          ? `DROP DATABASE IF EXISTS ${q(ownedSchema)}`
          : `DROP SCHEMA IF EXISTS ${q(ownedSchema)}${dialect === 'postgres' ? ' CASCADE' : ''}`,
      );
    }
    for (const n of accounts) {
      if (dialect === 'postgres') {
        // DROP OWNED fails when the role does not exist, so only run it for roles that do.
        statements.push(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${n}') THEN EXECUTE 'DROP OWNED BY ${q(n)}'; END IF; END $$`,
          `DROP ROLE IF EXISTS ${q(n)}`,
        );
      } else if (dialect === 'mysql') {
        statements.push(`DROP USER IF EXISTS '${n}'@'%'`);
      } else {
        statements.push(
          `DROP USER IF EXISTS ${q(n)}`,
          `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = '${n}') DROP LOGIN ${q(n)}`,
        );
      }
    }
    const failures: Error[] = [];
    for (const sql of statements) {
      const failure = await withRetry(sql, run);
      if (failure !== undefined) failures.push(failure);
    }
    if (failures.length > 0) {
      throw new Error(
        `fixture cleanup failed, test objects are left behind: ${failures.map((f) => f.message).join(' | ')}`,
      );
    }
  });
}

/** Removes a fixture's objects by name with a fresh admin connection (for a fixture whose own connection is gone). */
export async function cleanupByName(
  dialect: Dialect,
  table: string,
  accounts: readonly string[],
  ownedSchema?: string,
): Promise<void> {
  const admin = await open(dialect, ADMIN_URL[dialect]);
  const q = (name: string): string =>
    dialect === 'postgres' ? `"${name}"` : dialect === 'mysql' ? `\`${name}\`` : `[${name}]`;
  try {
    await teardown(
      dialect,
      async (sql) => void (await admin.query({ sql, params: [] }, { timeoutMs: 60_000 })),
      q,
      table,
      accounts,
      ownedSchema,
    );
  } finally {
    await admin.close();
  }
}

export async function setupFixture(
  dialect: Dialect,
  schema: Omit<SchemaConfig, 'table'> = {},
  opts: { withDdl?: boolean; ownSchema?: boolean } = {},
): Promise<Fixture> {
  if (dialect === 'mssql') await ensureMssqlDatabase();
  const admin = await open(dialect, ADMIN_URL[dialect]);
  const bareTable = `dyn_it_${hex(4)}`;
  const schemaName = opts.ownSchema === true ? `dyn_it_s${hex(3)}` : SCHEMA[dialect];
  const table = `${schemaName}.${bareTable}`;
  const writerName = `dyn_w_${hex(4)}`;
  const readerName = `dyn_r_${hex(4)}`;
  const password = `Pw1_${hex(12)}`;
  const ownedSchema = opts.ownSchema === true ? schemaName : undefined;
  const q = (name: string): string =>
    dialect === 'postgres' ? `"${name}"` : dialect === 'mysql' ? `\`${name}\`` : `[${name}]`;
  const run = async (sql: string): Promise<void> =>
    void (await admin.query({ sql, params: [] }, { timeoutMs: 60_000 }));

  const full: SchemaConfig = { table, ...schema };
  const sql = generateSql({
    dialect,
    schema: full,
    grants: { writerRole: writerName, readerRole: readerName },
  });

  if (dialect === 'postgres') {
    // Same shared-catalog contention as the teardown: one role statement at a time, retried.
    await exclusive(async () => {
      for (const n of [writerName, readerName]) {
        const failure = await withRetry(`CREATE ROLE ${q(n)} LOGIN PASSWORD '${password}'`, run);
        if (failure !== undefined) throw new Error('fixture setup failed: could not create a role');
      }
    });
  } else if (dialect === 'mysql') {
    await run(`CREATE USER '${writerName}'@'%' IDENTIFIED BY '${password}'`);
    await run(`CREATE USER '${readerName}'@'%' IDENTIFIED BY '${password}'`);
  } else {
    for (const n of [writerName, readerName]) {
      await run(`CREATE LOGIN ${q(n)} WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
      await run(`CREATE USER ${q(n)} FOR LOGIN ${q(n)}`);
    }
  }
  if (opts.ownSchema === true) {
    await run(
      dialect === 'mysql' ? `CREATE DATABASE ${q(schemaName)}` : `CREATE SCHEMA ${q(schemaName)}`,
    );
  }
  if (opts.withDdl !== false) {
    await run(sql.createTable.replace(/;$/, ''));
    for (const idx of sql.indexes) await run(idx.replace(/;$/, ''));
    for (const g of statementsOf(sql.grants.join('\n'))) await run(g);
  }

  return {
    dialect,
    schemaName,
    table,
    bareTable,
    admin,
    writerName,
    readerName,
    q,
    run,
    adminUrl: ADMIN_URL[dialect],
    writerUrl: userUrl(dialect, writerName, password, schemaName),
    readerUrl: userUrl(dialect, readerName, password, schemaName),
    async rows(extra = '') {
      const rows = await admin.query(
        { sql: `SELECT * FROM ${table.split('.').map(q).join('.')} ${extra}`, params: [] },
        { timeoutMs: 30_000 },
      );
      return rows.map((r) => ({ ...r }));
    },
    async cleanup() {
      try {
        await teardown(dialect, run, q, table, [writerName, readerName], ownedSchema);
      } finally {
        await admin.close().catch(() => undefined); // closing a pool that is already closed is not a leak
      }
    },
  };
}

/** Normalises driver differences when reading rows back. */
export function norm(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if ('consent' in out) out['consent'] = Boolean(out['consent']);
  if ('is_first_visit' in out && out['is_first_visit'] !== null)
    out['is_first_visit'] = Boolean(out['is_first_visit']);
  const ts = out['visited_at'];
  if (ts instanceof Date) out['visited_at'] = ts.toISOString();
  else if (typeof ts === 'string')
    out['visited_at'] = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`).toISOString();
  if (typeof out['custom'] === 'string') out['custom'] = JSON.parse(out['custom']) as unknown;
  return out;
}

/**
 * A table that somebody else created: the caller supplies the DDL, the fixture adds the two least-privilege
 * accounts and the GRANTs that `dynalitics sql --grants-only` prints for that table. cleanup() removes everything.
 */
export async function setupLegacyTable(
  dialect: Dialect,
  ddl: (qualifiedTable: string, q: (name: string) => string) => readonly string[],
  opts: { ownSchema?: boolean } = {},
): Promise<Fixture> {
  const fx = await setupFixture(dialect, {}, { withDdl: false, ...opts });
  try {
    const qualified = fx.table.split('.').map(fx.q).join('.');
    for (const statement of ddl(qualified, fx.q)) await fx.run(statement);
    const grants = generateGrants({
      dialect,
      table: fx.table,
      writerRole: fx.writerName,
      readerRole: fx.readerName,
    });
    for (const g of statementsOf(grants.join('\n'))) await fx.run(g);
    return fx;
  } catch (err) {
    await fx.cleanup();
    throw err;
  }
}

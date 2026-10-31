import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDynaliticsWith, type CreateDeps } from '../../src/create.js';
import { DynaliticsSchemaError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import type { Dialect } from '../../src/model/types.js';
import type { DynaliticsConfig } from '../../src/types.js';
import { fakeDriver, type FakeDriver } from '../helpers/fake-driver.js';

interface Col {
  name: string;
  data_type: string;
  max_length?: number | null;
  is_nullable?: boolean;
  has_default?: boolean;
  dt_precision?: number | null;
}
const catalog = (cols: Col[], schema: string) =>
  cols.map((c) => ({
    name: c.name,
    data_type: c.data_type,
    max_length: c.max_length ?? null,
    is_nullable: c.is_nullable ?? true,
    has_default: c.has_default ?? false,
    is_generated: false,
    dt_precision: c.dt_precision ?? null,
    table_type: 'BASE TABLE',
    schema_name: schema,
  }));

const PG_LEGACY: Col[] = [
  { name: 'viewed_at', data_type: 'timestamp', is_nullable: false },
  { name: 'gdpr_ok', data_type: 'int2', is_nullable: false },
  { name: 'url', data_type: 'varchar', max_length: 200, is_nullable: false },
  { name: 'account_id', data_type: 'varchar', max_length: 40 },
  { name: 'legacy_note', data_type: 'text' },
];
const MAP = {
  timestamp: 'viewed_at',
  consent: 'gdpr_ok',
  pageVisited: 'url',
  userId: 'account_id',
};

function world(dialect: Dialect, cols: Col[], opts: { timeDiff?: string; schema?: string } = {}) {
  const drivers: FakeDriver[] = [];
  const logs: string[] = [];
  const deps: CreateDeps = {
    createDriver: () => {
      const d = fakeDriver((q) => {
        if (q.sql.includes('TIMEDIFF')) return [{ diff: opts.timeDiff ?? '00:00:00' }];
        if (q.sql.includes('information_schema')) return catalog(cols, opts.schema ?? 'legacy');
        return [];
      });
      drivers.push(d);
      return Promise.resolve(d);
    },
    now: () => new Date(Date.now()),
    sleep: () => Promise.resolve(),
    random: () => 0,
  };
  const logger: Logger = {
    info: (m) => void logs.push(`info: ${m}`),
    warn: (m) => void logs.push(`warn: ${m}`),
    error: (m) => void logs.push(`error: ${m}`),
  };
  const config = (extra: Partial<DynaliticsConfig> = {}): DynaliticsConfig => ({
    dialect,
    connection: {
      writer: { connectionString: 'x://w@h/db' },
      reader: { connectionString: 'x://r@h/db' },
    },
    table: 'sales.page_views',
    tableMode: 'existing',
    columns: MAP,
    logger,
    ...extra,
  });
  const statements = () => drivers.flatMap((d) => d.calls.map((c) => c.sql));
  return { drivers, logs, deps, config, statements };
}
const inserts = (w: ReturnType<typeof world>) =>
  w.drivers.flatMap((d) => d.calls.filter((c) => c.sql.startsWith('INSERT')));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('startup with tableMode "existing"', () => {
  test('a legacy PostgreSQL table starts, warns about the naive timestamp and says what it adopted', async () => {
    const w = world('postgres', PG_LEGACY);
    const dyn = await createDynaliticsWith(w.config(), w.deps);
    expect(w.logs.some((l) => l.startsWith('warn:') && l.includes('has no time zone'))).toBe(true);
    expect(w.logs.some((l) => l.includes('tableMode "existing"'))).toBe(true);
    expect(w.logs.some((l) => l.includes('"url"') && l.includes('200'))).toBe(true);
    expect(dyn.model.mode).toBe('existing');
    expect(dyn.model.columns.map((c) => c.physicalType)).toEqual([
      'timestamp',
      'int2',
      'varchar',
      'varchar',
    ]);
    await dyn.close();
  });

  test('writes into the schema-qualified table, binds consent as 1/0 and cuts the page to the real length', async () => {
    const w = world('postgres', PG_LEGACY);
    const dyn = await createDynaliticsWith(w.config(), w.deps);
    await dyn.track({ pageVisited: `/${'p'.repeat(300)}`, consent: true, userId: 'u-1' });
    await dyn.track({ pageVisited: '/b', consent: false });
    await dyn.flush();
    const [first] = inserts(w);
    expect(first?.sql).toContain(
      'INSERT INTO "sales"."page_views" ("viewed_at", "gdpr_ok", "url", "account_id")',
    );
    expect(first?.params[1]).toBe(1);
    expect(String(first?.params[2])).toHaveLength(200);
    expect(first?.params[3]).toBe('u-1');
    expect(first?.params[5]).toBe(0);
    expect(first?.params[6]).toBe('/b');
    expect(first?.params[7]).toBeNull(); // denied: no user id
    await dyn.close();
  });

  test('an unmapped NOT NULL column without a default stops startup; the fixes are printed, never run', async () => {
    const w = world('postgres', [
      ...PG_LEGACY,
      { name: 'created_by', data_type: 'text', is_nullable: false },
    ]);
    const err = await createDynaliticsWith(w.config(), w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynaliticsSchemaError);
    const e = err as DynaliticsSchemaError;
    expect(e.problems.map((p) => p.code)).toEqual(['extra_required_column']);
    expect(e.message).toContain('tableMode "existing"');
    expect(e.message).toContain(
      'Column "created_by" is NOT NULL, has no default and is not mapped',
    );
    expect(e.fixSql.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'))).toEqual([]);
    const ran = w
      .statements()
      .filter((s) => /^\s*(ALTER|CREATE|DROP|GRANT|INSERT|UPDATE|DELETE)/i.test(s));
    expect(ran).toEqual([]);
    expect(w.drivers.every((d) => d.closed > 0)).toBe(true);
  });

  test('a missing mapped column is reported with the columns found and no ADD COLUMN', async () => {
    const w = world(
      'postgres',
      PG_LEGACY.filter((c) => c.name !== 'account_id'),
    );
    const err = (await createDynaliticsWith(w.config(), w.deps).catch(
      (e: unknown) => e,
    )) as DynaliticsSchemaError;
    expect(err.problems[0]?.code).toBe('missing_column');
    expect(err.message).toContain('Columns found: viewed_at, gdpr_ok, url, legacy_note');
    expect(err.fixSql).not.toMatch(/ADD/i);
  });

  test('a table that does not exist in the named schema is a clear error that does not offer to create it', async () => {
    const w = world('postgres', []);
    const err = (await createDynaliticsWith(w.config(), w.deps).catch(
      (e: unknown) => e,
    )) as DynaliticsSchemaError;
    expect(err.problems[0]?.code).toBe('missing_table');
    expect(err.message).toContain('"sales"."page_views"');
    expect(err.message).not.toContain('npx dynalitics sql');
  });

  test('the unmapped roles are listed with what that means for the dashboard', async () => {
    const w = world('postgres', PG_LEGACY);
    await (await createDynaliticsWith(w.config(), w.deps)).close();
    const line = w.logs.find((l) => l.includes('NOT stored'));
    expect(line).toContain('ip, username, email, custom, id');
    expect(line).toContain('recent-visits');
    expect(line).toContain('new-vs-returning uses the user id only');
  });
});

describe('MySQL TIMESTAMP and the session time zone', () => {
  const cols: Col[] = [
    { name: 'viewed_at', data_type: 'timestamp', is_nullable: false, dt_precision: 3 },
    { name: 'gdpr_ok', data_type: 'tinyint', is_nullable: false },
    { name: 'url', data_type: 'varchar', max_length: 255, is_nullable: false },
    { name: 'account_id', data_type: 'varchar', max_length: 40 },
  ];
  test('a UTC session is accepted; the probe ran on every connection that is used', async () => {
    const w = world('mysql', cols);
    await (await createDynaliticsWith(w.config(), w.deps)).close();
    expect(w.drivers.map((d) => d.calls.some((c) => c.sql.includes('TIMEDIFF')))).toEqual([
      true,
      true,
    ]);
  });
  test('a session that is not UTC is a startup problem naming the offset', async () => {
    const w = world('mysql', cols, { timeDiff: '02:00:00' });
    const err = (await createDynaliticsWith(w.config(), w.deps).catch(
      (e: unknown) => e,
    )) as DynaliticsSchemaError;
    expect(err.problems.map((p) => p.code)).toEqual(['timestamp_session_timezone']);
    expect(err.message).toContain('this connection\'s time zone is "+02:00"');
    expect(w.statements().some((s) => /^\s*SET /i.test(s))).toBe(false); // never changes the session
  });
  test('a DATETIME column needs no probe at all', async () => {
    const w = world(
      'mysql',
      cols.map((c) => (c.name === 'viewed_at' ? { ...c, data_type: 'datetime' } : c)),
    );
    await (await createDynaliticsWith(w.config(), w.deps)).close();
    expect(w.statements().some((s) => s.includes('TIMEDIFF'))).toBe(false);
  });
});

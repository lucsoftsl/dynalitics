import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDynaliticsWith, type CreateDeps } from '../../src/create.js';
import {
  DynaliticsConfigError,
  DynaliticsConnectionError,
  DynaliticsSchemaError,
} from '../../src/errors.js';
import { getDialect } from '../../src/dialect/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { DriverOptions } from '../../src/driver/types.js';
import type { Logger } from '../../src/logger.js';
import type { DynaliticsConfig, ErrorInfo } from '../../src/types.js';
import { stubAdapter } from '../helpers/adapters.js';
import { fakeDriver, transientError, type FakeDriver } from '../helpers/fake-driver.js';
import { perfectColumns } from '../helpers/perfect-table.js';

const CANARY = 'Sup3rS3cretPw';
const model = buildColumnModel({
  table: 'public.events',
  customFields: { plan: { type: 'string', maxLength: 32, personal: false } },
});
const catalogRows = (cols = perfectColumns('postgres', model), schema = 'public') =>
  cols.map((c) => ({
    name: c.name,
    data_type: c.dataType,
    max_length: c.maxLength,
    is_nullable: c.nullable,
    has_default: c.hasDefault,
    is_generated: c.generated,
    dt_precision: c.precision,
    table_type: c.tableType,
    schema_name: schema,
  }));

function world(
  opts: {
    cols?: ReturnType<typeof perfectColumns>;
    failConnect?: boolean;
    privileges?: string[];
    schema?: string;
  } = {},
) {
  const drivers: { cred: unknown; driver: FakeDriver; opts: DriverOptions }[] = [];
  const logs: string[] = [];
  const errors: ErrorInfo[] = [];
  const logger: Logger = {
    info: (m) => void logs.push(`info: ${m}`),
    warn: (m) => void logs.push(`warn: ${m}`),
    error: (m) => void logs.push(`error: ${m}`),
  };
  const deps: CreateDeps = {
    createDriver: (_d, o) => {
      const driver = fakeDriver((q) => {
        if (opts.failConnect && q.sql === 'SELECT 1')
          throw Object.assign(new Error(`connect failed to postgres://app:${CANARY}@h/db`), {
            code: 'ECONNREFUSED',
          });
        if (q.sql.includes('information_schema')) return catalogRows(opts.cols, opts.schema);
        if (q.sql.includes('has_table_privilege'))
          return (opts.privileges ?? ['INSERT']).map((privilege) => ({ privilege }));
        return [];
      });
      drivers.push({ cred: o.credential, driver, opts: o });
      return Promise.resolve(driver);
    },
    now: () => new Date(Date.now()),
    sleep: () => Promise.resolve(),
    random: () => 0,
  };
  const config = (extra: Partial<DynaliticsConfig> = {}): DynaliticsConfig => ({
    adapter: stubAdapter('postgres'),
    connection: {
      writer: { connectionString: `postgres://w:${CANARY}@h/db` },
      reader: { connectionString: `postgres://r:${CANARY}x@h/db` },
    },
    table: 'public.events',
    customFields: { plan: { type: 'string', maxLength: 32, personal: false } },
    logger,
    onError: (e) => void errors.push(e),
    ...extra,
  });
  return { drivers, logs, errors, deps, config };
}
const inserts = (d: FakeDriver) => d.calls.filter((c) => c.sql.startsWith('INSERT'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('startup', () => {
  test('rejects invalid config synchronously-ish with all issues and no secrets', async () => {
    const w = world();
    const err = await createDynaliticsWith(
      {
        adapter: { dialect: 'nope' },
        connection: { connectionString: `x://u:${CANARY}@h/d`, pool: {} },
        table: 5,
      } as never,
      w.deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynaliticsConfigError);
    expect((err as DynaliticsConfigError).issues.length).toBeGreaterThan(2);
    expect((err as Error).message).not.toContain(CANARY);
    expect(w.drivers).toHaveLength(0);
  });

  test('two credentials: separate drivers, structure is read through the READER, writer only gets checks', async () => {
    const w = world();
    const dyn = await createDynaliticsWith(w.config(), w.deps);
    expect(w.drivers).toHaveLength(2);
    const [writer, reader] = w.drivers;
    expect(reader!.driver.calls.some((c) => c.sql.includes('information_schema'))).toBe(true);
    expect(writer!.driver.calls.some((c) => c.sql.includes('information_schema'))).toBe(false);
    expect(writer!.opts.max).toBe(4);
    expect(reader!.opts.max).toBe(2);
    expect(dyn.capabilities).toEqual({ canWrite: true, canRead: true });
    expect(w.logs.filter((l) => l.includes('ONE database credential'))).toEqual([]);
  });

  test('single credential: one shared driver and a clear warning (silenced by acknowledgeSingleCredential)', async () => {
    const w = world();
    await createDynaliticsWith(
      w.config({ connection: { connectionString: `postgres://u:${CANARY}@h/db` } }),
      w.deps,
    );
    expect(w.drivers).toHaveLength(1);
    expect(
      w.logs.some((l) =>
        l.startsWith(
          'warn: dynalitics is using ONE database credential for both writing and reading',
        ),
      ),
    ).toBe(true);
    const w2 = world();
    await createDynaliticsWith(
      w2.config({
        connection: { connectionString: 'postgres://u:pw12345@h/db' },
        acknowledgeSingleCredential: true,
      }),
      w2.deps,
    );
    expect(w2.logs.some((l) => l.includes('ONE database credential'))).toBe(false);
  });

  test('writer-only introspects through the writer; reader-only cannot track', async () => {
    const w = world();
    const dyn = await createDynaliticsWith(
      w.config({ connection: { writer: { connectionString: 'postgres://w:pw12345@h/db' } } }),
      w.deps,
    );
    expect(w.drivers[0]!.driver.calls.some((c) => c.sql.includes('information_schema'))).toBe(true);
    expect(dyn.capabilities).toEqual({ canWrite: true, canRead: false });

    const w2 = world();
    const ro = await createDynaliticsWith(
      w2.config({ connection: { reader: { connectionString: 'postgres://r:pw12345@h/db' } } }),
      w2.deps,
    );
    expect(await ro.track({ pageVisited: '/a', consent: true })).toEqual({
      status: 'rejected',
      issues: ['no writer credential configured'],
    });
    expect(ro.capabilities).toEqual({ canWrite: false, canRead: true });
  });

  test('schema mismatch throws DynaliticsSchemaError with printed fixes, and closes every driver', async () => {
    const cols = perfectColumns('postgres', model).filter((c) => c.name !== 'email');
    const w = world({ cols });
    const err = await createDynaliticsWith(w.config(), w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynaliticsSchemaError);
    const e = err as DynaliticsSchemaError;
    expect(e.problems.map((p) => p.code)).toEqual(['missing_column']);
    expect(e.fixSql).toMatch(/ALTER TABLE "public"."events" ADD COLUMN "email" varchar\(320\);/);
    expect(e.message).toContain('Nothing here has been executed.');
    expect(w.drivers.every((d) => d.driver.closed === 1)).toBe(true);
    // nothing but SELECTs ever ran: the library never executes DDL
    for (const d of w.drivers) for (const c of d.driver.calls) expect(c.sql).toMatch(/^\s*SELECT/i);
  });

  test('a missing table prints CREATE TABLE', async () => {
    const w = world({ cols: [] });
    const err = (await createDynaliticsWith(w.config(), w.deps).catch(
      (e: unknown) => e,
    )) as DynaliticsSchemaError;
    expect(err.problems[0]?.code).toBe('missing_table');
    expect(err.fixSql).toContain('CREATE TABLE "public"."events"');
  });

  test('writer-only with an empty catalog explains that the structure cannot be checked', async () => {
    const w = world({ cols: [] });
    const err = (await createDynaliticsWith(
      w.config({ connection: { writer: { connectionString: 'postgres://w:pw12345@h/db' } } }),
      w.deps,
    ).catch((e: unknown) => e)) as DynaliticsSchemaError;
    expect(err.problems[0]?.code).toBe('identity_not_discoverable');
    expect(err.message).toContain('Add a reader credential');
  });

  test('connection failures become DynaliticsConnectionError with the secret redacted everywhere', async () => {
    const w = world({ failConnect: true });
    const err = await createDynaliticsWith(w.config(), w.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynaliticsConnectionError);
    const dump =
      JSON.stringify(err, Object.getOwnPropertyNames(err)) +
      String((err as Error).stack) +
      w.logs.join('\n');
    expect(dump).not.toContain(CANARY);
    expect((err as Error).message).toContain('Could not connect');
    expect(w.drivers.every((d) => d.driver.closed === 1)).toBe(true);
  });

  test('warnings and the unmapped-role info line are logged, privilege warnings are advisory', async () => {
    const w = world({ privileges: ['INSERT', 'DELETE'] });
    await createDynaliticsWith(w.config({ columns: { email: false, ip: false } }), w.deps);
    expect(w.logs).toContain(
      'info: these roles are not mapped to a column, so this data is NOT stored: ip, email. Effects on the dashboard: new-vs-returning uses the user id only; recent-visits shows null for email.',
    );
    expect(
      w.logs.some((l) =>
        l.startsWith(
          'warn: The writer credential seems to have more privileges than dynalitics needs (DELETE)',
        ),
      ),
    ).toBe(true);
  });

  test('validateOnStart "skip" does not touch the database at all, and says so', async () => {
    const w = world();
    await createDynaliticsWith(w.config({ validateOnStart: 'skip' }), w.deps);
    for (const d of w.drivers) expect(d.driver.calls).toEqual([]);
    expect(w.logs.some((l) => l.includes('validateOnStart is "skip"'))).toBe(true);
  });
});

describe('track()', () => {
  async function started(extra: Partial<DynaliticsConfig> = {}) {
    const w = world();
    const dyn = await createDaemon(w, extra);
    return { w, dyn, writer: w.drivers[0]!.driver };
  }
  async function createDaemon(w: ReturnType<typeof world>, extra: Partial<DynaliticsConfig>) {
    return createDynaliticsWith(w.config(extra), w.deps);
  }

  test('queues, batches and writes a consented visit with a UTC timestamp taken at track() time', async () => {
    const { dyn, writer } = await started();
    const r = await dyn.track({
      pageVisited: '/pricing?x=1',
      consent: true,
      ip: '203.0.113.77',
      userId: 'u1',
      custom: { plan: 'pro' },
    });
    expect(r).toEqual({ status: 'queued' });
    await dyn.flush();
    const [insert] = inserts(writer);
    expect(insert?.sql).toContain('INSERT INTO "public"."events"');
    expect(insert?.params).toEqual([
      '2026-10-30T12:00:00.000Z',
      true,
      '/pricing',
      '203.0.113.0',
      'u1',
      null,
      null,
      '{"plan":"pro"}',
    ]);
    expect(dyn.stats()).toMatchObject({ queued: 1, written: 1, failed: 0, queueLength: 0 });
  });

  test('consent denied (or missing) stores ONLY page, timestamp and consent=false', async () => {
    const { dyn, writer } = await started();
    await dyn.track({
      pageVisited: '/a',
      consent: false,
      ip: '1.2.3.4',
      userId: 'u',
      username: 'n',
      email: 'e@x',
      custom: { plan: 'pro' },
    });
    await dyn.track({ pageVisited: '/b', ip: '1.2.3.4', email: 'e@x' });
    await dyn.flush();
    const rows = inserts(writer)
      .flatMap((c) => [c.params.slice(0, 8), c.params.slice(8, 16)])
      .filter((r) => r.length === 8);
    expect(rows[0]).toEqual([
      '2026-10-30T12:00:00.000Z',
      false,
      '/a',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(rows[1]).toEqual([
      '2026-10-30T12:00:00.000Z',
      false,
      '/b',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test('invalid input is rejected, reported, counted, and never throws', async () => {
    const { w, dyn, writer } = await started();
    const r = await dyn.track({ pageVisited: '', consent: 'yes' } as never);
    expect(r.status).toBe('rejected');
    expect(await dyn.track(null as never)).toMatchObject({ status: 'rejected' });
    expect(w.errors.map((e) => e.code)).toContain('invalid_visit');
    expect(dyn.stats().rejected).toBe(2);
    await dyn.flush();
    expect(inserts(writer)).toHaveLength(0);
  });

  test('track() never rejects even when a consent resolver, onError or logger explode', async () => {
    const w = world();
    const dyn = await createDynaliticsWith(
      w.config({
        consent: {
          default: () => {
            throw new Error('boom');
          },
        },
        onError: () => {
          throw new Error('onError exploded');
        },
        logger: {
          info() {
            throw new Error('x');
          },
          warn() {
            throw new Error('x');
          },
          error() {
            throw new Error('x');
          },
        },
      }),
      w.deps,
    );
    await expect(dyn.track({ pageVisited: '/a' })).resolves.toEqual({ status: 'queued' });
    await expect(dyn.flush()).resolves.toBeDefined();
  });

  test('repeated notes are throttled (once per minute per key) with a suppressed count', async () => {
    const { w, dyn } = await started();
    for (let n = 0; n < 5; n++) await dyn.track({ pageVisited: '/a' }); // consent_missing x5
    expect(w.errors.filter((e) => e.code === 'consent_missing')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await dyn.track({ pageVisited: '/a' });
    const missing = w.errors.filter((e) => e.code === 'consent_missing');
    expect(missing).toHaveLength(2);
    expect(missing[1]?.count).toBe(4);
  });

  test('insert failures reach onError with a sanitised cause, never the raw error', async () => {
    const { w, dyn, writer } = await started();
    writer.handler = (q) => {
      if (q.sql.startsWith('INSERT')) throw transientError();
      return [];
    };
    await dyn.track({ pageVisited: '/a', consent: true });
    await dyn.flush();
    expect(w.errors[0]).toMatchObject({
      code: 'insert_failed',
      dropped: 1,
      cause: { code: 'ECONNRESET' },
    });
    expect(dyn.stats().failed).toBe(1);
    expect(dyn.stats().lastErrorAt).toBe('2026-10-30T12:00:00.000Z');
  });

  test('write-time first visit (opt-in) fills is_first_visit through the writer and needs an identity', async () => {
    const m = buildColumnModel({ table: 'public.events', firstVisit: { enabled: true } });
    const w = world({ cols: perfectColumns('postgres', m) });
    const dyn = await createDynaliticsWith(
      w.config({ firstVisit: { enabled: true }, customFields: {} }),
      w.deps,
    );
    const writer = w.drivers[0]!.driver;
    writer.handler = (q) => (q.sql.startsWith('SELECT DISTINCT') ? [{ v: 'seen' }] : []);
    await dyn.track({ pageVisited: '/a', consent: true, userId: 'seen' });
    await dyn.track({ pageVisited: '/a', consent: true, userId: 'fresh' });
    await dyn.track({ pageVisited: '/a', consent: true });
    await dyn.track({ pageVisited: '/a', consent: false, userId: 'seen' });
    await dyn.flush();
    const params = inserts(writer).flatMap((c) => c.params);
    const flags = [0, 1, 2, 3].map((n) => params[n * 9 + 7]);
    expect(flags).toEqual([false, true, null, null]);
    expect(dyn.stats().lruSize).toBe(2);
  });
});

describe('close()', () => {
  test('flushes, closes each driver once, is idempotent, and later track() is dropped', async () => {
    const w = world();
    const dyn = await createDynaliticsWith(w.config(), w.deps);
    await dyn.track({ pageVisited: '/a', consent: true });
    const [a, b] = await Promise.all([dyn.close(), dyn.close()]);
    expect(a).toEqual(b);
    expect(a.written).toBe(1);
    await dyn.close();
    expect(w.drivers.map((d) => d.driver.closed)).toEqual([1, 1]);
    expect(await dyn.track({ pageVisited: '/b', consent: true })).toEqual({
      status: 'dropped',
      reason: 'closed',
    });
  });

  test('a single shared driver is closed once', async () => {
    const w = world();
    const dyn = await createDynaliticsWith(
      w.config({
        connection: { connectionString: 'postgres://u:pw12345@h/db' },
        acknowledgeSingleCredential: true,
      }),
      w.deps,
    );
    await dyn.close();
    expect(w.drivers[0]!.driver.closed).toBe(1);
  });
});

describe('model access', () => {
  test('exposes the column model and table', async () => {
    const w = world();
    const dyn = await createDaemonModel(w);
    expect(dyn.model.columns.map((c) => c.name)).toContain('visited_at');
    expect(dyn.table).toEqual({ schema: 'public', name: 'events' });
    expect(getDialect('postgres').name).toBe('postgres');
  });
  const createDaemonModel = (w: ReturnType<typeof world>) =>
    createDynaliticsWith(w.config(), w.deps);
});

describe('F-36: the schema is resolved once at startup and used for every later statement', () => {
  test('a table configured without a schema is qualified with the schema the catalog found it in', async () => {
    const w = world({ schema: 'tenant1' });
    const dyn = await createDynaliticsWith(w.config({ table: 'events' }), w.deps);
    expect(dyn.table).toEqual({ schema: 'tenant1', name: 'events' });
    expect(dyn.model.table).toEqual({ schema: 'tenant1', name: 'events' });
    await dyn.track({ pageVisited: '/a', consent: true });
    await dyn.flush();
    const writer = w.drivers[0]!.driver;
    expect(writer.calls.find((c) => c.sql.startsWith('INSERT'))?.sql).toContain(
      'INSERT INTO "tenant1"."events"',
    );
    expect(w.logs.some((l) => l.includes('"tenant1"."events"'))).toBe(true);
  });

  test('an explicit schema is never overridden', async () => {
    const w = world({ schema: 'somewhere_else' });
    const dyn = await createDynaliticsWith(w.config({ table: 'public.events' }), w.deps);
    expect(dyn.table).toEqual({ schema: 'public', name: 'events' });
  });
});

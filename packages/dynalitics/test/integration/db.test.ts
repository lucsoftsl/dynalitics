import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { DynaliticsConnectionError, DynaliticsSchemaError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import type { Dynalitics, DynaliticsConfig, ErrorInfo } from '../../src/types.js';
import { ENABLED, norm, setupFixture, statementsOf, type Fixture } from './support.js';

const evil = "x'); DROP TABLE victim; --";
// ';' starts a matrix parameter in a path and is stripped by design, so the path variant has none
const evilPath = "x') DROP TABLE victim --";
const customFields = {
  plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
  campaign: { type: 'string', maxLength: 64 },
} as const;

function capture() {
  const logs: string[] = [];
  const errors: ErrorInfo[] = [];
  const logger: Logger = {
    info: (m) => void logs.push(`info: ${m}`),
    warn: (m) => void logs.push(`warn: ${m}`),
    error: (m) => void logs.push(`error: ${m}`),
  };
  return { logs, errors, logger, onError: (e: ErrorInfo) => void errors.push(e) };
}

describe.each(ENABLED)('integration: %s', (dialect) => {
  let fx: Fixture;
  const open: Dynalitics[] = [];
  const start = async (extra: Partial<DynaliticsConfig> = {}, cap = capture()) => {
    const dyn = await createDynalitics({
      dialect,
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      customFields,
      ip: { mode: 'truncate' },
      logger: cap.logger,
      onError: cap.onError,
      ...extra,
    });
    open.push(dyn);
    return { dyn, cap };
  };

  beforeAll(async () => {
    fx = await setupFixture(dialect, { customFields });
  });
  afterAll(async () => {
    await Promise.allSettled(open.map((d) => d.close()));
    await fx.cleanup();
  });

  test('writer/reader roles from the GENERATED grants: start cleanly, no privilege warnings, track -> flush -> rows', async () => {
    const { dyn, cap } = await start();
    expect(cap.logs.filter((l) => l.startsWith('warn:'))).toEqual([]);
    await dyn.track({
      pageVisited: '/pricing?token=secret#x',
      consent: true,
      ip: '203.0.113.77',
      userId: 'u_42',
      username: 'jane',
      email: 'jane@example.com',
      custom: { plan: 'pro', campaign: 'fall' },
    });
    await dyn.track({
      pageVisited: '/pricing',
      consent: false,
      ip: '203.0.113.78',
      userId: 'u_43',
      email: 'x@y',
      custom: { plan: 'free', campaign: 'spring' },
    });
    await dyn.track({ pageVisited: '/about' });
    expect(await dyn.flush()).toEqual({ written: 3, failed: 0, timedOut: false });
    const rows = (await fx.rows('ORDER BY id')).map(norm);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      consent: true,
      page_visited: '/pricing',
      ip_address: '203.0.113.0',
      user_id: 'u_42',
      username: 'jane',
      email: 'jane@example.com',
      custom: { plan: 'pro', campaign: 'fall' },
    });
    expect(rows[1]).toMatchObject({
      consent: false,
      page_visited: '/pricing',
      ip_address: null,
      user_id: null,
      username: null,
      email: null,
      custom: null, // strict: a denied row keeps nothing but page, time and consent=false
    });
    expect(rows[2]).toMatchObject({ consent: false, page_visited: '/about', custom: null });
    for (const r of rows)
      expect(Math.abs(Date.parse(r['visited_at'] as string) - Date.now())).toBeLessThan(60_000);
  });

  test('the generated writer cannot read and the generated reader cannot write', async () => {
    const { createDriver } = await import('../../src/driver/index.js');
    const { createRedactor } = await import('../../src/redact.js');
    const mk = (url: string) =>
      createDriver(dialect, {
        credential: { connectionString: url },
        max: 1,
        connectTimeoutMs: 10_000,
        redact: createRedactor([]),
      });
    const t = fx.table.split('.').map(fx.q).join('.');
    const writer = await mk(fx.writerUrl);
    const reader = await mk(fx.readerUrl);
    try {
      await expect(
        writer.query({ sql: `SELECT 1 FROM ${t}`, params: [] }, { timeoutMs: 10_000 }),
      ).rejects.toThrow(/denied|permission/i);
      await expect(
        reader.query({ sql: `DELETE FROM ${t}`, params: [] }, { timeoutMs: 10_000 }),
      ).rejects.toThrow(/denied|permission/i);
      await expect(
        reader.query(
          {
            sql: `INSERT INTO ${t} (${fx.q('visited_at')}, ${fx.q('consent')}, ${fx.q('page_visited')}) VALUES (${dialect === 'postgres' ? "now(), true, 'x'" : dialect === 'mysql' ? "NOW(), 1, 'x'" : "SYSUTCDATETIME(), 1, 'x'"})`,
            params: [],
          },
          { timeoutMs: 10_000 },
        ),
      ).rejects.toThrow(/denied|permission/i);
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  test('hostile values, unicode and long strings round-trip verbatim; other tables survive', async () => {
    await fx.run(`CREATE TABLE victim_${fx.bareTable} (id ${dialect === 'mssql' ? 'INT' : 'INT'})`);
    const { dyn } = await start();
    const before = (await fx.rows()).length;
    await dyn.track({
      pageVisited: `/${evilPath}`,
      consent: true,
      userId: evil,
      username: '😀 ünï "quoted" `tick` \\ back',
      email: `${evil}@x`,
      custom: { plan: evil, campaign: '日本語' },
    });
    await dyn.flush();
    const rows = (await fx.rows('ORDER BY id')).map(norm);
    const last = rows[rows.length - 1]!;
    expect(rows).toHaveLength(before + 1);
    expect(last).toMatchObject({
      page_visited: `/${evilPath}`,
      user_id: evil,
      username: '😀 ünï "quoted" `tick` \\ back',
      custom: { plan: evil.slice(0, 32), campaign: '日本語' },
    });
    await fx.run(`DROP TABLE victim_${fx.bareTable}`); // would throw if the injection had dropped it
  });

  test('a mismatching table throws with printed fixes; running the printed live fix makes startup succeed', async () => {
    const q = (n: string) => fx.q(n);
    const t = fx.table.split('.').map(q).join('.');
    await fx.run(`ALTER TABLE ${t} DROP COLUMN ${q('email')}`);
    const err = (await createDynalitics({
      dialect,
      connection: { reader: { connectionString: fx.readerUrl } },
      table: fx.table,
      customFields,
      logger: capture().logger,
    }).catch((e: unknown) => e)) as DynaliticsSchemaError;
    expect(err).toBeInstanceOf(DynaliticsSchemaError);
    expect(err.problems.map((p) => p.code)).toEqual(['missing_column']);
    expect(err.fixSql).toMatch(/ADD (COLUMN )?.*email/);
    for (const stmt of statementsOf(err.fixSql)) await fx.run(stmt);
    const { dyn } = await start();
    await dyn.close();
  });

  test('a missing table prints a CREATE TABLE script that works when a human runs it', async () => {
    const ghost = `${fx.table}_ghost`;
    const cfg = {
      dialect,
      connection: { reader: { connectionString: fx.readerUrl } },
      table: ghost,
      customFields,
      logger: capture().logger,
    } as const;
    const err = (await createDynalitics(cfg).catch((e: unknown) => e)) as DynaliticsSchemaError;
    expect(err.problems[0]?.code).toBe('missing_table');
    for (const stmt of statementsOf(err.fixSql)) await fx.run(stmt);
    try {
      // the script was run by the admin, so the generated writer/reader have no grants on it: use the admin
      const { dyn } = await start({
        table: ghost,
        connection: { connectionString: fx.adminUrl },
        acknowledgeSingleCredential: true,
      });
      await dyn.close();
    } finally {
      await fx.run(`DROP TABLE ${ghost.split('.').map(fx.q).join('.')}`);
    }
  });

  test('a wrong password is a redacted DynaliticsConnectionError, closing what it opened', async () => {
    const bad = fx.writerUrl.replace(/Pw1_[0-9a-f]+/, 'Pw1_wrongwrongwrong');
    const err = await createDynalitics({
      dialect,
      connection: { writer: { connectionString: bad } },
      table: fx.table,
      logger: capture().logger,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynaliticsConnectionError);
    const dump =
      JSON.stringify(err, Object.getOwnPropertyNames(err)) + String((err as Error).stack);
    expect(dump).not.toContain('wrongwrongwrong');
    expect(dump).not.toMatch(/Pw1_[0-9a-f]{24}/);
  });

  test('single-credential mode warns; an over-privileged user is flagged (advisory, never blocking)', async () => {
    const cap = capture();
    const dyn = await createDynalitics({
      dialect,
      connection: { connectionString: fx.adminUrl },
      table: fx.table,
      customFields,
      logger: cap.logger,
    });
    open.push(dyn);
    expect(
      cap.logs.some((l) => l.startsWith('warn: dynalitics is using ONE database credential')),
    ).toBe(true);
    expect(
      cap.logs.some((l) => l.includes('seems to have more privileges than dynalitics needs')),
    ).toBe(true);
  });

  test('batches of thousands respect parameter limits and arrive complete; drop backpressure counts what it drops', async () => {
    const before = (await fx.rows()).length;
    const { dyn } = await start({ queue: { maxSize: 5000, batchSize: 1000 } });
    for (let n = 0; n < 2500; n++) void dyn.track({ pageVisited: `/bulk/${n}`, consent: true });
    expect(await dyn.flush()).toMatchObject({ written: 2500, failed: 0 });
    expect((await fx.rows()).length).toBe(before + 2500);

    const small = await start({ queue: { maxSize: 5, batchSize: 1000, flushIntervalMs: 60_000 } });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        small.dyn.track({ pageVisited: `/d/${n}`, consent: true }),
      ),
    );
    expect(results.filter((r) => r.status === 'dropped')).toHaveLength(3);
    expect(small.dyn.stats().droppedFull).toBe(3);
    expect(await small.dyn.flush()).toMatchObject({ written: 5 });
  });

  test('insert failures are reported through onError, never thrown into the caller', async () => {
    const { dyn, cap } = await start({ queue: { retry: { attempts: 1 } } });
    await fx.run(`DROP TABLE ${fx.table.split('.').map(fx.q).join('.')}`);
    await expect(dyn.track({ pageVisited: '/x', consent: true })).resolves.toEqual({
      status: 'queued',
    });
    const res = await dyn.flush();
    expect(res).toMatchObject({ written: 0, failed: 1 });
    expect(cap.errors.some((e) => e.code === 'insert_failed')).toBe(true);
    expect(JSON.stringify(cap.errors)).not.toMatch(/Pw1_[0-9a-f]{24}/);
  });

  test('a duplicate-key error loses only the offending row and never leaks the visitor value (F-02, F-04)', async () => {
    const f2 = await setupFixture(dialect, {});
    try {
      const tbl = f2.table.split('.').map(f2.q).join('.');
      await f2.run(
        `CREATE UNIQUE INDEX ${f2.q(`uq_${f2.bareTable}`)} ON ${tbl} (${f2.q('email')})`,
      );
      const cap = capture();
      const dyn = await createDynalitics({
        dialect,
        connection: {
          writer: { connectionString: f2.writerUrl },
          reader: { connectionString: f2.readerUrl },
        },
        table: f2.table,
        logger: cap.logger,
        onError: cap.onError,
      });
      open.push(dyn);
      const canary = 'jane.canary@example.com';
      await dyn.track({ pageVisited: '/first', consent: true, email: canary });
      await dyn.flush();
      await dyn.track({ pageVisited: '/dup', consent: true, email: canary });
      await dyn.track({ pageVisited: '/fine', consent: true, email: 'other@example.com' });
      expect(await dyn.flush()).toMatchObject({ written: 1, failed: 1 });
      expect((await f2.rows()).map((r) => r['page_visited']).sort()).toEqual(['/fine', '/first']);
      const failure = cap.errors.find((e) => e.code === 'insert_failed');
      expect(failure).toMatchObject({ dropped: 1 });
      const everything = JSON.stringify([cap.errors, cap.logs, dyn.stats()]);
      expect(everything).not.toContain('canary');
      expect(everything).not.toContain('example.com');
    } finally {
      await f2.cleanup();
    }
  });

  test('close() flushes, is idempotent, and releases the pools', async () => {
    const f2 = await setupFixture(dialect, { customFields });
    try {
      const dyn = await createDynalitics({
        dialect,
        connection: {
          writer: { connectionString: f2.writerUrl },
          reader: { connectionString: f2.readerUrl },
        },
        table: f2.table,
        customFields,
        logger: capture().logger,
      });
      await dyn.track({ pageVisited: '/last', consent: true });
      const [a, b] = await Promise.all([dyn.close(), dyn.close()]);
      expect(a).toEqual(b);
      expect(a.written).toBe(1);
      await expect(dyn.close()).resolves.toBeDefined();
      expect((await f2.rows()).map(norm)[0]).toMatchObject({ page_visited: '/last' });
      expect(await dyn.track({ pageVisited: '/after', consent: true })).toEqual({
        status: 'dropped',
        reason: 'closed',
      });
    } finally {
      await f2.cleanup();
    }
  });
});

describe.each(ENABLED)('integration (opt-in write-time first visit): %s', (dialect) => {
  let fx: Fixture;
  const open: Dynalitics[] = [];
  beforeAll(async () => {
    fx = await setupFixture(dialect, { firstVisit: { enabled: true } });
  });
  afterAll(async () => {
    await Promise.allSettled(open.map((d) => d.close()));
    await fx.cleanup();
  });
  const start = async () => {
    const cap = capture();
    const dyn = await createDynalitics({
      dialect,
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      firstVisit: { enabled: true },
      logger: cap.logger,
      onError: cap.onError,
    });
    open.push(dyn);
    return { dyn, cap };
  };

  test('flags the first consented visit of an identity; a fresh process (cold LRU) finds history in the database', async () => {
    const a = await start();
    expect(a.cap.logs.filter((l) => l.startsWith('warn:'))).toEqual([]); // generated grants include the column-level SELECT
    await a.dyn.track({ pageVisited: '/1', consent: true, userId: 'alice' });
    await a.dyn.flush();
    await a.dyn.track({ pageVisited: '/2', consent: true, userId: 'alice' });
    await a.dyn.track({ pageVisited: '/3', consent: true, userId: 'bob' });
    await a.dyn.track({ pageVisited: '/4', consent: true });
    await a.dyn.track({ pageVisited: '/5', consent: false, userId: 'carol' });
    await a.dyn.flush();
    await a.dyn.close();

    const b = await start();
    await b.dyn.track({ pageVisited: '/6', consent: true, userId: 'bob' });
    await b.dyn.track({ pageVisited: '/7', consent: true, userId: 'dave' });
    await b.dyn.flush();

    const byPage: Record<string, unknown> = {};
    for (const r of (await fx.rows()).map(norm))
      byPage[String(r['page_visited'])] = r['is_first_visit'];
    expect(byPage).toEqual({
      '/1': true,
      '/2': false,
      '/3': true,
      '/4': null,
      '/5': null,
      '/6': false,
      '/7': true,
    });
  });
});

void statementsOf;

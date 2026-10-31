/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { DynaliticsSchemaError } from '../../src/errors.js';
import type { Dialect } from '../../src/model/types.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsHandler } from '../../src/read/types.js';
import type { Dynalitics } from '../../src/types.js';
import { ENABLED, setupLegacyTable, type Fixture } from './support.js';

// A table somebody else designed: legacy names, a naive timestamp, an integer consent flag, a 120-char page column,
// an extra nullable column and its own schema. Column names are deliberately not the recommended ones.
const NAMES: Record<Dialect, Record<'id' | 'ts' | 'consent' | 'page' | 'user' | 'note', string>> = {
  postgres: {
    id: 'View_Id',
    ts: 'viewed_at',
    consent: 'GDPR_OK',
    page: 'url_path',
    user: 'account_ref',
    note: 'legacy_note',
  },
  mysql: {
    id: 'view_id',
    ts: 'viewed_at',
    consent: 'gdpr_ok',
    page: 'url_path',
    user: 'account_ref',
    note: 'legacy_note',
  },
  mssql: {
    id: 'view_id',
    ts: 'viewed_at',
    consent: 'gdpr_ok',
    page: 'url_path',
    user: 'account_ref',
    note: 'legacy_note',
  },
};
const TYPES: Record<
  Dialect,
  { id: string; ts: string; consent: string; page: string; user: string; note: string }
> = {
  postgres: {
    id: 'bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    ts: 'timestamp NOT NULL',
    consent: 'smallint NOT NULL',
    page: 'varchar(120) NOT NULL',
    user: 'varchar(40)',
    note: 'text',
  },
  mysql: {
    id: 'bigint AUTO_INCREMENT PRIMARY KEY',
    ts: 'datetime(3) NOT NULL',
    consent: 'tinyint(1) NOT NULL',
    page: 'varchar(120) NOT NULL',
    user: 'varchar(40)',
    note: 'text',
  },
  mssql: {
    id: 'bigint IDENTITY PRIMARY KEY',
    ts: 'datetime2(3) NOT NULL',
    consent: 'bit NOT NULL',
    page: 'nvarchar(120) NOT NULL',
    user: 'nvarchar(40)',
    note: 'nvarchar(max)',
  },
};
const ddlFor =
  (dialect: Dialect, extra: string[] = []) =>
  (table: string, q: (n: string) => string): string[] => {
    const n = NAMES[dialect];
    const t = TYPES[dialect];
    const cols = (['id', 'ts', 'consent', 'page', 'user', 'note'] as const).map(
      (k) => `${q(n[k])} ${t[k]}`,
    );
    return [`CREATE TABLE ${table} (${[...cols, ...extra].join(', ')})`];
  };
const mapFor = (dialect: Dialect) => {
  const n = NAMES[dialect];
  return { timestamp: n.ts, consent: n.consent, pageVisited: n.page, userId: n.user, id: n.id };
};

describe.each(ENABLED)('existing table, legacy names, own schema: %s', (dialect) => {
  let fx: Fixture;
  let dyn: Dynalitics;
  let handler: DynaliticsHandler;
  const logs: string[] = [];
  const n = NAMES[dialect];
  const get = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle({ method: 'GET', path, query, headers: {}, raw: {} });
    return { status: res.status, json: JSON.parse(res.body) };
  };

  beforeAll(async () => {
    fx = await setupLegacyTable(dialect, ddlFor(dialect), { ownSchema: true });
    const t = fx.table.split('.').map(fx.q).join('.');
    const c = (k: keyof typeof n) => fx.q(n[k]);
    const seed = [
      ['2026-10-30 23:30:00', 1, '/a', 'u1'],
      ['2026-10-31 00:30:00', 1, '/b', 'u1'],
      ['2026-10-31 01:00:00', 0, '/a', null],
    ];
    for (const [ts, consent, page, user] of seed) {
      await fx.run(
        `INSERT INTO ${t} (${c('ts')}, ${c('consent')}, ${c('page')}, ${c('user')}) VALUES ('${ts}', ${consent}, '${page}', ${user === null ? 'NULL' : `'${user}'`})`,
      );
    }
    dyn = await createDynalitics({
      dialect,
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      tableMode: 'existing',
      columns: mapFor(dialect),
      ip: { mode: 'raw' },
      logger: {
        info: (m) => void logs.push(`info: ${m}`),
        warn: (m) => void logs.push(`warn: ${m}`),
        error: () => undefined,
      },
    });
    handler = createHandler(dyn, { authorize: () => true, scope: 'none' });
  });
  afterAll(async () => {
    try {
      await dyn?.close(); // dyn is undefined when beforeAll failed; the fixture must still be removed
    } finally {
      await fx?.cleanup();
    }
  });

  test('starts against the legacy table, reports its real types and the adopted page length', () => {
    expect(dyn.model.mode).toBe('existing');
    expect(dyn.model.table.schema).toBe(fx.schemaName);
    expect(dyn.model.columns.find((c) => c.role === 'consent')?.physicalType).toMatch(
      /int2|tinyint|bit/,
    );
    expect(logs.some((l) => l.includes('holds at most 120 characters'))).toBe(true);
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('has no time zone'))).toBe(true);
    expect(logs.some((l) => l.includes('NOT stored') && l.includes('email'))).toBe(true);
  });

  test('/api/meta reflects the mapped roles: identity from userId, ip and email unavailable, cursor from id', async () => {
    const { json } = await get('/api/meta');
    expect(json.data.widgets.newVsReturning).toMatchObject({ available: true, basis: 'user_id' });
    expect(json.data.fields).toMatchObject({
      id: true,
      userId: true,
      ipAddress: false,
      email: false,
      username: false,
    });
    expect(json.data.features.recentVisitsCursor).toBe(true);
  });

  test('reads rows it did not write: naive UTC timestamps land in the right day buckets', async () => {
    const { status, json } = await get('/api/visits-over-time', {
      from: '2026-10-30',
      to: '2026-11-01',
      interval: 'day',
    });
    expect(status).toBe(200);
    expect(json.data.points).toEqual([
      { bucket: '2026-10-30T00:00:00.000Z', visits: 1 },
      { bucket: '2026-10-31T00:00:00.000Z', visits: 2 },
    ]);
    const top = await get('/api/top-pages', { from: '2026-10-30', to: '2026-11-01' });
    expect(top.json.data.pages[0]).toMatchObject({ page: '/a' });
  });

  test('recent visits: newest first, the integer consent flag reads as a boolean, user ids are masked', async () => {
    const { json } = await get('/api/recent-visits', { from: '2026-10-30', to: '2026-11-01' });
    const visits: { pageVisited: string; consent: boolean; id: unknown }[] = json.data.visits;
    expect(visits.map((v) => v.pageVisited)).toEqual(['/a', '/b', '/a']);
    expect(visits.map((v) => v.consent)).toEqual([false, true, true]);
    expect(visits[0]?.id).not.toBeNull();
    expect(JSON.stringify(visits)).not.toContain('"u1"');
  });

  test('track() writes consent as 1/0, cuts the page to the real length and leaves the unmapped columns alone', async () => {
    const t = fx.table.split('.').map(fx.q).join('.');
    await dyn.track({
      pageVisited: `/legacy-${'x'.repeat(300)}`,
      consent: true,
      userId: 'u-track',
    });
    await dyn.track({ pageVisited: '/legacy-denied', consent: false, userId: 'u-denied' });
    expect((await dyn.flush()).failed).toBe(0);
    const rows = await fx.admin.query(
      {
        sql: `SELECT ${fx.q(n.consent)} AS c, ${fx.q(n.page)} AS p, ${fx.q(n.user)} AS u, ${fx.q(n.note)} AS note FROM ${t} WHERE ${fx.q(n.page)} LIKE '/legacy-%' ORDER BY ${fx.q(n.id)}`,
        params: [],
      },
      { timeoutMs: 10_000 },
    );
    expect(rows.map((r) => Number(r['c']))).toEqual([1, 0]);
    expect(String(rows[0]?.['p'])).toHaveLength(120);
    expect(rows[0]?.['u']).toBe('u-track');
    expect(rows[1]?.['u']).toBeNull(); // denied: no personal data
    expect(rows.every((r) => r['note'] === null)).toBe(true);
  });
});

describe.each(ENABLED)('existing table with an unmapped NOT NULL column: %s', (dialect) => {
  let fx: Fixture;
  beforeAll(async () => {
    const extra =
      dialect === 'mssql' ? 'created_by nvarchar(20) NOT NULL' : 'created_by varchar(20) NOT NULL';
    fx = await setupLegacyTable(dialect, ddlFor(dialect, [extra]));
  });
  afterAll(async () => fx.cleanup());

  test('startup fails with the fixes printed as comments, and the table is left exactly as it was', async () => {
    const err = await createDynalitics({
      dialect,
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      tableMode: 'existing',
      columns: mapFor(dialect),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DynaliticsSchemaError);
    const e = err as DynaliticsSchemaError;
    expect(e.problems.map((p) => p.code)).toEqual(['extra_required_column']);
    expect(e.message).toContain(
      'Column "created_by" is NOT NULL, has no default and is not mapped',
    );
    expect(e.fixSql.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'))).toEqual([]);
    const t = fx.table.split('.').map(fx.q).join('.');
    expect(await fx.rows()).toEqual([]);
    const cols = await fx.admin.query(
      { sql: `SELECT ${fx.q('created_by')} FROM ${t}`, params: [] },
      { timeoutMs: 10_000 },
    );
    expect(cols).toEqual([]); // still there, still NOT NULL-less of rows: nothing was altered or inserted
  });
});

describe.each(ENABLED.filter((d) => d === 'mysql'))(
  'MySQL TIMESTAMP column and the session time zone: %s',
  (dialect) => {
    let fx: Fixture;
    const base = () => ({
      dialect,
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      tableMode: 'existing' as const,
      columns: mapFor(dialect),
      ip: { mode: 'raw' as const },
    });
    beforeAll(async () => {
      fx = await setupLegacyTable(dialect, (table, q) => [
        `CREATE TABLE ${table} (${q('view_id')} bigint AUTO_INCREMENT PRIMARY KEY, ${q('viewed_at')} timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ${q('gdpr_ok')} tinyint(1) NOT NULL, ${q('url_path')} varchar(120) NOT NULL, ${q('account_ref')} varchar(40))`,
      ]);
    });
    afterAll(async () => fx.cleanup());

    test('a UTC session round-trips the instant', async () => {
      const dyn = await createDynalitics(base());
      await dyn.track({ pageVisited: '/ts', consent: true });
      await dyn.flush();
      await dyn.close();
      const rows = await fx.admin.query(
        {
          sql: `SELECT UNIX_TIMESTAMP(${fx.q('viewed_at')}) AS u FROM ${fx.table.split('.').map(fx.q).join('.')}`,
          params: [],
        },
        { timeoutMs: 10_000 },
      );
      expect(Math.abs(Number(rows[0]?.['u']) - Date.now() / 1000)).toBeLessThan(60);
    });

    test('a session that is not UTC is refused at startup, and the session is never changed by dynalitics', async () => {
      const before = await fx.admin.query(
        { sql: 'SELECT @@global.time_zone AS tz', params: [] },
        { timeoutMs: 10_000 },
      );
      const original = String(before[0]?.['tz']);
      try {
        await fx.run(`SET GLOBAL time_zone = '+02:00'`);
        const err = (await createDynalitics(base()).catch(
          (e: unknown) => e,
        )) as DynaliticsSchemaError;
        expect(err).toBeInstanceOf(DynaliticsSchemaError);
        expect(err.problems.map((p) => p.code)).toEqual(['timestamp_session_timezone']);
        expect(err.message).toContain('"+02:00"');
      } finally {
        await fx.run(`SET GLOBAL time_zone = '${original}'`);
      }
      const after = await fx.admin.query(
        { sql: 'SELECT @@global.time_zone AS tz', params: [] },
        { timeoutMs: 10_000 },
      );
      expect(String(after[0]?.['tz'])).toBe(original);
    });
  },
);

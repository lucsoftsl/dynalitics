import { describe, expect, test } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import type { ColumnInfo } from '../../src/dialect/types.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import { adoptPhysical } from '../../src/model/physical.js';
import type { Dialect, SchemaConfig } from '../../src/model/types.js';
import { buildDimensions, planNewVsReturning } from '../../src/read/capabilities.js';
import * as q from '../../src/read/queries.js';

const col = (name: string, dataType: string, o: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType,
  maxLength: null,
  nullable: true,
  hasDefault: false,
  generated: false,
  precision: null,
  tableType: 'BASE TABLE',
  ...o,
});
const schema: SchemaConfig = {
  table: 'legacy.views',
  tableMode: 'existing',
  columns: { timestamp: 'viewed_at', consent: 'ok', pageVisited: 'url', userId: 'uid', id: 'rid' },
};
const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-08T00:00:00Z') };

function env(dialect: Dialect, ts: string, consent: string) {
  const { model } = adoptPhysical(
    buildColumnModel(schema),
    [
      col('viewed_at', ts),
      col('ok', consent),
      col('url', 'varchar'),
      col('uid', 'varchar'),
      col('rid', 'int8'),
    ],
    dialect,
  );
  return { dialect: getDialect(dialect), model, scope: [] };
}
const plan = (e: ReturnType<typeof env>) =>
  planNewVsReturning(e.model, 'raw', { enabled: true, source: 'computed', ipIdentity: 'auto' });

describe('PostgreSQL', () => {
  test('a naive timestamp column is converted to an instant before bucketing; filters stay on the raw column', () => {
    const e = env('postgres', 'timestamp', 'bool');
    const s = q.visitsSeries(e, { ...range, interval: 'day' }).sql;
    expect(s).toContain(`date_trunc('day', ("viewed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`);
    expect(s).toContain('"viewed_at" >= $1 AND "viewed_at" < $2');
  });

  test('timestamptz is left exactly as before', () => {
    const e = env('postgres', 'timestamptz', 'bool');
    const s = q.visitsSeries(e, { ...range, interval: 'day' }).sql;
    expect(s).toContain(`date_trunc('day', "viewed_at" AT TIME ZONE 'UTC')`);
    expect(s).not.toContain(`("viewed_at" AT TIME ZONE 'UTC') AT TIME ZONE`);
  });

  test('an integer consent column is compared to 1, never used as a boolean', () => {
    const e = env('postgres', 'timestamptz', 'int2');
    expect(q.consentSeries(e, { ...range, interval: 'day' }).sql).toContain('("ok" = 1) IS TRUE');
    expect(q.recentVisits(e, { ...range, limit: 5, cursor: undefined }, plan(e)).sql).toContain(
      '(r."ok" = 1) IS TRUE',
    );
    const dim = buildDimensions(e.model).get('consent')!;
    expect(q.breakdownTop(e, dim, range).sql).toContain('("ok" = 1) IS TRUE');
  });

  test('a real boolean consent column is untouched', () => {
    const e = env('postgres', 'timestamptz', 'bool');
    expect(q.consentSeries(e, { ...range, interval: 'day' }).sql).toContain('"ok" IS TRUE');
  });

  test('recent visits and the first-row bucket of new-vs-returning convert naive timestamps too', () => {
    const e = env('postgres', 'timestamp', 'bool');
    expect(q.recentVisits(e, { ...range, limit: 5, cursor: undefined }, plan(e)).sql).toContain(
      `to_char((r."viewed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    );
    const p = plan(e);
    if (!p.available || p.source !== 'computed') throw new Error('plan');
    expect(q.nvrNew(e, { ...range, interval: 'day' }, p, 'u').sql).toContain(
      `date_trunc('day', (m.first_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    );
  });
});

describe('SQL Server', () => {
  test('datetimeoffset is switched to UTC before it is formatted or bucketed', () => {
    const e = env('mssql', 'datetimeoffset', 'bit');
    expect(q.visitsSeries(e, { ...range, interval: 'day' }).sql).toContain(
      `CAST(SWITCHOFFSET([viewed_at], '+00:00') AS datetime2)`,
    );
    expect(q.recentVisits(e, { ...range, limit: 5, cursor: undefined }, plan(e)).sql).toContain(
      `CAST(SWITCHOFFSET(r.[viewed_at], '+00:00') AS datetime2)`,
    );
  });

  test('datetime2 and a bit consent column are untouched', () => {
    const e = env('mssql', 'datetime2', 'bit');
    const s = q.visitsSeries(e, { ...range, interval: 'day' }).sql;
    expect(s).not.toContain('SWITCHOFFSET');
    expect(q.consentSeries(e, { ...range, interval: 'day' }).sql).toContain('[ok] = 1');
  });
});

describe('MySQL', () => {
  test('DATETIME, TIMESTAMP and tinyint(1) need no rewriting', () => {
    for (const ts of ['datetime', 'timestamp']) {
      const e = env('mysql', ts, 'tinyint');
      const s = q.consentSeries(e, { ...range, interval: 'day' }).sql;
      expect(s).toContain('`ok` = 1');
      expect(s).not.toContain('SWITCHOFFSET');
      expect(s).not.toContain('AT TIME ZONE');
    }
  });
});

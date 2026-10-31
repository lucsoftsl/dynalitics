import { describe, expect, test } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { Dialect } from '../../src/model/types.js';

const DIALECTS: Dialect[] = ['postgres', 'mysql', 'mssql'];
const model = buildColumnModel({
  table: 'public.events',
  customFields: { locale: { type: 'string', column: true, personal: false } },
});

describe('quoting', () => {
  test('quotes with the right characters and doubles embedded quote characters', () => {
    expect(getDialect('postgres').quoteIdent('events')).toBe('"events"');
    expect(getDialect('mysql').quoteIdent('events')).toBe('`events`');
    expect(getDialect('mssql').quoteIdent('events')).toBe('[events]');
  });

  test.each(DIALECTS)('%s refuses anything that is not a valid identifier', (d) => {
    const dialect = getDialect(d);
    for (const bad of ['a"b', 'a`b', 'a]b', 'a b', "a'; DROP TABLE x;--", '', '1a']) {
      expect(() => dialect.quoteIdent(bad)).toThrow(/not supported/);
    }
  });

  test('qualifiedTable joins parts', () => {
    expect(getDialect('postgres').qualifiedTable({ schema: 'public', name: 'e' })).toBe(
      '"public"."e"',
    );
    expect(getDialect('mysql').qualifiedTable({ name: 'e' })).toBe('`e`');
    expect(getDialect('mssql').qualifiedTable({ database: 'd', schema: 'dbo', name: 'e' })).toBe(
      '[d].[dbo].[e]',
    );
  });
});

describe('placeholders and limits', () => {
  test('placeholder styles', () => {
    expect(getDialect('postgres').placeholder(3)).toBe('$3');
    expect(getDialect('mysql').placeholder(3)).toBe('?');
    expect(getDialect('mssql').placeholder(3)).toBe('@p3');
  });

  test('parameter and row limits per spec 5.1', () => {
    expect(getDialect('postgres').limits.maxParams).toBe(65_535);
    expect(getDialect('mysql').limits.maxParams).toBe(65_535);
    expect(getDialect('mssql').limits).toMatchObject({ maxParams: 2100, maxRowsPerInsert: 1000 });
  });
});

describe('timestamps are exchanged as UTC text', () => {
  const d = new Date('2026-10-30T12:01:44.120Z');
  test('formats', () => {
    expect(getDialect('postgres').timestampParam(d)).toBe('2026-10-30T12:01:44.120Z');
    expect(getDialect('mysql').timestampParam(d)).toBe('2026-10-30 12:01:44.120');
    expect(getDialect('mssql').timestampParam(d)).toBe('2026-10-30T12:01:44.120');
  });
});

describe('column types (spec 3.8)', () => {
  const type = (d: Dialect, role: string): string => {
    const c = model.columns.find((x) => x.key === role)!;
    return getDialect(d).columnType(c);
  };
  test('maps logical types', () => {
    expect(type('postgres', 'timestamp')).toBe('timestamptz');
    expect(type('mysql', 'timestamp')).toBe('DATETIME(3)');
    expect(type('mssql', 'timestamp')).toBe('DATETIME2(3)');
    expect(type('postgres', 'consent')).toBe('boolean');
    expect(type('mysql', 'consent')).toBe('TINYINT(1)');
    expect(type('mssql', 'consent')).toBe('BIT');
    expect(type('postgres', 'pageVisited')).toBe('varchar(512)');
    expect(type('mysql', 'email')).toBe('VARCHAR(320)');
    expect(type('mssql', 'email')).toBe('NVARCHAR(320)');
    expect(type('postgres', 'custom')).toBe('jsonb');
    expect(type('mysql', 'custom')).toBe('JSON');
    expect(type('mssql', 'custom')).toBe('NVARCHAR(MAX)');
  });
});

describe('buildInsert', () => {
  const rows = [
    ['2026-10-30T12:00:00.000Z', true, '/a', null, null, null, null, null],
    ['2026-10-30T12:00:01.000Z', false, '/b', null, null, null, null, null],
  ];
  const m = buildColumnModel({ table: 'public.events' });

  test('postgres: numbered placeholders, jsonb cast, quoted identifiers', () => {
    const q = getDialect('postgres').buildInsert(m, rows);
    expect(q.sql).toBe(
      'INSERT INTO "public"."events" ("visited_at", "consent", "page_visited", "ip_address", "user_id", "username", "email", "custom") VALUES ' +
        '($1, $2, $3, $4, $5, $6, $7, $8::jsonb), ($9, $10, $11, $12, $13, $14, $15, $16::jsonb)',
    );
    expect(q.params).toHaveLength(16);
  });

  test('mysql: question marks', () => {
    const q = getDialect('mysql').buildInsert(m, rows);
    expect(q.sql).toBe(
      'INSERT INTO `public`.`events` (`visited_at`, `consent`, `page_visited`, `ip_address`, `user_id`, `username`, `email`, `custom`) VALUES ' +
        '(?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
    );
  });

  test('mssql: @pN placeholders', () => {
    const q = getDialect('mssql').buildInsert(m, rows);
    expect(q.sql).toContain('VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8), (@p9,');
  });

  test('values are NEVER interpolated into the SQL text', () => {
    const evil = "x'); DROP TABLE events; --";
    const evilRows = [['2026-10-30T12:00:00.000Z', true, evil, evil, evil, evil, evil, evil]];
    for (const d of DIALECTS) {
      const q = getDialect(d).buildInsert(m, evilRows);
      expect(q.sql).not.toContain('DROP');
      expect(q.sql).not.toContain("'");
      expect(q.params).toContain(evil);
    }
  });

  test('rejects rows with the wrong number of values', () => {
    expect(() => getDialect('postgres').buildInsert(m, [[1, 2]])).toThrow(/expected 8 values/);
  });
});

describe('first-visit lookup SQL', () => {
  const m = buildColumnModel({ table: 'public.events', firstVisit: { enabled: true } });
  test('user lookups bind every value', () => {
    const q = getDialect('postgres').firstVisitLookup(m, 'u', ['a', 'b']);
    expect(q.sql).toBe(
      'SELECT DISTINCT "user_id" AS v FROM "public"."events" WHERE "user_id" IN ($1, $2)',
    );
    expect(q.params).toEqual(['a', 'b']);
  });
  test('ip lookups only consider rows without a user id', () => {
    const q = getDialect('mysql').firstVisitLookup(m, 'i', ['1.2.3.0']);
    expect(q.sql).toBe(
      'SELECT DISTINCT `ip_address` AS v FROM `public`.`events` WHERE `ip_address` IN (?) AND `user_id` IS NULL',
    );
  });
});

describe('introspection SQL', () => {
  test.each(DIALECTS)('%s binds schema and table name as parameters', (d) => {
    const q = getDialect(d).introspectSql({ schema: 's', name: 't' });
    expect(q.params).toEqual(['s', 't']);
    expect(q.sql).not.toMatch(/'s'|'t'/);
  });
  test('missing schema is passed as NULL and defaulted by the database', () => {
    expect(getDialect('postgres').introspectSql({ name: 't' }).params).toEqual([null, 't']);
  });
});

describe('mapColumnRow', () => {
  test('normalises driver rows', () => {
    const info = getDialect('mysql').mapColumnRow({
      name: 'a',
      data_type: 'VarChar',
      max_length: '512',
      is_nullable: 1,
      has_default: 0,
      is_generated: 0,
      dt_precision: null,
      table_type: 'BASE TABLE',
      schema_name: 'analytics',
    });
    expect(info).toEqual({
      name: 'a',
      dataType: 'varchar',
      maxLength: 512,
      nullable: true,
      hasDefault: false,
      generated: false,
      precision: null,
      tableType: 'BASE TABLE',
      schema: 'analytics',
    });
  });
});

describe('SQL Server instant text (found by the first real CI run)', () => {
  // CONVERT(..., 126) omits the fraction when it is zero, so bucket keys never matched toISOString() and every
  // bucketed count came back 0. The fraction must always be written with exactly three digits.
  const read = getDialect('mssql').read;

  test.each(['hour', 'day', 'week', 'month'] as const)('%s buckets end in .000Z', (interval) => {
    const sql = read.bucket('[ts]', interval);
    expect(sql).toMatch(/^CONVERT\(varchar\(19\), .+, 126\) \+ '\.000Z'$/);
    expect(sql).not.toContain('varchar(23)');
  });

  test('timestamps always carry three millisecond digits', () => {
    expect(read.tsText('[ts]')).toBe(
      "CONVERT(varchar(19), [ts], 126) + '.' + RIGHT('00' + CAST(DATEPART(millisecond, [ts]) AS varchar(3)), 3) + 'Z'",
    );
  });
});

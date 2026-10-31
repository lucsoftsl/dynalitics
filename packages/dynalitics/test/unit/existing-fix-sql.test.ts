import { describe, expect, test } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import type { ColumnInfo } from '../../src/dialect/types.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { Dialect } from '../../src/model/types.js';
import { compareTable } from '../../src/startup/compare.js';
import { buildFixSql, buildSchemaReport } from '../../src/startup/fix-sql.js';

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
const model = buildColumnModel({
  table: 'legacy.views',
  tableMode: 'existing',
  columns: { timestamp: 'viewed_at', consent: 'ok', pageVisited: 'url', email: 'mail', ip: 'addr' },
});
const columnsFor = (dialect: Dialect): ColumnInfo[] => [
  col(
    'viewed_at',
    dialect === 'mssql' ? 'datetime2' : dialect === 'mysql' ? 'datetime' : 'timestamptz',
    {
      nullable: false,
      precision: 3,
    },
  ),
  col('ok', dialect === 'postgres' ? 'bool' : dialect === 'mysql' ? 'tinyint' : 'bit', {
    nullable: false,
  }),
  col('url', 'varchar', { maxLength: 200, nullable: false }),
  col('mail', dialect === 'postgres' ? 'integer' : dialect === 'mysql' ? 'int' : 'int', {
    nullable: false,
  }), // wrong type, NOT NULL
  // 'addr' is missing on purpose
  col('created_by', 'varchar', { maxLength: 20, nullable: false }), // extra NOT NULL, no default
];

describe.each(['postgres', 'mysql', 'mssql'] as const)('existing mode fixes: %s', (name) => {
  const dialect = getDialect(name);
  const result = compareTable({ model, dialect, columns: columnsFor(name) });

  test('finds the three kinds of problem', () => {
    expect(result.problems.map((p) => p.code).sort()).toEqual([
      'extra_required_column',
      'missing_column',
      'type_mismatch',
    ]);
  });

  test('every printed fix line is a comment: nothing in it can be run by accident', () => {
    const fix = buildFixSql({ model, dialect, problems: result.problems });
    const lines = fix.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.filter((l) => !l.startsWith('--'))).toEqual([]);
  });

  test('a missing mapped column is treated as a probable typo: no ADD COLUMN is suggested', () => {
    const fix = buildFixSql({ model, dialect, problems: result.problems });
    expect(fix).not.toMatch(/ADD (COLUMN )?[["`]?addr/i);
    expect(fix).toContain('columns.ip');
  });

  test('the NOT NULL column gets its fix options', () => {
    const fix = buildFixSql({ model, dialect, problems: result.problems });
    expect(fix).toContain('created_by');
    expect(fix).toMatch(/DEFAULT/);
  });

  test('the report says the real table mode and points to no generator or unbuilt command', () => {
    const report = buildSchemaReport({ model, dialect, problems: result.problems, warnings: [] });
    expect(report).toContain('tableMode "existing"');
    expect(report).not.toContain('tableMode "recommended"');
    expect(report).not.toContain('inspect');
    expect(report).not.toContain('npx dynalitics sql');
    expect(report).toContain('Nothing here has been executed.');
  });
});

test('a missing table in existing mode prints no CREATE TABLE', () => {
  const dialect = getDialect('postgres');
  const r = compareTable({ model, dialect, columns: [] });
  const fix = buildFixSql({ model, dialect, problems: r.problems });
  expect(fix).not.toMatch(/CREATE TABLE/i);
});

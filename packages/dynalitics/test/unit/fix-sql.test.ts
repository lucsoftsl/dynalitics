import { describe, expect, test } from 'vitest';
import { compareTable } from '../../src/startup/compare.js';
import { buildFixSql, buildSchemaReport } from '../../src/startup/fix-sql.js';
import { getDialect } from '../../src/dialect/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import { perfectColumns } from '../helpers/perfect-table.js';
import type { Dialect } from '../../src/model/types.js';

const model = buildColumnModel({ table: 'public.events' });

describe.each(['postgres', 'mysql', 'mssql'] as Dialect[])('fix SQL (%s)', (d) => {
  const dialect = getDialect(d);
  const cols = perfectColumns(d, model);

  test('missing table: prints CREATE TABLE and indexes', () => {
    const { problems } = compareTable({ model, dialect, columns: [] });
    const fix = buildFixSql({ model, dialect, problems });
    expect(fix).toContain('CREATE TABLE');
    expect(fix).toContain('CREATE INDEX');
  });

  test('missing column: a live, additive ALTER TABLE ... ADD', () => {
    const { problems } = compareTable({
      model,
      dialect,
      columns: cols.filter((c) => c.name !== 'email'),
    });
    const fix = buildFixSql({ model, dialect, problems });
    const live = fix.split('\n').filter((l) => !l.startsWith('--') && l.trim() !== '');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatch(/^ALTER TABLE .* ADD (COLUMN )?.*email.*;$/);
  });

  test('risky changes (type, nullability) are printed commented out with a reason', () => {
    const bad = cols.map((c) =>
      c.name === 'email'
        ? { ...c, dataType: d === 'postgres' ? 'int4' : 'int' }
        : c.name === 'username'
          ? { ...c, nullable: false }
          : c,
    );
    const { problems } = compareTable({ model, dialect, columns: bad });
    const fix = buildFixSql({ model, dialect, problems });
    const live = fix.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(live).toEqual([]);
    expect(fix).toMatch(/-- ALTER TABLE .*email/);
    expect(fix).toMatch(/-- ALTER TABLE .*username/);
    expect(fix).toContain('review manually');
  });

  test('unmapped NOT NULL column: commented options, never executed', () => {
    const { problems } = compareTable({
      model,
      dialect,
      columns: [
        ...cols,
        {
          name: 'created_by',
          dataType: 'varchar',
          maxLength: 5,
          nullable: false,
          hasDefault: false,
          generated: false,
          precision: null,
          tableType: 'BASE TABLE',
        },
      ],
    });
    const fix = buildFixSql({ model, dialect, problems });
    expect(fix).toContain('created_by');
    expect(fix.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'))).toEqual([]);
  });

  test('the report lists problems, the never-executed promise, and no connection data', () => {
    const { problems, warnings } = compareTable({
      model,
      dialect,
      columns: cols.filter((c) => c.name !== 'email'),
    });
    const report = buildSchemaReport({ model, dialect, problems, warnings });
    expect(report).toContain(
      `does not match what dynalitics expects (${d}, tableMode "recommended")`,
    );
    expect(report).toContain('Problems:\n  1. Role "email"');
    expect(report).toContain('dynalitics never changes your database.');
    expect(report).toContain('Nothing here has been executed.');
    expect(report).toContain('npx dynalitics sql --dialect');
  });
});

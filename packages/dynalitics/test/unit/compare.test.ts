import { describe, expect, test } from 'vitest';
import { compareTable } from '../../src/startup/compare.js';
import { getDialect } from '../../src/dialect/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { ColumnInfo } from '../../src/dialect/types.js';
import type { Dialect } from '../../src/model/types.js';
import { infoFor, perfectColumns } from '../helpers/perfect-table.js';

const DIALECTS: Dialect[] = ['postgres', 'mysql', 'mssql'];
const model = buildColumnModel({
  table: 'public.events',
  customFields: { locale: { type: 'string', maxLength: 16, personal: false, column: true } },
});

const run = (d: Dialect, columns: ColumnInfo[]) =>
  compareTable({ model, dialect: getDialect(d), columns });
const replace = (cols: ColumnInfo[], name: string, patch: Partial<ColumnInfo>): ColumnInfo[] =>
  cols.map((c) => (c.name === name ? { ...c, ...patch } : c));

describe.each(DIALECTS)('compareTable (%s)', (d) => {
  const perfect = perfectColumns(d, model);

  test('a matching table has no problems and no warnings', () => {
    expect(run(d, perfect)).toEqual({ problems: [], warnings: [] });
  });

  test('no columns at all means the table is missing', () => {
    const r = run(d, []);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.code).toBe('missing_table');
    expect(r.problems[0]?.message).toContain('dynalitics never creates tables');
    expect(r.problems[0]?.message).toContain('npx dynalitics sql');
  });

  test('a view is refused', () => {
    const r = run(
      d,
      perfect.map((c) => ({ ...c, tableType: 'VIEW' })),
    );
    expect(r.problems.map((p) => p.code)).toEqual(['not_a_table']);
  });

  test('missing columns are listed with the columns that were found', () => {
    const r = run(
      d,
      perfect.filter((c) => c.name !== 'custom'),
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ code: 'missing_column', column: 'custom' });
    expect(r.problems[0]?.message).toBe(
      `Role "custom" is mapped to column "custom", but ${getDialect(d).qualifiedTable(model.table)} has no such column. Columns found: ` +
        perfect
          .filter((c) => c.name !== 'custom')
          .map((c) => c.name)
          .join(', ') +
        '.',
    );
  });

  test('incompatible type names the accepted ones', () => {
    const r = run(d, replace(perfect, 'email', { dataType: d === 'postgres' ? 'int4' : 'int' }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.code).toBe('type_mismatch');
    expect(r.problems[0]?.message).toMatch(
      new RegExp(
        `^Role "email" \\(column "email"\\): type "${d === 'postgres' ? 'int4' : 'int'}" is not accepted on ${d}\\. Accepted: .+\\.$`,
      ),
    );
  });

  test('a string column shorter than the configured maximum is too_short', () => {
    const r = run(d, replace(perfect, 'page_visited', { maxLength: 100 }));
    expect(r.problems.map((p) => p.code)).toEqual(['too_short']);
    expect(r.problems[0]?.message).toContain('Widen the column or lower page.maxLength');
  });

  test('a promoted field names its own setting', () => {
    const r = run(d, replace(perfect, 'locale', { maxLength: 4 }));
    expect(r.problems[0]?.message).toContain('customFields.locale.maxLength');
  });

  test('NOT NULL where dynalitics writes NULL is a problem', () => {
    const r = run(d, replace(perfect, 'email', { nullable: false }));
    expect(r.problems).toEqual([
      {
        code: 'not_nullable',
        column: 'email',
        message:
          'Role "email" (column "email") is NOT NULL, but dynalitics writes NULL there when consent is not given. Make the column nullable, or stop storing this role (columns.email = false).',
      },
    ]);
  });

  test('required columns may be NOT NULL (and nullable consent only warns)', () => {
    expect(run(d, perfect).problems).toEqual([]);
    const r = run(d, replace(perfect, 'consent', { nullable: true }));
    expect(r.problems).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(['nullable_consent']);
  });

  test('an unmapped NOT NULL column without default would break every INSERT', () => {
    const extra: ColumnInfo = {
      ...infoFor(d, perfect.length ? model.columns[0]! : model.columns[0]!),
      name: 'created_by',
      nullable: false,
      generated: false,
      dataType: 'varchar',
      maxLength: 10,
    };
    const r = run(d, [...perfect, extra]);
    expect(r.problems.map((p) => p.code)).toEqual(['extra_required_column']);
    expect(r.problems[0]?.message).toBe(
      'Column "created_by" is NOT NULL, has no default and is not mapped, so every INSERT would fail. Give it a default or make it nullable.',
    );
  });

  test.each([
    ['has a default', { hasDefault: true }],
    ['is nullable', { nullable: true }],
    ['is generated', { generated: true }],
  ])('an unmapped column that %s is fine', (_label, patch) => {
    const extra: ColumnInfo = {
      name: 'other',
      dataType: 'varchar',
      maxLength: 5,
      nullable: false,
      hasDefault: false,
      generated: false,
      precision: null,
      tableType: 'BASE TABLE',
      ...patch,
    };
    expect(run(d, [...perfect, extra]).problems).toEqual([]);
  });

  test('matching is case-insensitive on column names for MySQL and SQL Server', () => {
    const upper = perfect.map((c) => ({ ...c, name: c.name.toUpperCase() }));
    const r = run(d, upper);
    if (d === 'postgres') expect(r.problems.some((p) => p.code === 'missing_column')).toBe(true);
    else expect(r.problems).toEqual([]);
  });
});

describe('type tolerance', () => {
  test('PostgreSQL: integer consent, text strings, naive timestamp (warning), json (warning)', () => {
    let cols = perfectColumns('postgres', model);
    cols = replace(cols, 'consent', { dataType: 'int2' });
    cols = replace(cols, 'email', { dataType: 'text', maxLength: null });
    cols = replace(cols, 'visited_at', { dataType: 'timestamp' });
    cols = replace(cols, 'custom', { dataType: 'json' });
    const r = run('postgres', cols);
    expect(r.problems).toEqual([]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['json_unindexable', 'naive_timestamp']);
  });

  test('PostgreSQL: char(n) (bpchar) is refused because of padding', () => {
    const r = run(
      'postgres',
      replace(perfectColumns('postgres', model), 'username', { dataType: 'bpchar' }),
    );
    expect(r.problems[0]?.code).toBe('type_mismatch');
  });

  test('MySQL: datetime with low precision warns, TIMESTAMP is accepted (the session check is in existing-compare.test.ts)', () => {
    const cols = perfectColumns('mysql', model);
    expect(
      run('mysql', replace(cols, 'visited_at', { precision: 0 })).warnings.map((w) => w.code),
    ).toEqual(['low_precision_timestamp']);
    const ts = run('mysql', replace(cols, 'visited_at', { dataType: 'timestamp' }));
    expect(ts.problems).toEqual([]);
  });

  test('MySQL: any integer width works for consent, text types work for strings', () => {
    let cols = perfectColumns('mysql', model);
    cols = replace(cols, 'consent', { dataType: 'int' });
    cols = replace(cols, 'email', { dataType: 'text', maxLength: 65535 });
    expect(run('mysql', cols).problems).toEqual([]);
  });

  test('SQL Server: datetime warns, varchar warns, char/text refused, json needs nvarchar(max)', () => {
    let cols = perfectColumns('mssql', model);
    cols = replace(cols, 'visited_at', { dataType: 'datetime', precision: 3 });
    cols = replace(cols, 'username', { dataType: 'varchar' });
    const r = run('mssql', cols);
    expect(r.problems).toEqual([]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      'low_precision_timestamp',
      'non_unicode_column',
    ]);
    expect(
      run('mssql', replace(perfectColumns('mssql', model), 'email', { dataType: 'char' }))
        .problems[0]?.code,
    ).toBe('type_mismatch');
    expect(
      run('mssql', replace(perfectColumns('mssql', model), 'custom', { maxLength: 4000 }))
        .problems[0]?.code,
    ).toBe('type_mismatch');
  });

  test('date-only columns are refused for the timestamp role on every dialect', () => {
    for (const d of DIALECTS) {
      const r = run(d, replace(perfectColumns(d, model), 'visited_at', { dataType: 'date' }));
      expect(r.problems[0]?.code).toBe('type_mismatch');
    }
  });
});

import { describe, expect, test } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import type { ColumnInfo } from '../../src/dialect/types.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { Dialect, SchemaConfig } from '../../src/model/types.js';
import { compareTable } from '../../src/startup/compare.js';

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
const MAP = {
  timestamp: 'viewed_at',
  consent: 'ok',
  pageVisited: 'url',
  userId: 'account_id',
  email: 'mail',
} as const;
const schema = (extra: Partial<SchemaConfig> = {}): SchemaConfig => ({
  table: 'legacy.views',
  tableMode: 'existing',
  columns: MAP,
  ...extra,
});
const run = (dialect: Dialect, columns: ColumnInfo[], s = schema(), sessionTimeDiff?: string) =>
  compareTable({
    model: buildColumnModel(s),
    dialect: getDialect(dialect),
    columns,
    ...(sessionTimeDiff === undefined ? {} : { sessionTimeDiff }),
  });
const codes = (r: { problems: readonly { code: string }[] }): string[] =>
  r.problems.map((p) => p.code);
const warnCodes = (r: { warnings: readonly { code: string }[] }): string[] =>
  r.warnings.map((p) => p.code);

const pgLegacy = (): ColumnInfo[] => [
  col('viewed_at', 'timestamptz', { nullable: false }),
  col('ok', 'bool', { nullable: false }),
  col('url', 'text', { nullable: false }),
  col('account_id', 'varchar', { maxLength: 40 }),
  col('mail', 'varchar', { maxLength: 100 }),
];

describe('existing mode: PostgreSQL', () => {
  test('a clean legacy table passes with no warnings', () => {
    const r = run('postgres', pgLegacy());
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('integer consent, text page and extra nullable columns are accepted', () => {
    const cols = [
      ...pgLegacy().filter((c) => c.name !== 'ok'),
      col('ok', 'int2', { nullable: false }),
    ];
    cols.push(col('legacy_note', 'text'));
    expect(run('postgres', cols).problems).toEqual([]);
  });

  test('a naive timestamp is accepted with the naive_timestamp warning', () => {
    const cols = pgLegacy().map((c) =>
      c.name === 'viewed_at' ? col('viewed_at', 'timestamp', { nullable: false }) : c,
    );
    const r = run('postgres', cols);
    expect(r.problems).toEqual([]);
    expect(warnCodes(r)).toEqual(['naive_timestamp']);
  });

  test('a date column cannot hold a visit time: type_mismatch with the accepted list', () => {
    const cols = pgLegacy().map((c) =>
      c.name === 'viewed_at' ? col('viewed_at', 'date', { nullable: false }) : c,
    );
    const r = run('postgres', cols);
    expect(r.problems).toEqual([
      {
        code: 'type_mismatch',
        column: 'viewed_at',
        message:
          'Role "timestamp" (column "viewed_at"): type "date" is not accepted on postgres. Accepted: timestamptz, timestamp.',
      },
    ]);
  });

  test('citext is accepted for identity roles with a warning, and refused for the page', () => {
    const cols = pgLegacy().map((c) => (c.name === 'account_id' ? col('account_id', 'citext') : c));
    expect(warnCodes(run('postgres', cols))).toEqual(['case_insensitive_identity']);
    const page = pgLegacy().map((c) =>
      c.name === 'url' ? col('url', 'citext', { nullable: false }) : c,
    );
    expect(codes(run('postgres', page))).toEqual(['type_mismatch']);
  });

  test('an unmapped NOT NULL column without a default is a startup problem (and with default/generated it is not)', () => {
    const blocked = run('postgres', [
      ...pgLegacy(),
      col('created_by', 'text', { nullable: false }),
    ]);
    expect(blocked.problems).toEqual([
      {
        code: 'extra_required_column',
        column: 'created_by',
        message:
          'Column "created_by" is NOT NULL, has no default and is not mapped, so every INSERT would fail. Give it a default or make it nullable.',
      },
    ]);
    for (const ok of [{ hasDefault: true }, { generated: true }, { nullable: true }]) {
      expect(
        run('postgres', [...pgLegacy(), col('created_by', 'text', { nullable: false, ...ok })])
          .problems,
      ).toEqual([]);
    }
  });

  test('the real length is adopted, not an error (recommended mode still reports too_short)', () => {
    const short = pgLegacy().map((c) =>
      c.name === 'mail' ? col('mail', 'varchar', { maxLength: 100 }) : c,
    );
    expect(run('postgres', short).problems).toEqual([]);
  });

  test('a mapped optional column that is NOT NULL is refused (we write NULL without consent)', () => {
    const cols = pgLegacy().map((c) =>
      c.name === 'mail' ? col('mail', 'varchar', { maxLength: 100, nullable: false }) : c,
    );
    expect(codes(run('postgres', cols))).toEqual(['not_nullable']);
  });

  test('a missing mapped column lists what was found; PostgreSQL names are case-sensitive', () => {
    const cols = pgLegacy().map((c) =>
      c.name === 'mail' ? col('Mail', 'varchar', { maxLength: 100 }) : c,
    );
    const r = run('postgres', cols);
    expect(r.problems[0]?.code).toBe('missing_column');
    expect(r.problems[0]?.message).toContain('Quoted names are case-sensitive in PostgreSQL.');
    expect(r.problems[0]?.message).toContain(
      'Columns found: viewed_at, ok, url, account_id, Mail.',
    );
  });

  test('a view is refused', () => {
    const r = run(
      'postgres',
      pgLegacy().map((c) => ({ ...c, tableType: 'VIEW' })),
    );
    expect(codes(r)).toEqual(['not_a_table']);
  });

  test('a nullable consent column warns', () => {
    const cols = pgLegacy().map((c) =>
      c.name === 'ok' ? col('ok', 'bool', { nullable: true }) : c,
    );
    expect(warnCodes(run('postgres', cols))).toEqual(['nullable_consent']);
  });

  test('a missing table does not tell an existing-table user to generate the recommended one', () => {
    const r = run('postgres', []);
    expect(r.problems[0]?.code).toBe('missing_table');
    expect(r.problems[0]?.message).toContain('tableMode is "existing"');
    expect(r.problems[0]?.message).not.toContain('npx dynalitics sql');
  });
});

describe('existing mode: MySQL', () => {
  const my = (ts: ColumnInfo): ColumnInfo[] => [
    ts,
    col('ok', 'tinyint', { nullable: false }),
    col('url', 'varchar', { maxLength: 255, nullable: false }),
    col('account_id', 'varchar', { maxLength: 64 }),
    col('mail', 'varchar', { maxLength: 100 }),
  ];
  const datetime = (precision: number | null) =>
    col('viewed_at', 'datetime', { nullable: false, precision });

  test('datetime(3) is accepted with the naive warning; tinyint(1) consent is fine', () => {
    const r = run('mysql', my(datetime(3)));
    expect(r.problems).toEqual([]);
    expect(warnCodes(r)).toEqual(['naive_timestamp']);
  });

  test('datetime(0) also warns about precision', () => {
    expect(warnCodes(run('mysql', my(datetime(0))))).toEqual([
      'low_precision_timestamp',
      'naive_timestamp',
    ]);
  });

  test('TIMESTAMP is fine when the session is UTC', () => {
    const r = run(
      'mysql',
      my(col('viewed_at', 'timestamp', { nullable: false, precision: 3 })),
      schema(),
      '00:00:00',
    );
    expect(r.problems).toEqual([]);
    expect(warnCodes(r)).toEqual([]);
  });

  test.each([
    ['02:00:00', '+02:00'],
    ['-05:30:00', '-05:30'],
  ])('TIMESTAMP with a session %s is a problem that names the offset %s', (diff, offset) => {
    const r = run(
      'mysql',
      my(col('viewed_at', 'timestamp', { nullable: false, precision: 3 })),
      schema(),
      diff,
    );
    expect(r.problems).toEqual([
      {
        code: 'timestamp_session_timezone',
        column: 'viewed_at',
        message: `Role "timestamp" (column "viewed_at") is a MySQL TIMESTAMP, and this connection's time zone is "${offset}". dynalitics writes UTC. Use a DATETIME column, or make the connection run in UTC (for example SET time_zone = '+00:00' in your pool's init). dynalitics never changes the session itself.`,
      },
    ]);
  });

  test('a DATETIME column never triggers the session check', () => {
    expect(run('mysql', my(datetime(3)), schema(), '05:00:00').problems).toEqual([]);
  });

  test('char(n) for the page is refused because of padding; text is accepted', () => {
    const cols = my(datetime(3)).map((c) =>
      c.name === 'url' ? col('url', 'char', { maxLength: 255, nullable: false }) : c,
    );
    expect(codes(run('mysql', cols))).toEqual(['type_mismatch']);
    const text = my(datetime(3)).map((c) =>
      c.name === 'url' ? col('url', 'text', { maxLength: 65535, nullable: false }) : c,
    );
    expect(run('mysql', text).problems).toEqual([]);
  });
});

describe('existing mode: SQL Server', () => {
  const ms = (
    ts: ColumnInfo,
    page = col('url', 'nvarchar', { maxLength: -1, nullable: false }),
  ): ColumnInfo[] => [
    ts,
    col('ok', 'bit', { nullable: false }),
    page,
    col('account_id', 'nvarchar', { maxLength: 64 }),
    col('mail', 'nvarchar', { maxLength: 200 }),
  ];
  test('datetime2 warns naive, datetimeoffset is clean', () => {
    expect(
      warnCodes(run('mssql', ms(col('viewed_at', 'datetime2', { nullable: false, precision: 7 })))),
    ).toEqual(['naive_timestamp']);
    expect(
      run('mssql', ms(col('viewed_at', 'datetimeoffset', { nullable: false, precision: 7 })))
        .warnings,
    ).toEqual([]);
  });
  test('datetime and smalldatetime warn about precision, date is refused', () => {
    expect(warnCodes(run('mssql', ms(col('viewed_at', 'datetime', { nullable: false }))))).toEqual([
      'low_precision_timestamp',
    ]);
    expect(codes(run('mssql', ms(col('viewed_at', 'date', { nullable: false }))))).toEqual([
      'type_mismatch',
    ]);
  });
  test('varchar warns (non-unicode) and char/ntext are refused', () => {
    const ts = col('viewed_at', 'datetimeoffset', { nullable: false });
    expect(
      warnCodes(run('mssql', ms(ts, col('url', 'varchar', { maxLength: 300, nullable: false })))),
    ).toEqual(['non_unicode_column']);
    expect(
      codes(run('mssql', ms(ts, col('url', 'ntext', { maxLength: -1, nullable: false })))),
    ).toEqual(['type_mismatch']);
  });
});

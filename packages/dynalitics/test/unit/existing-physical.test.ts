import { describe, expect, test } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import type { ColumnInfo } from '../../src/dialect/types.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import { adoptPhysical } from '../../src/model/physical.js';
import type { SchemaConfig } from '../../src/model/types.js';

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
const existing: SchemaConfig = {
  table: 'legacy.views',
  tableMode: 'existing',
  columns: {
    timestamp: 'viewed_at',
    consent: 'ok',
    pageVisited: 'url',
    email: 'mail',
    userId: 'uid',
  },
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, column: 'plan_code' } },
};
const catalog = [
  col('viewed_at', 'timestamp'),
  col('ok', 'int2'),
  col('url', 'varchar', { maxLength: 200 }),
  col('mail', 'text'),
  col('uid', 'varchar', { maxLength: 40 }),
  col('plan_code', 'varchar', { maxLength: 8 }),
  col('other', 'text'),
];

describe('adoptPhysical', () => {
  test('records the real type of every mapped column', () => {
    const m = adoptPhysical(buildColumnModel(existing), catalog, 'postgres').model;
    expect(Object.fromEntries(m.columns.map((c) => [c.name, c.physicalType]))).toEqual({
      viewed_at: 'timestamp',
      ok: 'int2',
      url: 'varchar',
      mail: 'text',
      uid: 'varchar',
      plan_code: 'varchar',
    });
  });

  test('existing mode adopts min(configured, real) and reports what changed', () => {
    const before = buildColumnModel(existing);
    const { model, adopted } = adoptPhysical(before, catalog, 'postgres');
    const len = (name: string): number | undefined => {
      const t = model.columns.find((c) => c.name === name)?.type;
      return t?.kind === 'string' ? t.maxLength : undefined;
    };
    expect(len('url')).toBe(200); // configured 512
    expect(len('uid')).toBe(40); // configured 128
    expect(len('mail')).toBe(320); // text: unlimited, keeps the configured maximum
    expect(model.customFields.get('plan')?.maxLength).toBe(8);
    expect(model.customFields.get('plan')?.column).toBe(
      model.columns.find((c) => c.name === 'plan_code'),
    );
    expect(adopted).toEqual([
      { column: 'url', configured: 512, real: 200 },
      { column: 'uid', configured: 128, real: 40 },
      { column: 'plan_code', configured: 32, real: 8 },
    ]);
    // identity points at the updated definition, not the old one
    expect(model.identity.userId).toBe(model.columns.find((c) => c.name === 'uid'));
  });

  test('a longer real column never raises the configured maximum', () => {
    const wide = catalog.map((c) =>
      c.name === 'url' ? col('url', 'varchar', { maxLength: 4000 }) : c,
    );
    const { model, adopted } = adoptPhysical(buildColumnModel(existing), wide, 'postgres');
    expect(model.columns.find((c) => c.name === 'url')?.type).toEqual({
      kind: 'string',
      maxLength: 512,
    });
    expect(adopted.map((a) => a.column)).not.toContain('url');
  });

  test.each([
    ['mssql', -1],
    ['postgres', null],
  ] as const)('unlimited columns (%s) keep the configured maximum', (dialect, max) => {
    const unlimited = catalog.map((c) =>
      c.name === 'url' ? col('url', 'nvarchar', { maxLength: max }) : c,
    );
    const m = adoptPhysical(buildColumnModel(existing), unlimited, dialect).model;
    expect(m.columns.find((c) => c.name === 'url')?.type).toEqual({
      kind: 'string',
      maxLength: 512,
    });
  });

  test('recommended mode keeps its lengths (a short column is the too_short problem there)', () => {
    const m = adoptPhysical(
      buildColumnModel({ table: 'public.events' }),
      [col('page_visited', 'varchar', { maxLength: 10 })],
      'postgres',
    );
    expect(m.adopted).toEqual([]);
    expect(m.model.columns.find((c) => c.name === 'page_visited')?.type).toEqual({
      kind: 'string',
      maxLength: 512,
    });
    expect(m.model.columns.find((c) => c.name === 'page_visited')?.physicalType).toBe('varchar');
  });

  test('names match case-insensitively on MySQL and SQL Server only', () => {
    const upper = [col('VIEWED_AT', 'datetime')];
    expect(
      adoptPhysical(buildColumnModel(existing), upper, 'mysql').model.columns[0]?.physicalType,
    ).toBe('datetime');
    expect(
      adoptPhysical(buildColumnModel(existing), upper, 'postgres').model.columns[0]?.physicalType,
    ).toBeUndefined();
  });

  test('never mutates the model it was given', () => {
    const before = buildColumnModel(existing);
    const snapshot = JSON.stringify(before.columns);
    adoptPhysical(before, catalog, 'postgres');
    expect(JSON.stringify(before.columns)).toBe(snapshot);
  });
});

describe('inserts use the real column type', () => {
  const rows = (m: ReturnType<typeof buildColumnModel>) => [
    m.insertColumns.map((c) =>
      c.type.kind === 'boolean'
        ? true
        : c.type.kind === 'timestamp'
          ? '2026-10-30T12:00:00.000Z'
          : 'x',
    ),
  ];

  test('a boolean written to an integer column is bound as 1/0, on every dialect', () => {
    for (const dialect of ['postgres', 'mysql', 'mssql'] as const) {
      const m = adoptPhysical(buildColumnModel(existing), catalog, dialect).model;
      const q = getDialect(dialect).buildInsert(
        m,
        rows(m).map((r) => r.map((v) => v)),
      );
      const consentIndex = m.insertColumns.findIndex((c) => c.role === 'consent');
      expect(q.params[consentIndex]).toBe(1);
      const off = getDialect(dialect).buildInsert(m, [
        rows(m)[0]!.map((v, i) => (i === consentIndex ? false : v)),
      ]);
      expect(off.params[consentIndex]).toBe(0);
    }
  });

  test('a real boolean column keeps true/false', () => {
    const asBool = catalog.map((c) => (c.name === 'ok' ? col('ok', 'bool') : c));
    const m = adoptPhysical(buildColumnModel(existing), asBool, 'postgres').model;
    const idx = m.insertColumns.findIndex((c) => c.role === 'consent');
    expect(getDialect('postgres').buildInsert(m, rows(m)).params[idx]).toBe(true);
  });

  test('without catalog information (recommended, unit tests) nothing changes', () => {
    const m = buildColumnModel({ table: 't' });
    const idx = m.insertColumns.findIndex((c) => c.role === 'consent');
    expect(
      getDialect('postgres').buildInsert(m, [
        m.insertColumns.map((c) =>
          c.type.kind === 'boolean'
            ? true
            : c.type.kind === 'timestamp'
              ? '2026-10-30T12:00:00.000Z'
              : c.type.kind === 'json'
                ? '{}'
                : 'x',
        ),
      ]).params[idx],
    ).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import { DynaliticsConfigError } from '../../src/errors.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { SchemaConfig } from '../../src/model/types.js';

const base: SchemaConfig = {
  table: 'legacy.page_views',
  tableMode: 'existing',
  columns: { timestamp: 'viewed_at_utc', consent: 'gdpr_ok', pageVisited: 'url' },
};
const issuesOf = (schema: SchemaConfig): string[] => {
  try {
    buildColumnModel(schema);
  } catch (e) {
    if (e instanceof DynaliticsConfigError) return [...e.issues];
    throw e;
  }
  return [];
};

describe('tableMode "existing": explicit role mapping', () => {
  test('maps only what is listed; everything else is unmapped and not stored', () => {
    const m = buildColumnModel({ ...base, columns: { ...base.columns, userId: 'account_id' } });
    expect(m.mode).toBe('existing');
    expect(m.columns.map((c) => [c.role, c.name])).toEqual([
      ['timestamp', 'viewed_at_utc'],
      ['consent', 'gdpr_ok'],
      ['pageVisited', 'url'],
      ['userId', 'account_id'],
    ]);
    expect(m.unmappedRoles).toEqual(['ip', 'username', 'email', 'custom', 'id']);
    expect(m.identity.userId?.name).toBe('account_id');
  });

  test('a mapped id column is never inserted', () => {
    const m = buildColumnModel({ ...base, columns: { ...base.columns, id: 'view_id' } });
    expect(m.columns.find((c) => c.role === 'id')?.dbGenerated).toBe(true);
    expect(m.insertColumns.map((c) => c.name)).toEqual(['viewed_at_utc', 'gdpr_ok', 'url']);
  });

  test('false means "not stored", same as omitting the role', () => {
    const m = buildColumnModel({ ...base, columns: { ...base.columns, email: false } });
    expect(m.columns.some((c) => c.role === 'email')).toBe(false);
    expect(m.unmappedRoles).toContain('email');
  });

  test.each(['timestamp', 'consent', 'pageVisited'] as const)(
    'the required role %s must be mapped (omitted)',
    (role) => {
      const columns = { ...base.columns };
      delete columns[role];
      expect(issuesOf({ ...base, columns })).toEqual([
        `columns.${role} is required when tableMode is "existing" (timestamp, consent and pageVisited must be mapped).`,
      ]);
    },
  );

  test('a required role cannot be false', () => {
    expect(issuesOf({ ...base, columns: { ...base.columns, consent: false } })).toEqual([
      expect.stringContaining('columns.consent is required'),
    ]);
  });

  test('no columns at all lists all three required roles', () => {
    expect(issuesOf({ table: base.table, tableMode: 'existing' })).toHaveLength(3);
  });

  test('two roles on one physical column are refused, case-insensitively', () => {
    expect(
      issuesOf({ ...base, columns: { ...base.columns, email: 'Contact', username: 'contact' } }),
    ).toEqual([
      expect.stringContaining(
        'columns.username and columns.email both map to "Contact"; each role needs its own column',
      ),
    ]);
  });

  test('the strict identifier pattern still applies to legacy names', () => {
    for (const bad of ['viewed at', 'a-b', 'url; DROP TABLE x', '"x"', '1st']) {
      expect(issuesOf({ ...base, columns: { ...base.columns, pageVisited: bad } })[0]).toMatch(
        /columns\.pageVisited/,
      );
    }
  });

  test('schema-qualified names: schema.table and database.schema.table', () => {
    expect(buildColumnModel({ ...base, table: 'sales.page_views' }).table).toEqual({
      schema: 'sales',
      name: 'page_views',
    });
    expect(
      buildColumnModel({ ...base, table: { database: 'd', schema: 's', name: 't' } }).table,
    ).toEqual({ database: 'd', schema: 's', name: 't' });
    expect(issuesOf({ ...base, table: 'sales.page views' }).length).toBeGreaterThan(0);
  });

  test('custom fields need a promoted column when there is no mapped JSON column', () => {
    expect(issuesOf({ ...base, customFields: { plan: { type: 'string' } } })[0]).toMatch(
      /customFields\.plan is not promoted to a column and no JSON column is mapped/,
    );
    const m = buildColumnModel({
      ...base,
      customFields: {
        plan: { type: 'string', maxLength: 32, personal: false, column: 'plan_code' },
      },
    });
    expect(m.columns.at(-1)).toMatchObject({ role: 'promoted', name: 'plan_code' });
  });

  describe('first visit', () => {
    test('isFirstVisit mapped while firstVisit.enabled is false is an error', () => {
      expect(
        issuesOf({ ...base, columns: { ...base.columns, userId: 'u', isFirstVisit: 'first' } }),
      ).toEqual([
        'columns.isFirstVisit is mapped but firstVisit.enabled is false. Enable write-time first-visit detection or unmap the column.',
      ]);
    });
    test('firstVisit.enabled without a mapped isFirstVisit column is an error', () => {
      expect(
        issuesOf({
          ...base,
          columns: { ...base.columns, userId: 'u' },
          firstVisit: { enabled: true },
        }),
      ).toEqual([
        'firstVisit.enabled needs columns.isFirstVisit and at least one of columns.userId, columns.ip.',
      ]);
    });
    test('works when mapped together with an identity column', () => {
      const m = buildColumnModel({
        ...base,
        columns: { ...base.columns, userId: 'u', isFirstVisit: 'first' },
        firstVisit: { enabled: true },
      });
      expect(m.firstVisitEnabled).toBe(true);
      expect(m.columns.some((c) => c.role === 'isFirstVisit')).toBe(true);
    });
  });

  test('recommended mode is unchanged: omitted roles still get default names', () => {
    const m = buildColumnModel({ table: 't' });
    expect(m.mode).toBe('recommended');
    expect(m.columns.map((c) => c.name)).toContain('visited_at');
  });

  test('the input is never mutated', () => {
    const input = structuredClone(base);
    buildColumnModel(input);
    expect(input).toEqual(base);
  });
});

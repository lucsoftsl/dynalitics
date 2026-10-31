import { describe, expect, test } from 'vitest';
import { buildColumnModel } from '../../src/model/column-model.js';
import { DynaliticsConfigError } from '../../src/errors.js';

const names = (m: ReturnType<typeof buildColumnModel>) => m.columns.map((c) => c.name);

describe('buildColumnModel (recommended mode)', () => {
  test('defaults produce the recommended table without is_first_visit', () => {
    const m = buildColumnModel({ table: 'public.dynalitics_events' });
    expect(names(m)).toEqual([
      'id',
      'visited_at',
      'consent',
      'page_visited',
      'ip_address',
      'user_id',
      'username',
      'email',
      'custom',
    ]);
    expect(m.table).toEqual({ schema: 'public', name: 'dynalitics_events' });
    expect(m.mode).toBe('recommended');
    expect(m.insertColumns.map((c) => c.name)).not.toContain('id');
    expect(m.identity.userId?.name).toBe('user_id');
    expect(m.identity.ip?.name).toBe('ip_address');
  });

  test('personal flags and nullability follow the spec', () => {
    const m = buildColumnModel({ table: 't' });
    const by = (n: string) => m.columns.find((c) => c.name === n)!;
    expect(by('visited_at')).toMatchObject({ nullable: false, personal: false });
    expect(by('consent')).toMatchObject({ nullable: false, personal: false });
    expect(by('page_visited')).toMatchObject({
      nullable: false,
      type: { kind: 'string', maxLength: 512 },
    });
    for (const n of ['ip_address', 'user_id', 'username', 'email']) {
      expect(by(n)).toMatchObject({ nullable: true, personal: true });
    }
    expect(by('id').dbGenerated).toBe(true);
  });

  test('renames roles, disables optional roles and reports them as unmapped', () => {
    const m = buildColumnModel({
      table: 't',
      columns: { timestamp: 'created_at', email: false, id: false },
    });
    expect(names(m)).toContain('created_at');
    expect(names(m)).not.toContain('email');
    expect(names(m)).not.toContain('id');
    expect(m.unmappedRoles).toEqual(['email', 'id']);
  });

  test('is_first_visit exists only when firstVisit.enabled', () => {
    const m = buildColumnModel({ table: 't', firstVisit: { enabled: true } });
    expect(names(m)).toContain('is_first_visit');
    expect(() => buildColumnModel({ table: 't', columns: { isFirstVisit: 'x' } })).toThrow(
      /columns.isFirstVisit is mapped but firstVisit.enabled is false/,
    );
    expect(() =>
      buildColumnModel({
        table: 't',
        firstVisit: { enabled: true },
        columns: { userId: false, ip: false },
      }),
    ).toThrow(/at least one of columns.userId, columns.ip/);
    expect(() =>
      buildColumnModel({
        table: 't',
        firstVisit: { enabled: true },
        columns: { isFirstVisit: false },
      }),
    ).toThrow(DynaliticsConfigError);
  });

  test('required roles cannot be disabled', () => {
    for (const role of ['timestamp', 'consent', 'pageVisited'] as const) {
      expect(() => buildColumnModel({ table: 't', columns: { [role]: false } })).toThrow(
        new RegExp(`columns.${role} is required`),
      );
    }
  });

  test('rejects unsafe column names and collisions (case-insensitive)', () => {
    expect(() => buildColumnModel({ table: 't', columns: { email: 'e; DROP TABLE x' } })).toThrow(
      /not supported/,
    );
    expect(() => buildColumnModel({ table: 't', columns: { email: 'USERNAME' } })).toThrow(
      /both map to/,
    );
  });

  test('rejects an unsafe table name', () => {
    expect(() => buildColumnModel({ table: 'a b' })).toThrow(DynaliticsConfigError);
  });

  describe('custom fields', () => {
    test('JSON fields stay in custom, promoted fields get their own column', () => {
      const m = buildColumnModel({
        table: 't',
        customFields: {
          plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
          locale: { type: 'string', maxLength: 16, personal: false, column: true },
          seats: { type: 'integer', column: 'seat_count' },
          campaign: { type: 'string' },
        },
      });
      expect(names(m)).toContain('locale');
      expect(names(m)).toContain('seat_count');
      expect(m.customFields.get('plan')).toMatchObject({
        personal: false,
        breakdown: true,
        maxLength: 32,
      });
      expect(m.customFields.get('campaign')).toMatchObject({ personal: true, maxLength: 128 });
      expect(m.customFields.get('locale')?.column?.name).toBe('locale');
      expect(m.customFields.get('seats')?.column?.type).toEqual({ kind: 'integer' });
      expect(m.customFields.get('plan')?.column).toBeUndefined();
    });

    test('validates keys, flags and the custom column', () => {
      expect(() =>
        buildColumnModel({
          table: 't',
          customFields: Object.fromEntries([['__proto__', { type: 'string' }]]) as never,
        }),
      ).toThrow(/not a valid custom field key/);
      expect(() =>
        buildColumnModel({
          table: 't',
          customFields: { plan: { type: 'string', breakdown: true } },
        }),
      ).toThrow(/breakdown.*personal: false/);
      expect(() =>
        buildColumnModel({
          table: 't',
          columns: { custom: false },
          customFields: { plan: { type: 'string' } },
        }),
      ).toThrow(/not promoted to a column and no JSON column is mapped/);
      expect(() =>
        buildColumnModel({ table: 't', customFields: { x: { type: 'string', column: 'a b' } } }),
      ).toThrow(/not supported/);
      expect(() =>
        buildColumnModel({ table: 't', customFields: { x: { type: 'string', maxLength: 5000 } } }),
      ).toThrow(/maxLength/);
    });

    test('custom: false is fine when every field is promoted', () => {
      const m = buildColumnModel({
        table: 't',
        columns: { custom: false },
        customFields: { plan: { type: 'string', column: true } },
      });
      expect(names(m)).not.toContain('custom');
    });
  });

  test('keepWhenDenied requires personal: false and is resolved onto the field', () => {
    expect(() =>
      buildColumnModel({
        table: 't',
        customFields: { plan: { type: 'string', keepWhenDenied: true } },
      }),
    ).toThrow(/keepWhenDenied.*personal: false/);
    const m = buildColumnModel({
      table: 't',
      customFields: {
        plan: { type: 'string', personal: false, keepWhenDenied: true },
        tier: { type: 'string', personal: false },
      },
    });
    expect(m.customFields.get('plan')?.keepWhenDenied).toBe(true);
    expect(m.customFields.get('tier')?.keepWhenDenied).toBe(false);
  });

  test('does not mutate its input', () => {
    const input = Object.freeze({
      table: 't',
      columns: Object.freeze({ email: false as const }),
      customFields: Object.freeze({ plan: Object.freeze({ type: 'string' as const }) }),
    });
    expect(() => buildColumnModel(input)).not.toThrow();
  });

  test('tableMode existing without the three required roles lists all of them', () => {
    expect(() => buildColumnModel({ table: 't', tableMode: 'existing' })).toThrow(
      /columns\.timestamp is required[\s\S]*columns\.consent is required[\s\S]*columns\.pageVisited is required/,
    );
  });
});

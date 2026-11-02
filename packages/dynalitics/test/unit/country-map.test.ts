/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- test code reading untyped JSON responses */
// docs/SPEC.md section 21: the country map (geo field, extendedAnalyticsEnabled, /api/countries, /api/world-map).
import { describe, expect, test } from 'vitest';
import { validateConfig } from '../../src/config/schema.js';
import { DynaliticsConfigError } from '../../src/errors.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { CustomFieldDef, SchemaConfig } from '../../src/model/types.js';
import { createHandler, type HandlerOptions } from '../../src/read/handler.js';
import { WORLD_MAP } from '../../src/read/geo/world-map.js';
import type { DynaliticsRequest } from '../../src/read/types.js';
import { readFixture, type Answers } from '../helpers/read-fixture.js';

const COUNTRY: CustomFieldDef = {
  type: 'string',
  maxLength: 2,
  personal: false,
  breakdown: true,
  geo: 'country',
};
const GEO: Partial<SchemaConfig> = {
  customFields: {
    plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
    country: COUNTRY,
  },
};
const RANGE = { from: '2026-10-28', to: '2026-10-30' };

const req = (path: string, query: Record<string, string> = {}): DynaliticsRequest => ({
  method: 'GET',
  path,
  query,
  headers: {},
  raw: {},
});

function setup(
  schema: Partial<SchemaConfig> = GEO,
  answers: Answers = {},
  options: Partial<HandlerOptions> = { extendedAnalyticsEnabled: true },
) {
  const f = readFixture(answers, schema);
  const handler = createHandler(f.dyn, { authorize: () => true, scope: 'none', ...options });
  const call = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle(req(path, query));
    return { status: res.status, body: JSON.parse(res.body) as Record<string, any> };
  };
  return { ...f, call };
}

const modelIssues = (customFields: Record<string, CustomFieldDef>): string[] => {
  try {
    buildColumnModel({ table: 'events', customFields });
    return [];
  } catch (err) {
    return err instanceof DynaliticsConfigError ? [...err.issues] : [String(err)];
  }
};

describe("config: customFields.<key>.geo: 'country'", () => {
  test('accepted on a non-personal string breakdown field, JSON or promoted', () => {
    expect(modelIssues({ country: COUNTRY })).toEqual([]);
    expect(modelIssues({ country: { ...COUNTRY, column: 'country_code' } })).toEqual([]);
    const model = buildColumnModel({ table: 'events', customFields: { country: COUNTRY } });
    expect(model.customFields.get('country')?.geo).toBe('country');
  });

  test('refused unless type string, personal false and breakdown true', () => {
    for (const bad of [
      { ...COUNTRY, type: 'integer' as const },
      { ...COUNTRY, personal: true, breakdown: false },
      { type: 'string' as const, breakdown: true, geo: 'country' as const }, // personal defaults to true
      { ...COUNTRY, breakdown: false },
    ]) {
      expect(modelIssues({ country: bad }).join('\n')).toMatch(
        /requires (type: 'string', )?personal: false/,
      );
    }
  });

  test('at most one geo field', () => {
    expect(modelIssues({ country: COUNTRY, country2: COUNTRY }).join('\n')).toContain(
      "only one custom field can be geo: 'country'",
    );
  });

  test('geo accepts only "country"', () => {
    expect(() =>
      validateConfig({
        adapter: { dialect: 'postgres', createDriver: () => ({}) },
        connection: { connectionString: 'postgres://x' },
        acknowledgeSingleCredential: true,
        table: 'events',
        customFields: { city: { type: 'string', personal: false, breakdown: true, geo: 'city' } },
      }),
    ).toThrow(/customFields\.city\.geo: expected one of "country"/);
  });

  test('createHandler: extendedAnalyticsEnabled must be a boolean', () => {
    const f = readFixture({}, GEO);
    expect(() =>
      createHandler(f.dyn, {
        authorize: () => true,
        scope: 'none',
        extendedAnalyticsEnabled: 'yes' as never,
      }),
    ).toThrow(/extendedAnalyticsEnabled/);
  });
});

describe('meta: widgets.countryMap', () => {
  test('off by default (disabled_by_host), routes 404, no SQL', async () => {
    const { call, sql } = setup(GEO, {}, {});
    const meta = (await call('/api/meta')).body.data;
    expect(meta.widgets.countryMap).toMatchObject({ available: false, reason: 'disabled_by_host' });
    expect(meta.widgets.countryMap.message).toContain('extendedAnalyticsEnabled');
    expect(meta.countryMap).toBeUndefined();
    for (const path of ['/api/countries', '/api/world-map']) {
      const r = await call(path, path === '/api/countries' ? RANGE : {});
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('not_found');
    }
    expect(sql()).toEqual([]);
  });

  test('switched on without a geo field: column_not_mapped, routes 404', async () => {
    const { call } = setup({});
    const meta = (await call('/api/meta')).body.data;
    expect(meta.widgets.countryMap).toMatchObject({
      available: false,
      reason: 'column_not_mapped',
    });
    expect(meta.countryMap).toBeUndefined();
    expect((await call('/api/world-map')).status).toBe(404);
  });

  test('switched on with a geo field: available and names the field', async () => {
    const { call } = setup();
    const meta = (await call('/api/meta')).body.data;
    expect(meta.widgets.countryMap).toEqual({ available: true });
    expect(meta.countryMap).toEqual({ field: 'country' });
    expect(meta.breakdowns.map((b: { key: string }) => b.key)).toContain('country');
  });
});

describe('GET /api/countries', () => {
  test('groups, upper-cases, merges, folds junk and XX into unknown, sorts', async () => {
    const { call } = setup(GEO, {
      topTotal: [{ n: '20' }],
      breakdownTop: [
        { v: 'ES', n: '6' },
        { v: 'es', n: '2' },
        { v: 'US', n: '3' },
        { v: 'DE', n: 3 },
        { v: 'XX', n: '1' },
        { v: '<script>', n: '1' },
        { v: 'T1', n: '1' },
      ],
    });
    const r = await call('/api/countries', RANGE);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      total: 20,
      countries: [
        { code: 'ES', visits: 8 },
        { code: 'DE', visits: 3 },
        { code: 'US', visits: 3 },
      ],
      unknown: 6,
    });
    expect(JSON.stringify(r.body)).not.toContain('script');
  });

  test('a race that lists more than the total is clamped and reported', async () => {
    const { call, errors } = setup(GEO, {
      topTotal: [{ n: '1' }],
      breakdownTop: [{ v: 'FR', n: '3' }],
    });
    const r = await call('/api/countries', RANGE);
    expect(r.body.data).toEqual({ total: 3, countries: [{ code: 'FR', visits: 3 }], unknown: 0 });
    expect(errors.some((e) => e.message.includes('countries'))).toBe(true);
  });

  test('strict parameters and the range cap', async () => {
    const { call } = setup();
    expect((await call('/api/countries', { ...RANGE, interval: 'day' })).body.error).toMatchObject({
      code: 'invalid_parameter',
      param: 'interval',
    });
    expect(
      (await call('/api/countries', { from: '2020-01-01', to: '2026-01-01' })).body.error.code,
    ).toBe('range_too_large');
  });

  test('SQL: bound, scoped, at most 300 values, on every dialect; JSON and promoted fields', async () => {
    for (const dialect of ['postgres', 'mysql', 'mssql'] as const) {
      for (const country of [COUNTRY, { ...COUNTRY, column: 'country_code' }]) {
        const f = readFixture({}, { customFields: { country } }, { dialect });
        const handler = createHandler(f.dyn, {
          authorize: () => true,
          scope: { column: 'site', value: 'shop' },
          extendedAnalyticsEnabled: true,
        });
        await handler.handle(req('/api/countries', RANGE));
        const queries = f.driver.calls;
        expect(queries).toHaveLength(2);
        for (const q of queries) {
          expect(q.sql).toContain('site');
          expect(q.sql).not.toContain('shop');
          expect(q.params.slice(-1)).toEqual(['shop']);
        }
        const grouped = queries[1]!.sql;
        expect(grouped).toMatch(/300/);
        expect(grouped).toContain(country.column === undefined ? 'country' : 'country_code');
      }
    }
  });
});

describe('GET /api/world-map', () => {
  test('serves the shapes; takes no parameters', async () => {
    const { call, sql } = setup();
    const r = await call('/api/world-map');
    expect(r.status).toBe(200);
    expect(r.body.data.width).toBe(1920);
    expect(r.body.data.countries.length).toBe(WORLD_MAP.countries.length);
    expect(sql()).toEqual([]);
    expect((await call('/api/world-map', { from: '2026-10-01' })).body.error).toMatchObject({
      code: 'invalid_parameter',
      param: 'from',
    });
  });

  test('the generated data: ISO codes, sorted, unique, path data limited to M, l, z and integers', () => {
    const codes = WORLD_MAP.countries.map((c) => c.code);
    expect(codes.length).toBeGreaterThan(170);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of WORLD_MAP.countries) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      expect(c.d).toMatch(/^[Mlz0-9 -]+$/);
    }
    for (const code of ['US', 'ES', 'FR', 'NO', 'SO', 'CY', 'XK', 'TW'])
      expect(codes).toContain(code);
    expect(codes).not.toContain('AQ');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- test code reading untyped JSON responses */
// docs/SPEC.md section 20: request outcome (HTTP status + error code), the /api/errors route and the explorer fields.
import { describe, expect, test } from 'vitest';
import { getDialect } from '../../src/dialect/index.js';
import { errorReasonOf } from '../../src/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { Dialect, SchemaConfig } from '../../src/model/types.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsRequest } from '../../src/read/types.js';
import { generateSql } from '../../src/schema/generate.js';
import { buildRow, type RowConfig } from '../../src/track/build-row.js';
import { readFixture, type Answers } from '../helpers/read-fixture.js';

const NOW = new Date('2026-10-30T12:01:44.120Z');
const OUTCOME: Partial<SchemaConfig> = { columns: { status: true, errorReason: true } };
const cfg: RowConfig = {
  page: { keepQuery: false, maxLength: 512 },
  ip: { mode: 'truncate', salt: undefined, ipv4Prefix: 24, ipv6Prefix: 48 },
  limits: { customMaxKeys: 20, customMaxBytes: 4096, oversize: 'truncate' },
  consentDefault: undefined,
};

function row(visit: Record<string, unknown>, schema: Partial<SchemaConfig> = OUTCOME) {
  const model = buildColumnModel({ table: 'events', ...schema });
  const r = buildRow({
    model,
    dialect: getDialect('postgres'),
    cfg,
    visit: visit as never,
    now: NOW,
  });
  if (!r.ok) throw new Error(r.issues.join('; '));
  const at = (name: string) => r.values[model.insertColumns.findIndex((c) => c.name === name)];
  return { r, at, model };
}

describe('column model: status and errorReason are opt-in', () => {
  test('the recommended table has neither unless asked for', () => {
    const names = buildColumnModel({ table: 'events' }).columns.map((c) => c.name);
    expect(names).not.toContain('status_code');
    expect(names).not.toContain('error_reason');
  });
  test('true picks the default names; a string renames; both are non-personal', () => {
    const m = buildColumnModel({ table: 'events', columns: { status: true, errorReason: 'why' } });
    const status = m.columns.find((c) => c.role === 'status');
    const reason = m.columns.find((c) => c.role === 'errorReason');
    expect(status).toMatchObject({
      name: 'status_code',
      type: { kind: 'integer' },
      personal: false,
    });
    expect(reason).toMatchObject({
      name: 'why',
      type: { kind: 'string', maxLength: 64 },
      personal: false,
    });
  });
  test('existing mode maps them like any other role; true means the default name', () => {
    const m = buildColumnModel({
      table: 'events',
      tableMode: 'existing',
      columns: { timestamp: 'ts', consent: 'c', pageVisited: 'p', status: true },
    });
    expect(m.columns.find((c) => c.role === 'status')?.name).toBe('status_code');
    expect(m.columns.some((c) => c.role === 'errorReason')).toBe(false);
  });
  test('`dynalitics sql` emits the columns in every dialect', () => {
    for (const dialect of ['postgres', 'mysql', 'mssql'] as const) {
      const sql = generateSql({ dialect, schema: { table: 'events', ...OUTCOME } }).createTable;
      expect(sql).toMatch(/status_code\S*\s+bigint( NULL)?,/i);
      expect(sql).toMatch(/error_reason\S*\s+n?varchar\(64\)/i);
    }
  });
});

describe('track(): status and errorReason', () => {
  test('stored, and KEPT when consent is denied (they describe the response, not the visitor)', () => {
    for (const consent of [true, false]) {
      const { at } = row({ pageVisited: '/a', consent, status: 503, errorReason: 'ECONNREFUSED' });
      expect(at('status_code')).toBe(503);
      expect(at('error_reason')).toBe('ECONNREFUSED');
    }
  });
  test('a bad status is NULL and reported; the visit is kept', () => {
    for (const bad of [99, 600, 200.5, '500', true, Number.NaN]) {
      const { r, at } = row({ pageVisited: '/a', consent: true, status: bad });
      expect(at('status_code')).toBeNull();
      expect(r.notes.map((n) => n.message)).toEqual([
        expect.stringMatching(/status must be an integer/),
      ]);
    }
  });
  test('a reason that is not code-shaped (a message, an email, a URL) is NULL and never echoed', () => {
    for (const bad of [
      'Cannot read properties of undefined',
      'jane@example.com',
      'https://x.test/a',
      '1abc',
      'a'.repeat(65),
      42,
    ]) {
      const { r, at } = row({ pageVisited: '/a', consent: true, status: 500, errorReason: bad });
      expect(at('error_reason')).toBeNull();
      expect(r.notes).toHaveLength(1);
      expect(JSON.stringify(r.notes)).not.toContain(String(bad));
    }
    for (const good of ['ECONNREFUSED', 'payment.declined', 'P2002', 'db:timeout', 'Not-Found'])
      expect(row({ pageVisited: '/a', status: 500, errorReason: good }).at('error_reason')).toBe(
        good,
      );
  });
  test('absent / null / empty -> NULL with no note; unmapped columns ignore the fields', () => {
    const { r, at } = row({ pageVisited: '/a', consent: true, status: null, errorReason: '' });
    expect([at('status_code'), at('error_reason')]).toEqual([null, null]);
    expect(r.notes).toEqual([]);
    const plain = row({ pageVisited: '/a', consent: true, status: 'bad' }, {});
    expect(plain.r.notes).toEqual([]);
    expect(plain.model.insertColumns.map((c) => c.name)).not.toContain('status_code');
  });
});

describe('errorReasonOf()', () => {
  test('code first, then name, never the message', () => {
    const e = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 for jane@example.com'), {
      code: 'ECONNREFUSED',
    });
    expect(errorReasonOf(e)).toBe('ECONNREFUSED');
    expect(errorReasonOf(new TypeError('x'))).toBe('TypeError');
    expect(errorReasonOf(Object.assign(new Error('x'), { code: 'not a code!' }))).toBe('Error');
    expect(errorReasonOf({ name: 'has space', code: 23505 })).toBeNull();
    for (const v of [null, undefined, 'ECONNREFUSED', 42]) expect(errorReasonOf(v)).toBeNull();
  });
});

const req = (path: string, query: Record<string, string> = {}): DynaliticsRequest => ({
  method: 'GET',
  path,
  query,
  headers: {},
  raw: {},
});
function setup(schema: Partial<SchemaConfig> = OUTCOME, answers: Answers = {}, dialect?: Dialect) {
  const f = readFixture(answers, schema, dialect === undefined ? {} : { dialect });
  const handler = createHandler(f.dyn, { authorize: () => true, scope: 'none' });
  const call = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle(req(path, query));
    return { status: res.status, body: JSON.parse(res.body) as Record<string, any> };
  };
  return { ...f, call };
}
const RANGE = { from: '2026-10-28', to: '2026-10-30', interval: 'day' };

describe('GET /api/errors', () => {
  test('unavailable (HTTP 200) when no status column is mapped, and meta says so', async () => {
    const { call, sql } = setup({});
    const r = await call('/api/errors', RANGE);
    expect(r.status).toBe(200);
    expect(r.body.unavailable).toMatchObject({ reason: 'column_not_mapped' });
    expect(sql()).toEqual([]);
    const meta = (await call('/api/meta')).body.data;
    expect(meta.widgets.errors).toMatchObject({ available: false, reason: 'column_not_mapped' });
    expect(meta.fields).toMatchObject({ status: false, errorReason: false });
  });

  test('zero-filled series, totals, rate, top pages and top reasons', async () => {
    const { call } = setup(OUTCOME, {
      errorsSeries: [{ bucket: '2026-10-29T00:00:00.000Z', total: '40', c4: '6', c5: '2' }],
      errorPages: [{ page: '/checkout', n: '5', c5: '2' }],
      errorReasons: [
        { rsn: 'ECONNREFUSED', st: 503, n: 2 },
        { rsn: null, st: 404, n: 6 },
      ],
    });
    const r = await call('/api/errors', RANGE);
    expect(r.body.data).toEqual({
      interval: 'day',
      points: [
        {
          bucket: '2026-10-28T00:00:00.000Z',
          total: 0,
          clientErrors: 0,
          serverErrors: 0,
          rate: null,
        },
        {
          bucket: '2026-10-29T00:00:00.000Z',
          total: 40,
          clientErrors: 6,
          serverErrors: 2,
          rate: 0.2,
        },
      ],
      totals: { total: 40, clientErrors: 6, serverErrors: 2, rate: 0.2 },
      pages: [{ page: '/checkout', errors: 5, serverErrors: 2 }],
      reasons: [
        { reason: 'ECONNREFUSED', status: 503, count: 2 },
        { reason: null, status: 404, count: 6 },
      ],
      reasonsStored: true,
    });
    expect(r.body.meta.interval).toBe('day');
  });

  test('strict parameters and the bucket cap apply', async () => {
    const { call } = setup();
    expect((await call('/api/errors', { ...RANGE, q: 'x' })).body.error).toMatchObject({
      code: 'invalid_parameter',
      param: 'q',
    });
    expect(
      (await call('/api/errors', { from: '2026-01-01', to: '2026-03-30', interval: 'hour' })).body
        .error.code,
    ).toBe('range_too_large');
  });

  test('SQL: every value bound, scoped, only rows with a status; parameters in text order on every dialect', async () => {
    for (const dialect of ['postgres', 'mysql', 'mssql'] as const) {
      const f = readFixture({}, OUTCOME, { dialect });
      const handler = createHandler(f.dyn, {
        authorize: () => true,
        scope: { column: 'site', value: 'shop' },
      });
      await handler.handle(req('/api/errors', RANGE));
      const queries = f.driver.calls;
      expect(queries).toHaveLength(3);
      for (const q of queries) {
        expect(q.sql).toMatch(/status_code.{0,2} (IS NOT NULL|>= 400)/);
        expect(q.sql).toContain('site');
        expect(q.sql).not.toContain('shop');
        expect(q.params.slice(-1)).toEqual(['shop']);
      }
    }
  });

  test('reasons are NULL (and reasonsStored false) when only status is mapped', async () => {
    const { call, sql } = setup(
      { columns: { status: true } },
      { errorReasons: [{ rsn: null, st: 500, n: 1 }] },
    );
    const r = await call('/api/errors', RANGE);
    expect(r.body.data.reasonsStored).toBe(false);
    expect(r.body.data.reasons).toEqual([{ reason: null, status: 500, count: 1 }]);
    expect(sql().join('\n')).toContain('NULL AS rsn');
  });
});

describe('visits, breakdowns and the explorer carry the outcome', () => {
  test('recent visits include status and errorReason only when mapped', async () => {
    const base = { rid: '1', ts_text: '2026-10-30T12:00:00.000Z', page: '/a', consent_flag: 1 };
    const on = setup(OUTCOME, { recent: [{ ...base, status_v: 502, reason_v: 'ETIMEDOUT' }] });
    const v = (await on.call('/api/recent-visits')).body.data.visits[0];
    expect(v).toMatchObject({ status: 502, errorReason: 'ETIMEDOUT' });
    const off = setup({}, { recent: [base] });
    const w = (await off.call('/api/recent-visits')).body.data.visits[0];
    expect(Object.keys(w)).not.toContain('status');
    expect(Object.keys(w)).not.toContain('errorReason');
  });

  test('meta: statusClass, status and errorReason are breakdowns and the first explorer facets', async () => {
    const meta = (await setup().call('/api/meta')).body.data;
    expect(meta.widgets.errors).toEqual({ available: true });
    expect(meta.fields).toMatchObject({ status: true, errorReason: true });
    expect(meta.breakdowns.map((b: any) => b.key)).toEqual(
      expect.arrayContaining(['statusClass', 'status', 'errorReason']),
    );
    expect(meta.explorer.fields.slice(2, 5)).toEqual([
      { key: 'statusClass', type: 'text', search: false, facet: true },
      { key: 'status', type: 'number', search: false, facet: true },
      { key: 'errorReason', type: 'text', search: true, facet: true },
    ]);
  });

  test('explorer: status:>=500, statusClass:4xx and a bare term over errorReason compile to bound SQL', async () => {
    const { call, driver } = setup();
    const r = await call('/api/search', { q: 'status:>=500 statusClass:4xx econn' });
    expect(r.status).toBe(200);
    const q = driver.calls.find((x) => x.sql.includes('AS ts_text'));
    expect(q?.sql).toContain('"status_code" >= $');
    expect(q?.sql).toContain("THEN '4xx'");
    expect(q?.sql).toMatch(/LOWER\(r\."error_reason"\) LIKE \$\d+ ESCAPE '!'/);
    expect(q?.params).toEqual(expect.arrayContaining([500, '4xx', '%econn%']));
  });

  test('split the histogram by status class', async () => {
    const { call, driver } = setup(OUTCOME, { breakdownTop: [{ v: '5xx', n: 3 }] });
    const r = await call('/api/search/histogram', { ...RANGE, split: 'statusClass' });
    expect(r.body.data.breakdown.key).toBe('statusClass');
    expect(driver.calls.some((x) => x.sql.includes('WHEN "status_code" >= 500 THEN \'5xx\''))).toBe(
      true,
    );
  });
});

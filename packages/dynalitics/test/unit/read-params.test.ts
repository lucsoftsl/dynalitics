import { describe, expect, test } from 'vitest';
import {
  parseParams,
  decodeCursor,
  encodeCursor,
  type ParamContext,
} from '../../src/read/params.js';

const NOW = new Date('2026-10-30T12:05:00.000Z');
const ctx: ParamContext = {
  now: NOW,
  limits: {
    maxRangeDays: 92,
    maxBuckets: 800,
    topPagesMax: 100,
    recentMax: 100,
    newVsReturningMaxRangeDays: 31,
  },
  defaults: { rangeDays: 7, interval: 'day', topPagesLimit: 10, recentLimit: 25 },
  breakdowns: new Set(['consent', 'plan']),
  hasCursor: true,
};
const ok = (
  route: Parameters<typeof parseParams>[0],
  query: Record<string, string | string[]>,
  c = ctx,
) => {
  const r = parseParams(route, query, c);
  if (!r.ok) throw new Error(`expected ok, got ${r.code} ${r.param ?? ''}`);
  return r.params;
};
const bad = (
  route: Parameters<typeof parseParams>[0],
  query: Record<string, string | string[]>,
  c = ctx,
) => {
  const r = parseParams(route, query, c);
  if (r.ok) throw new Error('expected an error');
  return r;
};

describe('defaults', () => {
  test('range is the last 7 days ending now; interval day; limits from defaults', () => {
    const p = ok('visits-over-time', {});
    expect(p.to.toISOString()).toBe('2026-10-30T12:05:00.000Z');
    expect(p.from.toISOString()).toBe('2026-10-23T12:05:00.000Z');
    expect(p.interval).toBe('day');
    expect(ok('top-pages', {}).limit).toBe(10);
    expect(ok('recent-visits', {}).limit).toBe(25);
  });
});

describe('strictness', () => {
  test.each([
    ['visits-over-time', { sql: 'DROP' }],
    ['visits-over-time', { limit: '5' }],
    ['top-pages', { interval: 'day' }],
    ['recent-visits', { breakdown: 'plan' }],
    ['new-vs-returning', { breakdown: 'plan' }],
    ['meta', { from: '2026-10-01' }],
  ] as const)('%s rejects unknown parameter %j', (route, query) => {
    const r = bad(route, query);
    expect(r).toMatchObject({ code: 'invalid_parameter', param: Object.keys(query)[0] });
  });

  test('duplicated parameters (arrays) are rejected', () => {
    expect(bad('visits-over-time', { interval: ['day', 'week'] })).toMatchObject({
      code: 'invalid_parameter',
      param: 'interval',
    });
  });

  test('an oversized query string is rejected', () => {
    expect(
      bad('visits-over-time', { from: '2026-10-01', interval: 'x'.repeat(3000) }),
    ).toMatchObject({ code: 'invalid_parameter' });
  });

  test('__proto__ style keys are plain unknown parameters', () => {
    const q = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    expect(bad('visits-over-time', q)).toMatchObject({ code: 'invalid_parameter' });
  });
});

describe('time parameters', () => {
  test('accepts YYYY-MM-DD and ISO instants with Z; the interval is [from, to)', () => {
    const p = ok('visits-over-time', { from: '2026-10-01', to: '2026-10-08T06:30:00.250Z' });
    expect(p.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-10-08T06:30:00.250Z');
  });

  test.each([
    '2026-02-30',
    '2026-13-01',
    '2026-10-01T25:00:00Z',
    '2026-10-01T10:00:00+02:00',
    '2026-10-01 10:00:00',
    'yesterday',
    '1e9',
    '',
    '2026-10-01T10:00:00',
  ])('rejects %j', (v) => {
    expect(bad('visits-over-time', { from: v })).toMatchObject({
      code: 'invalid_parameter',
      param: 'from',
    });
  });

  test('to must be after from', () => {
    expect(bad('visits-over-time', { from: '2026-10-05', to: '2026-10-05' })).toMatchObject({
      code: 'invalid_parameter',
      param: 'to',
    });
    expect(bad('visits-over-time', { from: '2026-10-06', to: '2026-10-05' })).toMatchObject({
      code: 'invalid_parameter',
      param: 'to',
    });
  });

  test('range over maxRangeDays is range_too_large', () => {
    expect(
      bad('visits-over-time', { from: '2026-01-01', to: '2026-10-01', interval: 'month' }),
    ).toMatchObject({ code: 'range_too_large' });
    expect(ok('visits-over-time', { from: '2026-07-31', to: '2026-10-31' }).interval).toBe('day'); // exactly 92 days
  });

  test('too many buckets is range_too_large (hours over 40 days)', () => {
    expect(
      bad('visits-over-time', { from: '2026-09-01', to: '2026-10-11', interval: 'hour' }),
    ).toMatchObject({ code: 'range_too_large' });
    expect(
      ok('visits-over-time', { from: '2026-10-01', to: '2026-10-08', interval: 'hour' }).interval,
    ).toBe('hour');
  });

  test('new-vs-returning has its own, smaller range cap', () => {
    expect(bad('new-vs-returning', { from: '2026-09-01', to: '2026-10-30' })).toMatchObject({
      code: 'range_too_large',
    });
    expect(ok('new-vs-returning', { from: '2026-10-01', to: '2026-10-30' }).interval).toBe('day');
  });
});

describe('other parameters', () => {
  test('interval allow-list', () => {
    for (const i of ['hour', 'day', 'week', 'month'])
      expect(ok('consent-rate', { interval: i }).interval).toBe(i);
    expect(bad('consent-rate', { interval: 'year' })).toMatchObject({
      code: 'invalid_parameter',
      param: 'interval',
    });
  });

  test('limit is a bounded integer', () => {
    expect(ok('top-pages', { limit: '100' }).limit).toBe(100);
    for (const v of ['0', '101', '-1', '1.5', 'ten', '1e2', '', ' 5']) {
      expect(bad('top-pages', { limit: v })).toMatchObject({
        code: 'invalid_parameter',
        param: 'limit',
      });
    }
    expect(bad('recent-visits', { limit: '101' })).toMatchObject({ param: 'limit' });
  });

  test('breakdown must be one of the declared dimensions (a name, never a key path)', () => {
    expect(ok('visits-over-time', { breakdown: 'plan' }).breakdown).toBe('plan');
    for (const v of [
      'email',
      'ip_address',
      "plan'; DROP TABLE x;--",
      '$.plan',
      'plan.x',
      'constructor',
      '__proto__',
    ]) {
      expect(bad('visits-over-time', { breakdown: v })).toMatchObject({
        code: 'invalid_parameter',
        param: 'breakdown',
      });
    }
  });

  test('pii accepts only "reveal"', () => {
    expect(ok('recent-visits', { pii: 'reveal' }).pii).toBe(true);
    expect(ok('recent-visits', {}).pii).toBe(false);
    expect(bad('recent-visits', { pii: 'yes' })).toMatchObject({ param: 'pii' });
  });
});

describe('cursor', () => {
  test('round trip', () => {
    const c = encodeCursor(new Date('2026-10-30T12:01:02.004Z'), '18230');
    expect(decodeCursor(c)).toEqual({ ts: new Date('2026-10-30T12:01:02.004Z'), id: '18230' });
    expect(ok('recent-visits', { cursor: c }).cursor).toEqual({
      ts: new Date('2026-10-30T12:01:02.004Z'),
      id: '18230',
    });
  });

  test.each([
    '',
    'not base64!',
    Buffer.from('2026-10-30T12:01:02.004Z|1; DROP TABLE x').toString('base64url'),
    Buffer.from('garbage').toString('base64url'),
    Buffer.from('2026-10-30T12:01:02.004Z|').toString('base64url'),
    Buffer.from('2026-13-30T12:01:02.004Z|5').toString('base64url'),
    'A'.repeat(500),
  ])('rejects %j', (c) => {
    expect(decodeCursor(c)).toBeNull();
    expect(bad('recent-visits', { cursor: c })).toMatchObject({
      code: 'invalid_parameter',
      param: 'cursor',
    });
  });

  test('a cursor is rejected when the id role is not mapped', () => {
    const c = encodeCursor(new Date('2026-10-30T12:01:02.004Z'), '1');
    expect(bad('recent-visits', { cursor: c }, { ...ctx, hasCursor: false })).toMatchObject({
      param: 'cursor',
    });
  });
});

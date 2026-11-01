/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- test code reading untyped JSON responses */
// Spec 20: status + errorReason written by the real writer (generated table, startup validation), read back by
// /api/errors, the explorer and the visit list, on real databases.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsHandler } from '../../src/read/types.js';
import type { Dynalitics, Visit } from '../../src/types.js';
import { ADAPTERS, ENABLED, setupFixture, type Fixture } from './support.js';

const columns = { status: true, errorReason: true } as const;
const VISITS: Visit[] = [
  { pageVisited: '/', consent: true, status: 200 },
  { pageVisited: '/', consent: false, status: 301 },
  { pageVisited: '/missing', consent: true, status: 404 },
  { pageVisited: '/missing', consent: false, status: 404, errorReason: 'not_found' },
  { pageVisited: '/checkout', consent: true, status: 503, errorReason: 'ECONNREFUSED' },
  { pageVisited: '/checkout', consent: false, status: 500, errorReason: 'ECONNREFUSED' },
  { pageVisited: '/checkout', consent: true, status: 500, errorReason: 'TypeError' },
  { pageVisited: '/old', consent: true }, // no status: not counted by /api/errors
];

describe.each(ENABLED)('integration (status and errors): %s', (dialect) => {
  let fx: Fixture;
  let reader: Dynalitics;
  let handler: DynaliticsHandler;
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const get = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle({ method: 'GET', path, query, headers: {}, raw: {} });
    const json = JSON.parse(res.body);
    expect(res.status, res.body).toBe(200);
    return json.data;
  };

  beforeAll(async () => {
    fx = await setupFixture(dialect, { columns });
    const base = { table: fx.table, columns, logger: silent };
    const writer = await createDynalitics({
      ...base,
      adapter: ADAPTERS[dialect],
      connection: { writer: { connectionString: fx.writerUrl } },
    });
    for (const v of VISITS) await writer.track(v);
    expect((await writer.close()).written).toBe(VISITS.length);
    reader = await createDynalitics({
      ...base,
      adapter: ADAPTERS[dialect],
      connection: { reader: { connectionString: fx.readerUrl } },
    });
    handler = createHandler(reader, { authorize: () => true, scope: 'none' });
  });

  afterAll(async () => {
    await reader?.close();
    await fx?.cleanup();
  });

  test('/api/errors: totals, rate, pages and reasons', async () => {
    const d = await get('/api/errors', { interval: 'day' });
    expect(d.totals).toEqual({ total: 7, clientErrors: 2, serverErrors: 3, rate: 0.714 });
    expect(d.pages).toEqual([
      { page: '/checkout', errors: 3, serverErrors: 3 },
      { page: '/missing', errors: 2, serverErrors: 0 },
    ]);
    const reasons = d.reasons.map(
      (r: { reason: string | null; status: number; count: number }) =>
        `${String(r.reason)}/${r.status}/${r.count}`,
    );
    expect(reasons.sort()).toEqual(
      [
        'ECONNREFUSED/500/1',
        'ECONNREFUSED/503/1',
        'TypeError/500/1',
        'not_found/404/1',
        'null/404/1',
      ].sort(),
    );
    expect(d.reasonsStored).toBe(true);
  });

  test('denied rows keep status and reason; the visit list carries them', async () => {
    const d = await get('/api/search', { q: 'consent:false status:>=400', limit: '100' });
    const got = d.visits
      .map(
        (v: { pageVisited: string; status: number; errorReason: string }) =>
          `${v.pageVisited} ${v.status} ${v.errorReason}`,
      )
      .sort();
    expect(got).toEqual(['/checkout 500 ECONNREFUSED', '/missing 404 not_found']);
  });

  test('explorer: statusClass filter, errorReason term and a statusClass facet', async () => {
    expect((await get('/api/search', { q: 'statusClass:5xx' })).matched).toBe(3);
    expect((await get('/api/search', { q: 'econn' })).matched).toBe(2);
    expect((await get('/api/search', { q: '-statusClass:2xx' })).matched).toBe(7); // NULL-safe: '/old' matches
    const facets = await get('/api/search/fields');
    const cls = facets.fields.find((f: { key: string }) => f.key === 'statusClass');
    expect(cls.values).toEqual([
      { value: '5xx', count: 3 },
      { value: '4xx', count: 2 },
      { value: '2xx', count: 1 },
      { value: '3xx', count: 1 },
    ]);
    expect(cls.nullCount).toBe(1);
  });
});

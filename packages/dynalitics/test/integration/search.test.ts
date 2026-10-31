/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- test code reading untyped JSON responses */
// Spec 18: the explorer's query semantics on real databases (case-insensitivity, LIKE escaping, NULL-safe negation,
// JSON number and boolean filters, facets). Rows are written through the real writer path.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsHandler } from '../../src/read/types.js';
import type { Dynalitics, Visit } from '../../src/types.js';
import { ADAPTERS, ENABLED, setupFixture, type Fixture } from './support.js';

const customFields = {
  plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
  amount: { type: 'number', personal: false },
  beta: { type: 'boolean', personal: false, breakdown: true },
  campaign: { type: 'string', maxLength: 64 }, // personal: never searchable
} as const;

const VISITS: Visit[] = [
  { pageVisited: '/Pricing', consent: true, custom: { plan: 'Pro', amount: 12.5, beta: true } },
  { pageVisited: '/pricing/teams', consent: true, custom: { plan: 'team', amount: 3 } },
  { pageVisited: '/blog/100%_off', consent: true, custom: { plan: 'free', beta: false } },
  { pageVisited: '/blog/100x_off', consent: true, custom: { campaign: 'Pricing-Secret' } },
  { pageVisited: '/docs/Pricing.PDF', consent: false },
  { pageVisited: '/', consent: true, email: 'pricing@example.com', custom: { amount: -1 } },
];

describe.each(ENABLED)('integration (explorer): %s', (dialect) => {
  let fx: Fixture;
  let writer: Dynalitics;
  let reader: Dynalitics;
  let handler: DynaliticsHandler;
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

  const get = async (path: string, query: Record<string, string> = {}) => {
    const res = await handler.handle({ method: 'GET', path, query, headers: {}, raw: {} });
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const pages = async (q: string): Promise<string[]> => {
    const { status, json } = await get('/api/search', { q, limit: '100' });
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json.data.matched).toBe(json.data.visits.length);
    return json.data.visits.map((v: { pageVisited: string }) => v.pageVisited).sort();
  };

  beforeAll(async () => {
    fx = await setupFixture(dialect, { customFields });
    const base = { table: fx.table, customFields, ip: { mode: 'raw' as const }, logger: silent };
    writer = await createDynalitics({
      ...base,
      adapter: ADAPTERS[dialect],
      connection: { writer: { connectionString: fx.writerUrl } },
    });
    for (const v of VISITS) await writer.track(v);
    const flushed = await writer.close();
    expect(flushed.written).toBe(VISITS.length);
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

  test('a bare term is a case-insensitive "contains" over page and non-personal text fields', async () => {
    expect(await pages('PRICING')).toEqual(['/Pricing', '/docs/Pricing.PDF', '/pricing/teams']);
    expect(await pages('pro')).toEqual(['/Pricing']); // plan 'Pro'
  });

  test('personal fields are never matched: not by bare terms, not by name', async () => {
    // '/' has email pricing@..., '/blog/100x_off' has campaign Pricing-Secret: neither shows up above
    expect(await pages('secret')).toEqual([]);
    const { status, json } = await get('/api/search', { q: 'campaign:pricing-secret' });
    expect(status).toBe(400);
    expect(json.error.reason).toBe('unknown_field');
  });

  test('wildcards and exact matches on a field', async () => {
    expect(await pages('page:/pricing*')).toEqual(['/Pricing', '/pricing/teams']);
    expect(await pages('page:*.pdf')).toEqual(['/docs/Pricing.PDF']);
    expect(await pages('page:/PRICING')).toEqual(['/Pricing']);
    expect(await pages('plan:*')).toEqual(['/Pricing', '/blog/100%_off', '/pricing/teams']);
  });

  test('% and _ in a value are literal characters', async () => {
    expect(await pages('"100%_off"')).toEqual(['/blog/100%_off']);
    expect(await pages('100x')).toEqual(['/blog/100x_off']);
  });

  test('negation keeps rows where the field is missing', async () => {
    expect(await pages('-plan:pro')).toEqual([
      '/',
      '/blog/100%_off',
      '/blog/100x_off',
      '/docs/Pricing.PDF',
      '/pricing/teams',
    ]);
    expect(await pages('pricing -page:*pdf')).toEqual(['/Pricing', '/pricing/teams']);
  });

  test('numbers compare numerically from JSON; booleans and consent filter exactly', async () => {
    expect(await pages('amount:>3')).toEqual(['/Pricing']);
    expect(await pages('amount:>=3')).toEqual(['/Pricing', '/pricing/teams']);
    expect(await pages('amount:<0')).toEqual(['/']);
    expect(await pages('beta:true')).toEqual(['/Pricing']);
    expect(await pages('beta:false')).toEqual(['/blog/100%_off']);
    expect(await pages('consent:false')).toEqual(['/docs/Pricing.PDF']);
  });

  test('fields: facet counts agree with the matches', async () => {
    const { json } = await get('/api/search/fields', { q: 'pricing' });
    expect(json.data.matched).toBe(3);
    const consent = json.data.fields.find((f: { key: string }) => f.key === 'consent');
    expect(consent.values).toEqual([
      { value: 'true', count: 2 },
      { value: 'false', count: 1 },
    ]);
    const plan = json.data.fields.find((f: { key: string }) => f.key === 'plan');
    expect(plan.values.map((v: { value: string }) => v.value).sort()).toEqual(['Pro', 'team']);
    expect(plan.nullCount).toBe(1);
  });

  test('histogram: matches per bucket, split by a facet field', async () => {
    const { json } = await get('/api/search/histogram', {
      q: 'pricing',
      interval: 'hour',
      split: 'consent',
      from: new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 19) + 'Z',
    });
    expect(json.data.total).toBe(3);
    const byValue = Object.fromEntries(
      json.data.breakdown.series
        .filter((s: { isOther: boolean }) => !s.isOther)
        .map((s: { value: string | null; points: { visits: number }[] }) => [
          String(s.value),
          s.points.reduce((a, p) => a + p.visits, 0),
        ]),
    );
    expect(byValue).toMatchObject({ true: 2, false: 1 });
  });
});

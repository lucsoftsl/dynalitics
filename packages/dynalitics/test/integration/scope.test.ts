/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- test code reading untyped JSON responses */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { createHandler } from '../../src/read/handler.js';
import type { DynaliticsHandler } from '../../src/read/types.js';
import type { Dynalitics } from '../../src/types.js';
import { ADAPTERS, ENABLED, setupFixture, type Fixture } from './support.js';

describe.each(ENABLED)(
  'F-08: scoping a table shared by two tenants against real data: %s',
  (dialect) => {
    let fx: Fixture;
    let dyn: Dynalitics;
    let scoped: DynaliticsHandler;
    let unscoped: DynaliticsHandler;

    const get = async (h: DynaliticsHandler, path: string, query: Record<string, string> = {}) =>
      JSON.parse(
        (await h.handle({ method: 'GET', path, query, headers: {}, raw: {} })).body,
      ) as any;

    beforeAll(async () => {
      fx = await setupFixture(dialect, {});
      const t = fx.table.split('.').map(fx.q).join('.');
      await fx.run(
        `ALTER TABLE ${t} ${dialect === 'mssql' ? 'ADD' : 'ADD COLUMN'} ${fx.q('tenant_id')} INT NULL`,
      );
      const ts = (s: string): string => (dialect === 'mysql' ? s.replace('T', ' ') : s);
      const yes = dialect === 'postgres' ? 'true' : '1';
      const cols = ['visited_at', 'consent', 'page_visited', 'user_id', 'tenant_id']
        .map(fx.q)
        .join(', ');
      const rows: [string, string, number][] = [
        ['2026-10-20T10:00:00', 'alice', 2], // tenant 2 saw alice BEFORE the range
        ['2026-10-26T09:00:00', 'bob', 2],
        ['2026-10-25T10:00:00', 'alice', 1], // tenant 1: alice's first visit in tenant 1
        ['2026-10-26T10:00:00', 'carol', 1],
        ['2026-10-27T10:00:00', 'carol', 1],
      ];
      for (const [when, user, tenant] of rows) {
        await fx.run(
          `INSERT INTO ${t} (${cols}) VALUES ('${ts(when)}', ${yes}, '/t${tenant}', '${user}', ${tenant})`,
        );
      }
      dyn = await createDynalitics({
        adapter: ADAPTERS[dialect],
        connection: { reader: { connectionString: fx.readerUrl } },
        table: fx.table,
        ip: { mode: 'raw' },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      scoped = createHandler(dyn, {
        authorize: () => true,
        scope: { column: 'tenant_id', value: 1 },
      });
      unscoped = createHandler(dyn, { authorize: () => true, scope: 'none' });
    });
    afterAll(async () => {
      await dyn.close();
      await fx.cleanup();
    });

    const range = { from: '2026-10-24', to: '2026-10-28', interval: 'day' };
    const window = { from: range.from, to: range.to }; // top-pages and recent-visits take no interval

    test("aggregates only count the tenant's own rows", async () => {
      const mine = await get(scoped, '/api/visits-over-time', range);
      expect(mine.data.total).toBe(3);
      const all = await get(unscoped, '/api/visits-over-time', range);
      expect(all.data.total).toBe(4);
      const pages = (await get(scoped, '/api/top-pages', window)).data.pages.map(
        (p: { page: string }) => p.page,
      );
      expect(pages).toEqual(['/t1']);
    });

    test('a visitor only seen in ANOTHER tenant before the range is still new here (the probe is scoped too)', async () => {
      const mine = (await get(scoped, '/api/new-vs-returning', range)).data.points;
      expect(mine.map((p: any) => [p.bucket.slice(0, 10), p.new, p.returning])).toEqual([
        ['2026-10-24', 0, 0],
        ['2026-10-25', 1, 0], // alice: first row of tenant 1
        ['2026-10-26', 1, 0], // carol: first row
        ['2026-10-27', 0, 1], // carol again
      ]);
      const all = (await get(unscoped, '/api/new-vs-returning', range)).data.points;
      expect(all.map((p: any) => [p.bucket.slice(0, 10), p.new, p.returning])).toEqual([
        ['2026-10-24', 0, 0],
        ['2026-10-25', 0, 1], // across tenants alice was seen on 10-20
        ['2026-10-26', 2, 0],
        ['2026-10-27', 0, 1],
      ]);
    });

    test('recent visits: only this tenant, and the per-row first-visit flag ignores the other tenant', async () => {
      const rows = (await get(scoped, '/api/recent-visits', { ...window, limit: '10' })).data
        .visits;
      expect(rows.map((v: any) => v.pageVisited)).toEqual(['/t1', '/t1', '/t1']);
      const alice = rows.find((v: any) => v.timestamp.startsWith('2026-10-25'));
      expect(alice.isFirstVisit).toBe(true);
      const unscopedRows = (await get(unscoped, '/api/recent-visits', { ...window, limit: '10' }))
        .data.visits;
      expect(unscopedRows.find((v: any) => v.timestamp.startsWith('2026-10-25')).isFirstVisit).toBe(
        false,
      );
    });

    test('pagination keeps the scope on every page', async () => {
      const first = (await get(scoped, '/api/recent-visits', { ...window, limit: '2' })).data;
      const second = (
        await get(scoped, '/api/recent-visits', { ...window, limit: '2', cursor: first.nextCursor })
      ).data;
      expect(first.visits.length + second.visits.length).toBe(3);
      expect([...first.visits, ...second.visits].every((v: any) => v.pageVisited === '/t1')).toBe(
        true,
      );
      expect(second.nextCursor).toBeNull();
    });
  },
);

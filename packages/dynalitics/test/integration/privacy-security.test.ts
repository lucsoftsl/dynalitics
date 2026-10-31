import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDynalitics } from '../../src/create.js';
import { DynaliticsConfigError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import type { Dynalitics, DynaliticsConfig, ErrorInfo } from '../../src/types.js';
import { ADAPTERS, ENABLED, norm, setupFixture, type Fixture } from './support.js';

const customFields = {
  plan: { type: 'string', maxLength: 32, personal: false },
  campaign: { type: 'string', maxLength: 64 },
} as const;

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe.each(ENABLED)('privacy and security against a real database: %s', (dialect) => {
  let fx: Fixture;
  const open: Dynalitics[] = [];
  const errors: ErrorInfo[] = [];

  const start = async (extra: Partial<DynaliticsConfig> = {}): Promise<Dynalitics> => {
    const dyn = await createDynalitics({
      adapter: ADAPTERS[dialect],
      connection: {
        writer: { connectionString: fx.writerUrl },
        reader: { connectionString: fx.readerUrl },
      },
      table: fx.table,
      customFields,
      ip: { mode: 'raw' },
      logger: silent,
      onError: (e) => void errors.push(e),
      ...extra,
    });
    open.push(dyn);
    return dyn;
  };
  const lastRow = async (): Promise<Record<string, unknown>> => {
    const rows = (await fx.rows('ORDER BY id')).map(norm);
    return rows[rows.length - 1]!;
  };

  beforeAll(async () => {
    fx = await setupFixture(dialect, { customFields });
  });
  afterAll(async () => {
    await Promise.allSettled(open.map((d) => d.close()));
    await fx.cleanup();
  });

  describe('consent matrix', () => {
    const personal = {
      ip: '198.51.100.9',
      userId: 'u_1',
      username: 'jane',
      email: 'jane@example.com',
      custom: { plan: 'pro', campaign: 'secret-campaign' },
    };

    test('explicit consent=false stores ONLY page + timestamp + consent=false (every other column is NULL)', async () => {
      const dyn = await start();
      await dyn.track({ pageVisited: '/denied', consent: false, ...personal });
      await dyn.flush();
      expect(await lastRow()).toMatchObject({
        page_visited: '/denied',
        consent: false,
        ip_address: null,
        user_id: null,
        username: null,
        email: null,
        custom: null, // strict (F-03): nothing but page, time and consent=false survives unless a field opts in with keepWhenDenied
      });
      expect(JSON.stringify(await lastRow())).not.toContain('secret-campaign');
    });

    test('explicit consent=true stores every personal field', async () => {
      const dyn = await start();
      await dyn.track({ pageVisited: '/granted', consent: true, ...personal });
      await dyn.flush();
      expect(await lastRow()).toMatchObject({
        consent: true,
        ip_address: '198.51.100.9',
        user_id: 'u_1',
        username: 'jane',
        email: 'jane@example.com',
        custom: { plan: 'pro', campaign: 'secret-campaign' },
      });
    });

    test('no consent flag and no resolver fails closed (nothing personal stored)', async () => {
      const dyn = await start();
      await dyn.track({ pageVisited: '/unspecified', ...personal });
      await dyn.flush();
      expect(await lastRow()).toMatchObject({
        consent: false,
        ip_address: null,
        user_id: null,
        email: null,
      });
    });

    test('consent=null is treated like absent: fails closed', async () => {
      const dyn = await start();
      await dyn.track({
        pageVisited: '/null-consent',
        consent: null as unknown as boolean,
        ...personal,
      });
      await dyn.flush();
      expect(await lastRow()).toMatchObject({ consent: false, email: null, user_id: null });
    });

    test('a non-boolean consent value is never coerced: it is stored as consent=false with no personal data, and reported', async () => {
      const dyn = await start();
      const before = (await fx.rows()).length;
      const result = await dyn.track({
        pageVisited: '/truthy-string',
        consent: 'yes' as unknown as boolean,
        ...personal,
      });
      await dyn.flush();
      expect(result.status).toBe('queued');
      const rows = (await fx.rows('ORDER BY id')).map(norm);
      expect(rows).toHaveLength(before + 1);
      expect(rows[rows.length - 1]).toMatchObject({
        page_visited: '/truthy-string',
        consent: false,
        ip_address: null,
        user_id: null,
        username: null,
        email: null,
        custom: null,
      });
    });

    test('default resolver grants consent when the call omits it; per-call value wins over the resolver', async () => {
      const dyn = await start({ consent: { default: () => true } });
      await dyn.track({ pageVisited: '/resolver-yes', ...personal });
      await dyn.flush();
      expect(await lastRow()).toMatchObject({ consent: true, user_id: 'u_1' });
      await dyn.track({ pageVisited: '/call-wins', consent: false, ...personal });
      await dyn.flush();
      expect(await lastRow()).toMatchObject({ consent: false, user_id: null, email: null });
    });

    test('a throwing resolver fails closed, reports consent_resolver_failed, and never throws into the caller', async () => {
      const before = errors.length;
      const dyn = await start({
        consent: {
          default: () => {
            throw new Error('resolver exploded');
          },
        },
      });
      await expect(
        dyn.track({ pageVisited: '/resolver-throws', ...personal }),
      ).resolves.toBeDefined();
      await dyn.flush();
      expect(await lastRow()).toMatchObject({ consent: false, email: null, ip_address: null });
      expect(errors.slice(before).map((e) => e.code)).toContain('consent_resolver_failed');
    });
  });

  describe('IP modes', () => {
    const ip = '203.0.113.200';

    test('raw stores the address as given (normalised)', async () => {
      const dyn = await start({ ip: { mode: 'raw' } });
      await dyn.track({ pageVisited: '/ip-raw', consent: true, ip });
      await dyn.flush();
      expect((await lastRow())['ip_address']).toBe(ip);
    });

    test('truncate zeroes the host bits for IPv4 and IPv6 and never keeps the original', async () => {
      const dyn = await start({ ip: { mode: 'truncate' } });
      await dyn.track({ pageVisited: '/ip-trunc4', consent: true, ip });
      await dyn.flush();
      expect((await lastRow())['ip_address']).toBe('203.0.113.0');
      await dyn.track({
        pageVisited: '/ip-trunc6',
        consent: true,
        ip: '2001:db8:abcd:1234:5678:9abc:def0:1234',
      });
      await dyn.flush();
      const v6 = (await lastRow())['ip_address'] as string;
      expect(v6).not.toContain('def0');
      expect(v6.startsWith('2001:db8:abcd')).toBe(true);
    });

    test('hash is a keyed, stable, non-reversible digest that depends on the salt', async () => {
      const a = await start({ ip: { mode: 'hash', salt: 'salt-one-0123456789' } });
      await a.track({ pageVisited: '/ip-hash-a1', consent: true, ip });
      await a.track({ pageVisited: '/ip-hash-a2', consent: true, ip });
      await a.flush();
      const rows = (await fx.rows('ORDER BY id')).map(norm);
      const [h1, h2] = rows.slice(-2).map((r) => r['ip_address'] as string);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(h1).toBe(h2);
      expect(h1).not.toContain('203.0.113');

      const b = await start({ ip: { mode: 'hash', salt: 'salt-two-9876543210' } });
      await b.track({ pageVisited: '/ip-hash-b', consent: true, ip });
      await b.flush();
      expect((await lastRow())['ip_address']).not.toBe(h1);
    });

    test('hash/truncate store NULL, not the raw address, when consent is denied', async () => {
      const dyn = await start({ ip: { mode: 'hash', salt: 'salt-one-0123456789' } });
      await dyn.track({ pageVisited: '/ip-denied', consent: false, ip });
      await dyn.flush();
      expect((await lastRow())['ip_address']).toBeNull();
    });

    test.each(['not-an-ip', '999.1.1.1', "1.2.3.4'; DROP TABLE x;--", '<script>1</script>'])(
      'an invalid address %j is never stored verbatim',
      async (bad) => {
        const dyn = await start({ ip: { mode: 'raw' } });
        await dyn.track({ pageVisited: '/ip-bad', consent: true, ip: bad });
        await dyn.flush();
        const stored = (await lastRow())['ip_address'];
        expect(stored === null || stored !== bad).toBe(true);
      },
    );
  });

  describe('SQL injection through configuration identifiers', () => {
    const connection = (): DynaliticsConfig['connection'] => ({
      writer: { connectionString: fx.writerUrl },
      reader: { connectionString: fx.readerUrl },
    });
    const hostile = [
      'events; DROP TABLE users',
      'a" OR "1"="1',
      'a`b',
      'a]b',
      'public.events--',
      'x y',
      '',
      'é',
      'a'.repeat(64),
    ];

    test.each(hostile)('table name %j is refused before any connection is made', async (name) => {
      await expect(
        createDynalitics({
          adapter: ADAPTERS[dialect],
          connection: connection(),
          table: name,
          logger: silent,
        }),
      ).rejects.toBeInstanceOf(DynaliticsConfigError);
    });

    test.each(hostile.filter((h) => h !== ''))(
      'column mapping %j is refused with a config error',
      async (name) => {
        await expect(
          createDynalitics({
            adapter: ADAPTERS[dialect],
            connection: connection(),
            table: fx.table,
            columns: { email: name },
            logger: silent,
          }),
        ).rejects.toBeInstanceOf(DynaliticsConfigError);
      },
    );

    test.each(['__proto__', 'constructor', 'a-b', "a'b", 'a b'])(
      'custom field key %j is refused at config time',
      async (key) => {
        await expect(
          createDynalitics({
            adapter: ADAPTERS[dialect],
            connection: connection(),
            table: fx.table,
            customFields: { [key]: { type: 'string' } },
            logger: silent,
          }),
        ).rejects.toBeInstanceOf(DynaliticsConfigError);
      },
    );

    test('hostile visit keys cannot reach SQL or the prototype: unknown custom keys are dropped and reported', async () => {
      const dyn = await start();
      const before = errors.length;
      const custom = JSON.parse(
        `{"plan":"ok","x\\") ; DROP TABLE ${fx.bareTable};--":"1","__proto__":{"polluted":true}}`,
      ) as Record<string, string>;
      await dyn.track({ pageVisited: '/hostile-keys', consent: true, custom });
      await dyn.flush();
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect((await lastRow())['custom']).toEqual({ plan: 'ok' });
      expect(errors.slice(before).map((e) => e.code)).toContain('unknown_custom_field');
      await expect(fx.rows()).resolves.toBeDefined(); // table still exists
    });

    test('connection strings never leak into thrown errors', async () => {
      const secret = 'Sup3r_s3cret_pw';
      // URL forms (postgres://u:pw@, mysql://u:pw@) and the SQL Server form (...;Password=pw;...).
      const bad =
        dialect === 'mssql'
          ? fx.writerUrl.replace(/Password=[^;]*/i, `Password=${secret}`)
          : fx.writerUrl.replace(/:[^:@/]+@/, `:${secret}@`);
      expect(bad, 'the wrong password was planted').toContain(secret);
      const err = await createDynalitics({
        adapter: ADAPTERS[dialect],
        connection: { writer: { connectionString: bad } },
        table: fx.table,
        logger: silent,
      }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(`${(err as Error).message}\n${(err as Error).stack}`).not.toContain(secret);
    });
  });
});

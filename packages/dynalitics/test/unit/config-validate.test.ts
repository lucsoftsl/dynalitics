import { describe, expect, test } from 'vitest';
import { validateConfig, resolveConfig } from '../../src/config/schema.js';
import { DynaliticsConfigError } from '../../src/errors.js';

const base = {
  dialect: 'postgres',
  connection: { connectionString: 'postgres://u:p4ssw0rd@h/db' },
  table: 'public.events',
} as const;

function issuesOf(input: unknown): readonly string[] {
  try {
    validateConfig(input);
  } catch (e) {
    if (e instanceof DynaliticsConfigError) return e.issues;
    throw e;
  }
  return [];
}

describe('validateConfig', () => {
  test('accepts a minimal config and a fully populated one', () => {
    expect(issuesOf(base)).toEqual([]);
    expect(
      issuesOf({
        ...base,
        connection: { writer: { connectionString: 'a' }, reader: { pool: {} } },
        acknowledgeSingleCredential: true,
        poolSize: 4,
        connectTimeoutMs: 5000,
        tableMode: 'recommended',
        columns: { email: false, timestamp: 'created_at' },
        customFields: {
          plan: {
            type: 'string',
            maxLength: 32,
            personal: false,
            breakdown: true,
            keepWhenDenied: true,
          },
        },
        page: { keepQuery: false, maxLength: 512, normalize: (p: string) => p },
        ip: { mode: 'hash', salt: 'x'.repeat(16) },
        consent: { default: () => true },
        firstVisit: { enabled: true, cacheSize: 100 },
        queue: {
          maxSize: 10,
          batchSize: 5,
          flushIntervalMs: 100,
          backpressure: 'block',
          maxBlockMs: 10,
          retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
        },
        limits: { customMaxKeys: 5, customMaxBytes: 100, oversize: 'reject' },
        validateOnStart: 'skip',
        onError: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    ).toEqual([]);
  });

  test('collects ALL issues with dotted paths', () => {
    const issues = issuesOf({
      dialect: 'oracle',
      connection: {},
      table: 5,
      queue: { batchSize: 0, backpressure: 'maybe' },
      ipMode: 'raw',
    });
    expect(issues.join('\n')).toMatch(/config\.dialect/);
    expect(issues.join('\n')).toMatch(/config\.connection/);
    expect(issues.join('\n')).toMatch(/config\.table/);
    expect(issues.join('\n')).toMatch(
      /config\.queue\.batchSize: expected integer 1\.\.1000, got 0/,
    );
    expect(issues.join('\n')).toMatch(/config\.queue\.backpressure/);
    expect(issues.join('\n')).toMatch(/config\.ipMode: unknown key/);
    expect(issues.length).toBeGreaterThanOrEqual(6);
  });

  test('rejects non-objects', () => {
    expect(issuesOf(null)).toEqual(['config: expected an object']);
    expect(issuesOf([])).toEqual(['config: expected an object']);
  });

  test('connection shapes', () => {
    expect(issuesOf({ ...base, connection: { connectionString: 'a', pool: {} } })[0]).toMatch(
      /exactly one/,
    );
    expect(issuesOf({ ...base, connection: { writer: {} } })[0]).toMatch(
      /connectionString or pool/,
    );
    expect(issuesOf({ ...base, connection: { writer: { connectionString: '' } } }).length).toBe(1);
    expect(
      issuesOf({
        ...base,
        connection: { connectionString: 'a', writer: { connectionString: 'b' } },
      })[0],
    ).toMatch(/either/);
    expect(issuesOf({ ...base, connection: { writer: { connectionString: 'a' } } })).toEqual([]);
  });

  test('hash mode requires a salt of at least 16 characters', () => {
    expect(issuesOf({ ...base, ip: { mode: 'hash' } })[0]).toMatch(/ip\.salt is required/);
    expect(issuesOf({ ...base, ip: { mode: 'hash', salt: 'short' } })[0]).toMatch(/at least 16/);
    expect(issuesOf({ ...base, ip: { mode: 'raw', salt: 'short' } })).toEqual([]);
  });

  test('extraColumns still gives a clear "not supported yet" message', () => {
    expect(issuesOf({ ...base, extraColumns: { x: {} } })[0]).toMatch(/not supported yet/);
  });

  test('tableMode "existing" is accepted by the config validator', () => {
    expect(issuesOf({ ...base, tableMode: 'existing' })).toEqual([]);
  });

  test('validateOnStart "skip" cannot be combined with tableMode "existing"', () => {
    expect(issuesOf({ ...base, tableMode: 'existing', validateOnStart: 'skip' })).toEqual([
      'config.validateOnStart: "skip" is only allowed with tableMode "recommended"; an existing table is always checked at startup',
    ]);
    expect(issuesOf({ ...base, validateOnStart: 'skip' })).toEqual([]);
  });

  test('prefix and range checks', () => {
    expect(issuesOf({ ...base, ip: { ipv4Prefix: 7 } })[0]).toMatch(/ipv4Prefix/);
    expect(issuesOf({ ...base, ip: { ipv6Prefix: 129 } })[0]).toMatch(/ipv6Prefix/);
    expect(issuesOf({ ...base, page: { maxLength: 701 } })[0]).toMatch(/page\.maxLength/);
    expect(issuesOf({ ...base, poolSize: 21 })[0]).toMatch(/poolSize/);
  });

  test('error messages never contain the connection string', () => {
    const cs = 'postgres://u:Sup3rS3cret@h/db';
    try {
      validateConfig({
        dialect: 'nope',
        connection: { connectionString: cs, extra: cs },
        table: 't',
      });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('Sup3rS3cret');
    }
  });
});

describe('resolveConfig', () => {
  test('fills defaults without mutating the input', () => {
    const input = Object.freeze({ ...base });
    const r = resolveConfig(validateConfig(input));
    expect(r.queue).toMatchObject({
      maxSize: 10_000,
      batchSize: 200,
      flushIntervalMs: 1000,
      backpressure: 'drop',
      maxBlockMs: 2000,
      retry: { attempts: 3, baseDelayMs: 200, maxDelayMs: 5000 },
    });
    expect(r.ip).toMatchObject({ mode: 'truncate', ipv4Prefix: 24, ipv6Prefix: 48 });
    expect(r.page).toEqual({ keepQuery: false, maxLength: 512, normalize: undefined });
    expect(r.limits).toEqual({ customMaxKeys: 20, customMaxBytes: 4096, oversize: 'truncate' });
    expect(r.firstVisit).toEqual({ enabled: false, cacheSize: 50_000 });
    expect(r.validateOnStart).toBe('strict');
    expect(r.poolSize).toEqual({ writer: 4, reader: 2 });
    expect(r.connectTimeoutMs).toBe(10_000);
    expect(r.credentials.single).toBe(true);
    expect(r.credentials.writer).toEqual({ connectionString: 'postgres://u:p4ssw0rd@h/db' });
  });

  test('splits writer and reader credentials', () => {
    const r = resolveConfig(
      validateConfig({
        ...base,
        connection: { writer: { connectionString: 'w' }, reader: { connectionString: 'r' } },
      }),
    );
    expect(r.credentials).toEqual({
      single: false,
      writer: { connectionString: 'w' },
      reader: { connectionString: 'r' },
    });
  });
});

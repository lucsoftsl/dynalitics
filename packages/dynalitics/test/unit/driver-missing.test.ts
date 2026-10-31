import { describe, expect, test, vi } from 'vitest';
import { createRedactor } from '../../src/redact.js';
import { DynaliticsConnectionError } from '../../src/errors.js';
import { importPeer } from '../../src/driver/load.js';

describe('importPeer: missing optional peer dependency', () => {
  test.each([
    ['postgres', 'pg'],
    ['mysql', 'mysql2'],
    ['mssql', 'mssql'],
  ] as const)('%s tells the user which package to install', async (dialect, pkg) => {
    const missing = Object.assign(
      new Error(`Cannot find package '${pkg}' imported from /app/x.js`),
      {
        code: 'ERR_MODULE_NOT_FOUND',
      },
    );
    const err = await importPeer(() => Promise.reject(missing), pkg, dialect).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DynaliticsConnectionError);
    expect((err as Error).message).toBe(
      `Install the "${pkg}" package to use dialect "${dialect}".`,
    );
  });

  test('recognises the CommonJS error code and message form too', async () => {
    const cjs = Object.assign(new Error("Cannot find module 'pg'\nRequire stack:\n- /x"), {
      code: 'MODULE_NOT_FOUND',
    });
    await expect(importPeer(() => Promise.reject(cjs), 'pg', 'postgres')).rejects.toThrow(
      /Install the "pg" package/,
    );
  });

  test('a missing NESTED dependency is not blamed on the user (original error is rethrown)', async () => {
    const nested = Object.assign(
      new Error("Cannot find package 'some-transitive' imported from /node_modules/pg/x.js"),
      {
        code: 'ERR_MODULE_NOT_FOUND',
      },
    );
    await expect(importPeer(() => Promise.reject(nested), 'pg', 'postgres')).rejects.toBe(nested);
  });

  test('other import failures are rethrown untouched', async () => {
    const boom = new Error('syntax error in module');
    await expect(importPeer(() => Promise.reject(boom), 'pg', 'postgres')).rejects.toBe(boom);
  });

  test('unwraps default exports', async () => {
    expect(
      await importPeer(() => Promise.resolve({ default: { Pool: 1 } }), 'pg', 'postgres'),
    ).toEqual({ Pool: 1 });
    expect(await importPeer(() => Promise.resolve({ Pool: 2 }), 'pg', 'postgres')).toEqual({
      Pool: 2,
    });
  });
});

describe('createDriver with a host-supplied pool', () => {
  test('needs no driver package at all', async () => {
    vi.resetModules();
    const { createDriver } = await import('../../src/driver/index.js');
    const opts = { max: 1, connectTimeoutMs: 100, redact: createRedactor([]) };
    const pool = { query: () => Promise.resolve({ rows: [] }) };
    await expect(
      createDriver('postgres', { ...opts, credential: { pool } }),
    ).resolves.toBeDefined();
  });
});

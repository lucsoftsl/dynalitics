// Spec v0.5 (A1-A5): one adapter package per database; the core imports no driver and has no dependencies.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as adapterEntry from '../../src/adapter.js';
import { DriverError, isDriverError, isTransientError } from '../../src/driver/types.js';

const packagesRoot = resolve(__dirname, '../../..');
const ADAPTERS = [
  { dir: 'dynalitics-postgres', driver: 'pg' },
  { dir: 'dynalitics-mysql', driver: 'mysql2' },
  { dir: 'dynalitics-mssql', driver: 'mssql' },
] as const;

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: unknown;
}
const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(packagesRoot, dir, 'package.json'), 'utf8')) as Manifest;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const bareImports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(SPECIFIER)]
    .map((m) => m[1]!)
    .filter((s) => !s.startsWith('.'));

describe('core package (dynalitics)', () => {
  test('has no dependencies and no peer dependencies', () => {
    const core = manifest('dynalitics');
    expect(core.dependencies ?? {}).toEqual({});
    expect(core.peerDependencies ?? {}).toEqual({});
    expect(core.peerDependenciesMeta).toBeUndefined();
  });

  test('no source file imports a driver or an adapter package', () => {
    const offenders = sourceFiles(join(packagesRoot, 'dynalitics/src')).flatMap((f) =>
      bareImports(f)
        .filter((s) => /^(pg|mysql2|mssql|tedious)(\/|$)|^dynalitics-/.test(s))
        .map((s) => `${f}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  test('dynalitics/adapter exposes the contract an adapter needs', () => {
    expect(adapterEntry.ADAPTER_API_VERSION).toBe(1);
    expect(Object.keys(adapterEntry).sort()).toEqual(
      [
        'ADAPTER_API_VERSION',
        'DEFAULT_REQUEST_TIMEOUT_MS',
        'DriverError',
        'IDLE_TIMEOUT_MS',
        'errCode',
        'errMessage',
        'isDriverError',
        'isTransientError',
        'scrubMessage',
        'toDriverError',
      ].sort(),
    );
  });
});

describe.each(ADAPTERS)('$dir', ({ dir, driver }) => {
  test(`depends on exactly one driver (${driver}), pinned exactly, and on dynalitics as a peer`, () => {
    const m = manifest(dir);
    const core = manifest('dynalitics');
    expect(m.name).toBe(dir);
    expect(Object.keys(m.dependencies ?? {})).toEqual([driver]);
    expect(m.dependencies![driver]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.peerDependencies).toEqual({ dynalitics: core.version });
    expect(m.version).toBe(core.version);
  });

  test(`imports only ${driver} and dynalitics/adapter`, () => {
    const specs = new Set(sourceFiles(join(packagesRoot, dir, 'src')).flatMap(bareImports));
    for (const s of specs) expect([driver, `${driver}/promise`, 'dynalitics/adapter']).toContain(s);
  });
});

describe('DriverError brand (A5)', () => {
  test('a DriverError from another copy of dynalitics is still recognised', () => {
    // Simulates an adapter that resolved a second copy: same brand, different class identity.
    const foreign = Object.assign(new Error('x'), {
      [Symbol.for('dynalitics.DriverError')]: true,
      transient: true,
    });
    expect(foreign instanceof DriverError).toBe(false);
    expect(isDriverError(foreign)).toBe(true);
    expect(isTransientError(foreign)).toBe(true);
  });

  test('plain errors and look-alikes without the brand are not driver errors', () => {
    expect(isDriverError(new Error('x'))).toBe(false);
    expect(isDriverError({ transient: true })).toBe(false);
    expect(isDriverError(null)).toBe(false);
    expect(isDriverError(new DriverError({ name: 'E', message: 'm' }, false, false))).toBe(true);
  });
});

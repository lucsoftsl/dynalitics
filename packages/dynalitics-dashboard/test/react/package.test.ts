import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { RangeKey as UiRangeKey } from '../../src/ui/ranges.js';
import type { RangeKey } from '../../src/react/index.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  exports: Record<string, unknown>;
  files: string[];
  scripts: Record<string, string>;
}
const read = (p: string): PackageJson =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../..', p), 'utf8')) as PackageJson;
const pkg = read('package.json');
const root = read('../../package.json');

describe('package contract for dynalitics-dashboard/react', () => {
  test('exports the entry and the stylesheet', () => {
    expect(pkg.exports['./react']).toEqual({
      types: './dist/react/index.d.ts',
      default: './dist/react/index.js',
    });
    expect(pkg.exports['./react/styles.css']).toBe('./dist/react/dashboard.css');
  });

  test('react and react-dom are optional peers, never dependencies', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(['react', 'react-dom']);
    for (const name of ['react', 'react-dom']) {
      expect(pkg.peerDependencies[name]).toBe('^18.0.0 || ^19.0.0');
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
  });

  test('dev dependencies are pinned exactly', () => {
    for (const [name, range] of Object.entries(pkg.devDependencies))
      expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('src/ui stays out of the tarball and the react build runs in both build entry points', () => {
    expect(pkg.files).toContain('!dist/ui');
    expect(pkg.scripts.build).toContain('build-react.mjs');
    expect(root.scripts.build).toContain('build:react');
  });

  test('the public RangeKey is the same type the HTML dashboard uses', () => {
    expectTypeOf<RangeKey>().toEqualTypeOf<UiRangeKey>();
  });
});

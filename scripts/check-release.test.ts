import { describe, expect, test } from 'vitest';
import { checkPackage, type CheckInput } from './check-release.mjs';

const good = (): CheckInput => ({
  pkg: {
    name: 'demo',
    version: '1.2.3',
    license: 'MIT',
    engines: { node: '>=22' },
    files: ['dist'],
    publishConfig: { access: 'public', provenance: true },
    repository: { url: 'git+https://github.com/acme/dynalitics.git' },
    main: './dist/index.js',
    exports: { '.': { default: './dist/index.js' } },
  },
  files: ['LICENSE', 'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts'],
  size: 5000,
  exists: () => true,
  licenseText: 'MIT text',
  rootLicenseText: 'MIT text',
  hasReadme: true,
});

const problemsFor = (patch: (i: CheckInput) => CheckInput) => checkPackage(patch(good()));

describe('release rules', () => {
  test('a clean package passes', () => {
    expect(checkPackage(good())).toEqual([]);
  });
  test('private, placeholder repository, wrong license and missing provenance are caught', () => {
    const p = problemsFor((i) => ({
      ...i,
      pkg: {
        ...i.pkg,
        private: true,
        license: 'ISC',
        repository: { url: 'git+https://github.com/OWNER/x.git' },
        publishConfig: { access: 'public' },
      },
    })).join('\n');
    expect(p).toContain('"private": true');
    expect(p).toContain('license must be MIT');
    expect(p).toContain('placeholder');
    expect(p).toContain('provenance');
  });
  test('--ci mode tolerates only the repository placeholder', () => {
    const placeholder = (i: CheckInput): CheckInput => ({
      ...i,
      pkg: { ...i.pkg, repository: { url: 'git+https://github.com/OWNER/x.git' } },
    });
    expect(problemsFor((i) => ({ ...placeholder(i), allowPlaceholder: true }))).toEqual([]);
    expect(
      problemsFor((i) => ({
        ...placeholder(i),
        allowPlaceholder: true,
        pkg: { ...placeholder(i).pkg, private: true },
      })).join(),
    ).toContain('private');
  });
  test('tag must equal the package version', () => {
    expect(problemsFor((i) => ({ ...i, tag: 'v1.2.4' })).join()).toContain('does not match tag');
    expect(problemsFor((i) => ({ ...i, tag: 'v1.2.3' }))).toEqual([]);
  });
  test('runtime dependencies and install-time scripts are rejected', () => {
    const p = problemsFor((i) => ({
      ...i,
      pkg: { ...i.pkg, dependencies: { left: '1' }, scripts: { postinstall: 'node x' } },
    })).join('\n');
    expect(p).toContain('runtime "dependencies"');
    expect(p).toContain('postinstall');
  });
  test('an adapter may depend on its one driver, pinned exactly, and must peer on the same dynalitics', () => {
    const adapter = (deps: Record<string, string>, peer = '1.2.3') =>
      problemsFor((i) => ({
        ...i,
        pkg: {
          ...i.pkg,
          name: 'dynalitics-postgres',
          dependencies: deps,
          peerDependencies: { dynalitics: peer },
        },
      })).join('\n');
    expect(adapter({ pg: '8.23.1' })).toBe('');
    expect(adapter({ pg: '^8.23.1' })).toContain('must be an exact version');
    expect(adapter({ pg: '8.23.1', mssql: '12.7.13' })).toContain('runtime "dependencies" (mssql)');
    expect(adapter({ pg: '8.23.1' }, '1.2.2')).toContain('must equal this package');
  });
  test('the core and the dashboard may not take a driver dependency', () => {
    for (const name of ['dynalitics', 'dynalitics-dashboard'])
      expect(
        problemsFor((i) => ({
          ...i,
          pkg: { ...i.pkg, name, dependencies: { pg: '8.23.1' } },
        })).join(),
      ).toContain('runtime "dependencies" (pg)');
  });
  test('stale build output (a compiled file whose source was deleted) is rejected', () => {
    const stale = (name: string) =>
      problemsFor((i) => ({
        ...i,
        pkg: { ...i.pkg, name },
        files: [...i.files, 'dist/driver/postgres.js', 'dist/react/index.js'],
        exists: (p: string) => p !== 'src/driver/postgres.ts' && p !== 'src/driver/postgres.tsx',
      })).join('\n');
    expect(stale('dynalitics')).toContain('stale build output in tarball: dist/driver/postgres.js');
    expect(stale('dynalitics')).not.toContain('dist/react/index.js');
    expect(stale('dynalitics-dashboard')).not.toContain('stale'); // bundled, not mirrored
  });
  test('sources, maps, env files and keys in the tarball are rejected', () => {
    const p = problemsFor((i) => ({
      ...i,
      files: [...i.files, 'src/a.ts', 'dist/a.js.map', '.env', 'test/a.test.ts', 'server.pem'],
    })).join('\n');
    for (const f of ['src/a.ts', 'dist/a.js.map', '.env', 'test/a.test.ts', 'server.pem'])
      expect(p).toContain(f);
  });
  test('missing build output, README, LICENSE copy and oversize tarballs are caught', () => {
    const p = problemsFor((i) => ({
      ...i,
      exists: () => false,
      hasReadme: false,
      licenseText: null,
      size: 2_000_000,
      files: ['package.json'],
    })).join('\n');
    expect(p).toContain('does not exist');
    expect(p).toContain('README.md is missing');
    expect(p).toContain('LICENSE is missing');
    expect(p).toContain('byte guard');
    expect(p).toContain('no dist/ files');
  });
  test('bin targets are checked too', () => {
    const p = problemsFor((i) => ({
      ...i,
      pkg: { ...i.pkg, bin: { x: './dist/cli.js' } },
      exists: (f) => f !== 'dist/cli.js',
    })).join();
    expect(p).toContain('./dist/cli.js');
  });
});

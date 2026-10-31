import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Regression guard for the release gate (docs/RELEASING.md). Text based on purpose: the repository has no YAML
// parser and this must not add a dependency. If this test needs changing, the gate is being changed: say so.
const dir = join(import.meta.dirname, '../.github/workflows');
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
const release = read('release.yml');
const ci = read('ci.yml');
const mssql = read('mssql.yml');

/** The text of one top-level job: from `  name:` to the next two-space key (or the end of the file). */
function job(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job ${name} exists`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

describe('release gate', () => {
  test('publish needs the full CI (ci.yml called as a reusable workflow) and the strict release checks', () => {
    expect(job(release, 'ci')).toMatch(/uses:\s*\.\/\.github\/workflows\/ci\.yml\s*$/m);
    const needs = /needs:\s*\[([^\]]*)\]/.exec(job(release, 'publish'))?.[1] ?? '';
    expect(
      needs
        .split(',')
        .map((s) => s.trim())
        .sort(),
    ).toEqual(['ci', 'release-checks', 'version']);
  });
  test('nothing can override the needs: no job-level `if:` on a publish job, no continue-on-error anywhere', () => {
    for (const name of ['publish', 'publish-mssql'])
      expect(job(release, name)).not.toMatch(/^ {4}if:/m); // step-level ifs (the tag step) are fine
    for (const text of [release, ci, mssql]) expect(text).not.toMatch(/continue-on-error/);
  });
  test('ci.yml is callable and gates on PostgreSQL and MySQL', () => {
    expect(ci).toMatch(/^ {2}workflow_call:/m);
    expect(ci).toMatch(/dialect:\s*\[postgres, mysql\]/);
    expect(job(ci, 'integration')).toContain('npx vitest run packages/dynalitics/test/integration');
    expect(job(ci, 'integration')).toContain('--passWithNoTests=false');
  });
  test('SQL Server: its own callable workflow; dynalitics-mssql publishes only when it is green, after the core', () => {
    expect(mssql).toMatch(/^ {2}workflow_call:/m);
    expect(mssql).toContain('DYNALITICS_TEST_DIALECTS: mssql');
    expect(mssql).toContain('--passWithNoTests=false');
    expect(job(release, 'mssql')).toMatch(/uses:\s*\.\/\.github\/workflows\/mssql\.yml\s*$/m);
    const needs = /needs:\s*\[([^\]]*)\]/.exec(job(release, 'publish-mssql'))?.[1] ?? '';
    expect(
      needs
        .split(',')
        .map((x) => x.trim())
        .sort(),
    ).toEqual(['mssql', 'publish', 'version']);
    expect(job(release, 'publish')).not.toContain('dynalitics-mssql');
    expect(job(release, 'publish-mssql')).toContain('packages/dynalitics-mssql');
  });
  test('a real publish happens only for main (push, or a manual run with dry_run off); anything else is a dry run', () => {
    for (const name of ['publish', 'publish-mssql']) {
      expect(job(release, name)).toContain(
        "REAL_RELEASE: ${{ github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.dry_run == false) }}",
      );
      expect(job(release, name)).toMatch(/flag="--dry-run"/);
    }
    expect(release).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(release).toMatch(/dry_run:[\s\S]*?default: true/);
  });
  test('the version is computed by the tested script and applied before every build that is published', () => {
    expect(job(release, 'version')).toContain('node scripts/release-version.mjs next');
    for (const name of ['release-checks', 'publish', 'publish-mssql']) {
      const text = job(release, name);
      expect(text.indexOf('release-version.mjs apply')).toBeGreaterThan(-1);
      expect(text.indexOf('release-version.mjs apply')).toBeLessThan(text.indexOf('npm run build'));
    }
  });
  test('trusted publishing: OIDC and provenance, no npm token anywhere', () => {
    for (const name of ['publish', 'publish-mssql']) {
      const publish = job(release, name);
      expect(publish).toContain('id-token: write');
      expect(publish).toContain('--provenance');
      expect(publish).toContain('environment: npm-publish');
    }
    const code = (t: string): string =>
      t
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
    for (const text of [release, ci, mssql])
      expect(code(text)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  });
  test('every third-party action is pinned to a full commit SHA', () => {
    for (const text of [release, ci, mssql]) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) {
        if (u.startsWith('./')) continue;
        expect(u, u).toMatch(/^[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });
});

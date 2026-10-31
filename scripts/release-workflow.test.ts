import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Regression guard for the release gate (docs/RELEASING.md). Text based on purpose: the repository has no YAML
// parser and this must not add a dependency. If this test needs changing, the gate is being changed: say so.
const dir = join(import.meta.dirname, '../.github/workflows');
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
const release = read('release.yml');
const ci = read('ci.yml');

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
    ).toEqual(['ci', 'release-checks']);
  });
  test('nothing can override the needs: publish has no `if:` and no continue-on-error anywhere', () => {
    expect(job(release, 'publish')).not.toMatch(/^\s*if:/m);
    expect(release).not.toMatch(/continue-on-error/);
    expect(ci).not.toMatch(/continue-on-error/);
  });
  test('ci.yml is callable and its integration matrix includes SQL Server', () => {
    expect(ci).toMatch(/^ {2}workflow_call:/m);
    expect(ci).toMatch(/dialect:\s*\[postgres, mysql, mssql\]/);
    expect(job(ci, 'integration')).toContain('npx vitest run packages/dynalitics/test/integration');
    expect(job(ci, 'integration')).toContain('--passWithNoTests=false');
  });
  test('a real publish needs a tag; a branch run can never publish', () => {
    expect(job(release, 'publish')).toContain("github.ref_type == 'tag'");
    expect(job(release, 'publish')).toMatch(/flag="--dry-run"/);
  });
  test('trusted publishing: OIDC and provenance, no npm token anywhere', () => {
    const publish = job(release, 'publish');
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('--provenance');
    expect(publish).toContain('environment: npm-publish');
    const code = (t: string): string =>
      t
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
    for (const text of [release, ci])
      expect(code(text)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  });
  test('every third-party action is pinned to a full commit SHA', () => {
    for (const text of [release, ci]) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? '');
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) {
        if (u.startsWith('./')) continue;
        expect(u, u).toMatch(/^[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });
});

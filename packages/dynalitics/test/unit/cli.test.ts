import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli, type CliIo } from '../../src/cli/run.js';

function fakeIo(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const io: CliIo = {
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT: ${p}`);
      return f;
    },
    exists: (p) => p in files || p in written,
    writeFile: (p, c) => void (written[p] = c),
  };
  return { io, out: () => out.join(''), err: () => err.join(''), written };
}

describe('dynalitics sql', () => {
  test('prints the recommended schema to stdout and nothing to stderr', async () => {
    const f = fakeIo();
    const code = await runCli(['sql', '--dialect', 'postgres', '--table', 'public.events'], f.io);
    expect(code).toBe(0);
    expect(f.out()).toContain('CREATE TABLE "public"."events"');
    expect(f.out()).toContain('CREATE INDEX');
    expect(f.out()).not.toContain('GRANT');
    expect(f.err()).toBe('');
  });

  test('--grants appends grants, --no-indexes drops indexes', async () => {
    const f = fakeIo();
    await runCli(
      ['sql', '--dialect', 'mysql', '--table', 'd.events', '--grants', '--no-indexes'],
      f.io,
    );
    expect(f.out()).toContain('GRANT INSERT ON `d`.`events` TO <writer_role>;');
    expect(f.out()).not.toContain('CREATE INDEX');
  });

  test('--grants-only prints only grants and works without a config', async () => {
    const f = fakeIo();
    const code = await runCli(
      [
        'sql',
        '--dialect',
        'mssql',
        '--table',
        'dbo.page_views',
        '--grants-only',
        '--writer',
        'w1',
        '--reader',
        'r1',
      ],
      f.io,
    );
    expect(code).toBe(0);
    expect(f.out()).toContain('GRANT INSERT ON OBJECT::[dbo].[page_views] TO [w1];');
    expect(f.out()).toContain('TO [r1];');
    expect(f.out()).not.toContain('CREATE TABLE');
  });

  test('--config reads schema options from JSON only', async () => {
    const f = fakeIo({
      'schema.json': JSON.stringify({
        columns: { email: false },
        customFields: { plan: { type: 'string', personal: false, column: true } },
        firstVisit: { enabled: true },
      }),
    });
    const code = await runCli(
      ['sql', '--dialect', 'postgres', '--table', 'e', '--config', 'schema.json', '--grants'],
      f.io,
    );
    expect(code).toBe(0);
    expect(f.out()).not.toContain('"email"');
    expect(f.out()).toContain('"plan"');
    expect(f.out()).toContain('"is_first_visit"');
    expect(f.out()).toContain('GRANT SELECT ("user_id", "ip_address")');
  });

  test('--config refuses connection settings and unknown keys', async () => {
    const f = fakeIo({
      'c.json': JSON.stringify({ connection: { connectionString: 'postgres://u:pw12345@h/db' } }),
    });
    const code = await runCli(
      ['sql', '--dialect', 'postgres', '--table', 'e', '--config', 'c.json'],
      f.io,
    );
    expect(code).toBe(1);
    expect(f.err()).toContain('unknown key');
    expect(f.err()).not.toContain('pw12345');
    expect(f.out()).toBe('');
  });

  test('--config with invalid JSON or a missing file is a usage error', async () => {
    const bad = fakeIo({ 'c.json': '{not json' });
    expect(
      await runCli(['sql', '--dialect', 'postgres', '--table', 'e', '--config', 'c.json'], bad.io),
    ).toBe(1);
    expect(bad.err()).toContain('not valid JSON');
    const missing = fakeIo();
    expect(
      await runCli(
        ['sql', '--dialect', 'postgres', '--table', 'e', '--config', 'nope.json'],
        missing.io,
      ),
    ).toBe(1);
    expect(missing.err()).toContain('Cannot read');
  });

  test('--out writes a file, but refuses to overwrite without --force', async () => {
    const f = fakeIo({ 'existing.sql': 'old' });
    expect(
      await runCli(['sql', '--dialect', 'postgres', '--table', 'e', '--out', 'new.sql'], f.io),
    ).toBe(0);
    expect(f.written['new.sql']).toContain('CREATE TABLE');
    expect(f.out()).toBe('');
    expect(
      await runCli(['sql', '--dialect', 'postgres', '--table', 'e', '--out', 'existing.sql'], f.io),
    ).toBe(1);
    expect(f.err()).toContain('Refusing to overwrite');
    expect(f.written['existing.sql']).toBeUndefined();
    expect(
      await runCli(
        ['sql', '--dialect', 'postgres', '--table', 'e', '--out', 'existing.sql', '--force'],
        f.io,
      ),
    ).toBe(0);
    expect(f.written['existing.sql']).toContain('CREATE TABLE');
  });

  test('usage errors exit 1 with a message on stderr only', async () => {
    for (const argv of [
      ['sql'],
      ['sql', '--dialect', 'oracle', '--table', 'e'],
      ['sql', '--dialect', 'postgres'],
      ['sql', '--dialect', 'postgres', '--table', 'e; DROP TABLE x'],
      ['sql', '--dialect', 'postgres', '--table', 'e', '--bogus'],
      ['sql', '--dialect', 'postgres', '--table', 'e', '--writer', 'x; DROP', '--grants'],
      ['frobnicate'],
    ]) {
      const f = fakeIo();
      expect(await runCli(argv, f.io)).toBe(1);
      expect(f.out()).toBe('');
      expect(f.err().length).toBeGreaterThan(0);
    }
  });

  test('--help and --version', async () => {
    const h = fakeIo();
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.out()).toContain('dynalitics sql');
    expect(h.out()).toContain('never connects');
    const v = fakeIo();
    expect(await runCli(['--version'], v.io)).toBe(0);
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version: string;
    };
    expect(v.out().trim()).toBe(pkg.version);
  });

  test('inspect is announced but not available yet', async () => {
    const f = fakeIo();
    expect(await runCli(['inspect'], f.io)).toBe(1);
    expect(f.err()).toContain('not available yet');
  });
});

describe('the sql command never connects: its import graph reaches no database driver', () => {
  const srcRoot = resolve(__dirname, '../../src');
  // `import type` / `export type` lines are erased at runtime, so they are not edges of the runtime graph.
  const importRe =
    /^(?!\s*(?:import|export)\s+type\b).*?(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gm;

  function graph(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(importRe)) {
        const spec = m[1]!;
        if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
        else seen.add(`pkg:${spec}`);
      }
    }
    return seen;
  }

  test.each([['cli/run.ts'], ['cli.ts'], ['schema/index.ts']])('%s', (entry) => {
    const g = [...graph(join(srcRoot, entry))];
    expect(g.filter((f) => f.includes('/driver/'))).toEqual([]);
    expect(
      g.filter(
        (f) =>
          /^pkg:(pg|mysql2|mssql|net|tls|http|https|dns)(\/|$)/.test(f) ||
          /^pkg:node:(net|tls|http|https|dns)$/.test(f),
      ),
    ).toEqual([]);
  });

  test('sanity: the graph walker does see the driver from the library entry point', () => {
    const g = [...graph(join(srcRoot, 'create.ts'))];
    expect(g.some((f) => f.includes('/driver/'))).toBe(true);
    expect(statSync(srcRoot).isDirectory()).toBe(true);
    expect(readdirSync(srcRoot)).toContain('create.ts');
  });
});

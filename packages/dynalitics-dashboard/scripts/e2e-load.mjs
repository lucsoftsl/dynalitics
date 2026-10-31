// Bundles test/e2e/harness.ts (and the server sources / integration fixtures it imports) and the oracle into ESM
// files that Node can run. The database drivers stay external so they resolve from the repository's node_modules.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '../..');

export async function loadModules() {
  const outdir = join(repo, 'node_modules/.cache/dynalitics-e2e');
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [join(root, 'test/e2e/harness.ts'), join(root, 'test/e2e/oracle.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outdir,
    outExtension: { '.js': '.mjs' },
    external: ['pg', 'mysql2', 'mysql2/promise', 'mssql'],
    logLevel: 'silent',
  });
  const stamp = `?t=${Date.now()}`;
  return {
    harness: await import(`${pathToFileURL(join(outdir, 'harness.mjs')).href}${stamp}`),
    oracle: await import(`${pathToFileURL(join(outdir, 'oracle.mjs')).href}${stamp}`),
  };
}

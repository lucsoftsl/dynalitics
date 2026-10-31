// Deletes every package's build output before a build. `tsc -b` never removes the output of a source file that
// was deleted, so without this a stale dist/ (e.g. the pre-v0.5 dist/driver/postgres.js) would be published.
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = join(dirname(fileURLToPath(import.meta.url)), '../packages');
for (const dir of readdirSync(packages)) {
  const pkg = join(packages, dir);
  rmSync(join(pkg, 'dist'), { recursive: true, force: true });
  for (const f of readdirSync(pkg))
    if (f.endsWith('.tsbuildinfo')) rmSync(join(pkg, f), { force: true });
}

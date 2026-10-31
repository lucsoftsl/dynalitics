// Version for an automatic release (docs/RELEASING.md, "Publishing on push").
//   node scripts/release-version.mjs next          prints the version the next release gets
//   node scripts/release-version.mjs apply X.Y.Z   writes X.Y.Z into every package, the adapters' exact
//                                                  `dynalitics` peer pin and packages/dynalitics/src/version.ts
// The repository is NOT committed by the workflow: package.json keeps the base version, npm holds the truth.
// To release a minor or major, raise the version in the repository (e.g. 0.2.0) and push: that wins.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const parse = (v) => {
  const m = SEMVER.exec(v ?? '');
  if (!m) throw new Error(`not a plain X.Y.Z version: ${String(v)}`);
  return m.slice(1).map(Number);
};
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * Pure. `repo`: the version in packages/dynalitics/package.json. `published`: the latest version on npm, or null
 * if nothing was published yet. The repository wins when it is ahead (a deliberate minor/major bump); otherwise
 * the patch after the published version.
 */
export function nextVersion(repo, published) {
  parse(repo);
  if (published === null) return repo;
  if (compare(repo, published) > 0) return repo;
  const [major, minor, patch] = parse(published);
  return `${major}.${minor}.${patch + 1}`;
}

/** Pure. Returns the new package.json text with the version (and an exact `dynalitics` peer pin) replaced. */
export function withVersion(pkgText, version) {
  parse(version);
  const pkg = JSON.parse(pkgText);
  pkg.version = version;
  if (pkg.peerDependencies?.dynalitics !== undefined) pkg.peerDependencies.dynalitics = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function publishedVersion(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (err) {
    if (/E404|404 Not Found/.test(String(err.stderr ?? err.message))) return null;
    throw err;
  }
}

function apply(version) {
  const packages = join(root, 'packages');
  for (const dir of readdirSync(packages)) {
    const file = join(packages, dir, 'package.json');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    writeFileSync(file, withVersion(text, version));
  }
  writeFileSync(
    join(packages, 'dynalitics/src/version.ts'),
    `/** Kept in sync with package.json by a unit test. */\nexport const VERSION = '${version}';\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'next') {
    const repo = JSON.parse(readFileSync(join(root, 'packages/dynalitics/package.json'), 'utf8'));
    console.log(nextVersion(repo.version, publishedVersion('dynalitics')));
  } else if (cmd === 'apply' && arg) {
    apply(arg);
    console.log(`applied ${arg}`);
  } else {
    console.error('usage: release-version.mjs next | apply X.Y.Z');
    process.exit(2);
  }
}

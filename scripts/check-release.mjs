// Release gate: verifies what `npm publish` would ship, without publishing anything.
//   node scripts/check-release.mjs [--tag v1.2.3] [--ci]
// --ci tolerates the OWNER repository placeholder (day-to-day CI); the release workflow never uses it.
// Needs a finished build (`npm run build`). Exits 1 and lists every problem found.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_DIRS = [
  'packages/dynalitics',
  'packages/dynalitics-postgres',
  'packages/dynalitics-mysql',
  'packages/dynalitics-mssql',
  'packages/dynalitics-consent',
  'packages/dynalitics-dashboard',
];
/** Spec v0.5: only an adapter package may have a runtime dependency, and only its one driver, pinned exactly. */
export const ALLOWED_DEPENDENCIES = {
  'dynalitics-postgres': ['pg'],
  'dynalitics-mysql': ['mysql2'],
  'dynalitics-mssql': ['mssql'],
};
const MAX_TARBALL_BYTES = 1024 * 1024;
const ALLOWED = [/^dist\//, /^package\.json$/, /^README\.md$/, /^LICENSE$/];
const FORBIDDEN = [
  /\.map$/,
  /\.tsbuildinfo$/,
  /(^|\/)\.env/,
  /(^|\/)src\//,
  /(^|\/)test\//,
  /\.pem$|\.key$/,
];

const targets = (value) => {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(targets);
  return [];
};

/**
 * Pure rules. `files` = paths inside the tarball, `exists(relPath)` checks the package dir.
 * Returns a list of human-readable problems (empty = fine).
 */
export function checkPackage({
  pkg,
  files,
  size,
  exists,
  tag,
  licenseText,
  rootLicenseText,
  hasReadme,
  allowPlaceholder = false,
}) {
  const problems = [];
  const bad = (msg) => problems.push(`${pkg.name}: ${msg}`);
  if (pkg.private) bad('is still "private": true, npm would refuse to publish it');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version ?? ''))
    bad(`version "${pkg.version}" is not semver`);
  if (tag && tag.replace(/^v/, '') !== pkg.version)
    bad(`version ${pkg.version} does not match tag ${tag}`);
  if (pkg.license !== 'MIT') bad('license must be MIT');
  if (!pkg.engines?.node?.includes('22')) bad('engines.node must require Node 22+');
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) bad('"files" allow-list is missing');
  if (pkg.publishConfig?.access !== 'public') bad('publishConfig.access must be "public"');
  if (pkg.publishConfig?.provenance !== true) bad('publishConfig.provenance must be true');
  const repoUrl = pkg.repository?.url ?? '';
  if (!allowPlaceholder && (!repoUrl || /OWNER|example\.com|<.+>/.test(repoUrl)))
    bad(
      `repository.url is a placeholder (${repoUrl || 'missing'}); provenance needs the real GitHub repo`,
    );
  for (const field of ['homepage', 'bugs']) {
    if (!allowPlaceholder && /OWNER/.test(JSON.stringify(pkg[field] ?? '')))
      bad(`${field} still contains the OWNER placeholder`);
  }
  const allowedDeps = ALLOWED_DEPENDENCIES[pkg.name] ?? [];
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!allowedDeps.includes(dep))
      bad(
        `has runtime "dependencies" (${dep}); only an adapter package may depend on its one driver (docs/SPEC.md principle 1)`,
      );
    else if (!/^\d+\.\d+\.\d+$/.test(range))
      bad(`dependency ${dep}@${range} must be an exact version (supply-chain policy)`);
  }
  const corePeer = pkg.peerDependencies?.dynalitics;
  if (corePeer !== undefined && corePeer !== pkg.version)
    bad(`peer dependency dynalitics@${corePeer} must equal this package's version ${pkg.version}`);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (pkg.scripts?.[script])
      bad(
        `has a "${script}" lifecycle script; the supply-chain policy forbids install-time scripts`,
      );
  }
  for (const t of [...targets(pkg.exports), ...targets(pkg.bin), pkg.main, pkg.types].filter(
    Boolean,
  )) {
    if (!exists(t.replace(/^\.\//, '')))
      bad(`${t} is referenced by package.json but does not exist (run the build first)`);
  }
  if (!hasReadme) bad('README.md is missing from the package directory');
  if (licenseText === null || licenseText !== rootLicenseText)
    bad('LICENSE is missing or differs from the repository LICENSE');
  for (const f of files) {
    if (!ALLOWED.some((re) => re.test(f))) bad(`unexpected file in tarball: ${f}`);
    if (FORBIDDEN.some((re) => re.test(f))) bad(`forbidden file in tarball: ${f}`);
  }
  if (!files.includes('LICENSE')) bad('tarball does not contain LICENSE');
  if (!files.includes('README.md')) bad('tarball does not contain README.md');
  if (!files.some((f) => f.startsWith('dist/'))) bad('tarball contains no dist/ files');
  if (size > MAX_TARBALL_BYTES)
    bad(`tarball is ${size} bytes, over the ${MAX_TARBALL_BYTES} byte guard`);
  return problems;
}

function packList(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: join(root, dir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [info] = JSON.parse(out);
  return { files: info.files.map((f) => f.path), size: info.size };
}

export function checkAll(tag, allowPlaceholder = false) {
  const rootLicenseText = readFileSync(join(root, 'LICENSE'), 'utf8');
  const problems = [];
  const summary = [];
  for (const dir of PACKAGE_DIRS) {
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    const { files, size } = packList(dir);
    const licensePath = join(root, dir, 'LICENSE');
    problems.push(
      ...checkPackage({
        pkg,
        files,
        size,
        tag,
        exists: (p) => existsSync(join(root, dir, p)),
        licenseText: existsSync(licensePath) ? readFileSync(licensePath, 'utf8') : null,
        rootLicenseText,
        hasReadme: existsSync(join(root, dir, 'README.md')),
        allowPlaceholder,
      }),
    );
    summary.push(
      `${pkg.name}@${pkg.version}: ${files.length} files, ${(size / 1024).toFixed(1)} KB packed`,
    );
  }
  return { problems, summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--tag');
  const { problems, summary } = checkAll(
    i > -1 ? process.argv[i + 1] : undefined,
    process.argv.includes('--ci'),
  );
  for (const line of summary) console.log(line);
  if (problems.length) {
    console.error(`\nrelease check FAILED (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('release check passed');
}

// Builds `dynalitics-dashboard/react` into dist/react (run after `tsc -b`, see the package scripts):
//   dist/react/index.js      one ESM bundle. src/ui helpers (formatters, state machine, scales) are
//                            inlined because dist/ui is not shipped; only react is imported.
//   dist/react/dashboard.css the HTML dashboard's stylesheet scoped under .dy-root (scripts/react-css.mjs)
//   dist/react/*.d.ts        declarations reachable from index.d.ts; they must not point into src/ui
// Nothing here runs at install time and nothing is published by it.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { transformCss } from './react-css.mjs';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(pkgRoot, 'dist/react');
const FORBIDDEN_IN_BUNDLE = [
  [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
  [/\.innerHTML\s*=|\binsertAdjacentHTML\b|document\.write/, 'raw HTML insertion'],
  [/\beval\s*\(|new Function\s*\(/, 'dynamic code execution'],
];

function bundleChecks(js) {
  const problems = [];
  const imports = [...js.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
  for (const spec of imports)
    if (!['react', 'react/jsx-runtime'].includes(spec))
      problems.push(
        `dist/react/index.js imports "${spec}"; only react and react/jsx-runtime are allowed`,
      );
  for (const [re, name] of FORBIDDEN_IN_BUNDLE)
    if (re.test(js)) problems.push(`dist/react/index.js contains ${name}`);
  return problems;
}

/** Relative `.d.ts` files reachable from `entry` (index.d.ts), as paths relative to `dir`. */
function reachable(dir, entry) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(dir, rel), 'utf8');
    for (const m of src.matchAll(/from\s*['"](\.{1,2}\/[^'"]+)\.js['"]/g)) {
      const next = normalize(join(dirname(rel), `${m[1]}.d.ts`));
      if (!next.startsWith('..') && existsSync(join(dir, next))) visit(next);
    }
  };
  visit(entry);
  return [...seen];
}

export async function buildReact() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  await build({
    entryPoints: [join(pkgRoot, 'src/react/index.ts')],
    outfile: join(out, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    legalComments: 'none',
    logLevel: 'silent',
  });
  const js = readFileSync(join(out, 'index.js'), 'utf8');
  const css = transformCss(readFileSync(join(pkgRoot, 'src/ui/styles.css'), 'utf8'));
  writeFileSync(join(out, 'dashboard.css'), css);

  const tmp = mkdtempSync(join(tmpdir(), 'dyn-react-types-'));
  const problems = bundleChecks(js);
  try {
    const tsc = join(pkgRoot, '../../node_modules/typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.react.json', '--outDir', tmp], {
      cwd: pkgRoot,
      stdio: 'inherit',
    });
    const types = reachable(join(tmp, 'react'), 'index.d.ts');
    for (const rel of types) {
      const text = readFileSync(join(tmp, 'react', rel), 'utf8');
      const bad = /from\s*['"](?:\.\.\/)+(?:ui\/|\.\.\/)[^'"]*['"]/.exec(text);
      if (bad)
        problems.push(
          `dist/react/${rel} imports ${bad[0]}: public types must not depend on src/ui`,
        );
      const target = join(out, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) throw new Error(`react build failed:\n- ${problems.join('\n- ')}`);
  return {
    js: statSync(join(out, 'index.js')).size,
    jsGzip: gzipSync(js).length,
    css: statSync(join(out, 'dashboard.css')).size,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await buildReact();
  console.log(
    `dist/react: index.js ${(s.js / 1024).toFixed(1)} KB (${(s.jsGzip / 1024).toFixed(1)} KB gzipped), dashboard.css ${(s.css / 1024).toFixed(1)} KB`,
  );
}

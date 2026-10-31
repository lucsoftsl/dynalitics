// Builds the single-file dashboard: src/ui/*.ts + styles.css + template.html -> one HTML string.
// Placeholders %%DYNALITICS_NONCE%% and %%DYNALITICS_BASE%% are left for the handler (SPEC 10.8).
import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NONCE = '%%DYNALITICS_NONCE%%';
const BASE = '%%DYNALITICS_BASE%%';

/** Replace `{{key}}` markers; throws if one is left over so a typo cannot ship silently. */
export function fill(template, values) {
  const out = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template marker {{${key}}} has no value`);
    return values[key];
  });
  return out;
}

/** Defends the inline-script context: the bundle must never close its own <script> early. */
export function escapeForInlineScript(js) {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

export async function buildDashboardHtml() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const bundled = await build({
    entryPoints: [join(root, 'src/ui/main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  });
  const js = escapeForInlineScript(bundled.outputFiles[0].text.trim());
  const css = (
    await transform(await readFile(join(root, 'src/ui/styles.css'), 'utf8'), {
      loader: 'css',
      minify: true,
    })
  ).code.trim();
  const themeBoot = (await readFile(join(root, 'src/ui/theme-boot.js'), 'utf8')).trim();
  const template = await readFile(join(root, 'src/ui/template.html'), 'utf8');
  const html = fill(template, {
    nonce: NONCE,
    base: BASE,
    css,
    js,
    themeBoot,
    version: pkg.version,
  });
  return { html, parts: { js, css, themeBoot, template } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { html, parts } = await buildDashboardHtml();
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'dashboard.html'), html);
  await writeFile(join(dist, 'html.js'), `export const dashboardHtml = ${JSON.stringify(html)};\n`);
  await writeFile(join(dist, 'html.d.ts'), 'export declare const dashboardHtml: string;\n');
  const bytes = (n) => Buffer.byteLength(n);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const markup = bytes(html) - bytes(parts.js) - bytes(parts.css);
  console.log(
    `dashboard.html ${kb(bytes(html))} (js ${kb(bytes(parts.js))}, css ${kb(bytes(parts.css))}, markup ${kb(markup)})`,
  );
}

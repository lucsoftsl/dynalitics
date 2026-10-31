// End-to-end run of the HTML dashboard against the REAL read handler and REAL databases.
//
//   DYNALITICS_INTEGRATION=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//     node scripts/e2e-real.mjs [outDir]
//
// Needs the containers of docker/compose.yml (PostgreSQL 17 and MySQL 8.4; DYNALITICS_E2E_DIALECTS picks which).
// Seeds rows through the package's own track(), mounts createHandler (dashboard HTML served with the real CSP and
// nonce) at several base paths, drives the page in Chromium and compares what it shows with an independent oracle
// computed from the raw table rows. Playwright is not a dependency of this repository (see screenshots.mjs).
// Skipped (exit 0) unless DYNALITICS_INTEGRATION=1, like the integration tests.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDashboardHtml } from './build-html.mjs';
import { loadModules } from './e2e-load.mjs';
import { runChecks } from './e2e-checks.mjs';

if (process.env.DYNALITICS_INTEGRATION !== '1') {
  console.log(
    'e2e-real: skipped (set DYNALITICS_INTEGRATION=1 to run against the Docker databases)',
  );
  process.exit(0);
}
const core = process.env.PLAYWRIGHT_CORE;
if (!core) {
  console.error(
    'e2e-real: set PLAYWRIGHT_CORE to a playwright-core directory (it is not a dependency of this repo)',
  );
  process.exit(2);
}
const { chromium } = await import(join(core, 'index.mjs'));
const out = process.argv[2] ?? '/tmp/dynalitics-e2e';
await mkdir(out, { recursive: true });

const dialects = (process.env.DYNALITICS_E2E_DIALECTS ?? 'postgres,mysql')
  .split(',')
  .map((s) => s.trim());
const { harness: harnessModule, oracle } = await loadModules();
const { startHarness } = harnessModule;
const { html } = await buildDashboardHtml();
const browser = await chromium.launch();
const report = { failures: [], notes: [], shots: [], checks: 0 };

for (const dialect of dialects) {
  const harness = await startHarness(dialect, html);
  try {
    await runChecks({ harness, browser, out: join(out, dialect), report, dialect, oracle });
  } finally {
    const leftovers = await harness.close();
    if (leftovers.length)
      report.failures.push(`${dialect}: cleanup left behind: ${leftovers.join(', ')}`);
    else
      report.notes.push(`${dialect}: tables, roles and users created by the run were all dropped`);
  }
}
await browser.close();

console.log(`\nchecks run: ${report.checks}; screenshots: ${report.shots.length} in ${out}`);
for (const n of report.notes) console.log(`note: ${n}`);
if (report.failures.length) {
  console.error(
    `\nFAILURES (${report.failures.length}):\n${report.failures.map((f) => `- ${f}`).join('\n')}`,
  );
  process.exit(1);
}
console.log('e2e-real: all checks passed');

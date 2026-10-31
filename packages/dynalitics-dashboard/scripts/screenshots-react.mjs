// Real-browser check of the React dashboard against the HTML dashboard (needs `npm run build` first).
// Playwright is NOT a dependency of this repo: point PLAYWRIGHT_CORE at any playwright-core install, e.g.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/screenshots-react.mjs [outDir]
//   BROWSERS=chromium,firefox,webkit  (default chromium)   SCENARIOS=ok,empty,...   ERROR_SCENARIOS=forbidden,...
// For every scenario, theme and width it loads Dan's HTML dashboard and the React dashboard on the same mock API,
// diffs each of the five panels pixel by pixel (in the browser, via canvas), and records console errors, CSP
// violations and horizontal overflow of the React page. Screenshots go to outDir.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startPreview } from './preview-server.mjs';
import { startReactPreview } from './preview-react.mjs';

const core = process.env.PLAYWRIGHT_CORE;
if (!core) throw new Error('set PLAYWRIGHT_CORE to a playwright-core directory');
const playwright = await import(join(core, 'index.mjs'));
const out = process.argv[2] ?? '/tmp/dynalitics-react-shots';
await mkdir(out, { recursive: true });

const WIDTHS = [320, 768, 1024, 1440];
const THEMES = ['light', 'dark'];
const BROWSERS = (process.env.BROWSERS ?? 'chromium').split(',');
const list = (v, d) => (v ?? d).split(',').filter(Boolean);
const PARITY = list(
  process.env.SCENARIOS,
  'ok,empty,nvr-unavailable,sparse-fields,hostile,no-cursor',
);
const ERRORS = list(process.env.ERROR_SCENARIOS, 'forbidden,unreachable,timeout,html-reply');
const PANELS = ['p-hero', 'p-pages', 'p-nvr', 'p-consent', 'p-table'];

const html = await startPreview();
const react = await startReactPreview();
const problems = [];
const rows = [];
let shots = 0;
let shared = 0;

async function settle(page, ready) {
  await page
    .waitForFunction(ready, null, { timeout: 15000 })
    .catch(() => problems.push(`${page.url()} never settled`));
  await page.waitForTimeout(300);
}

const diffPage = async (browser) => {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
};

/** Pixel diff of two PNG buffers, computed in the browser. */
function diff(helper, a, b) {
  return helper.evaluate(
    async ([x, y]) => {
      const load = (s) =>
        new Promise((ok, fail) => {
          const i = new window.Image();
          i.onload = () => ok(i);
          i.onerror = fail;
          i.src = `data:image/png;base64,${s}`;
        });
      const [A, B] = await Promise.all([load(x), load(y)]);
      if (A.width !== B.width || A.height !== B.height)
        return { size: `${A.width}x${A.height} vs ${B.width}x${B.height}` };
      const px = (img) => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const [da, db] = [px(A), px(B)];
      let count = 0;
      let max = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(
          Math.abs(da[i] - db[i]),
          Math.abs(da[i + 1] - db[i + 1]),
          Math.abs(da[i + 2] - db[i + 2]),
        );
        // up to 12 levels is the grain overlay's tile phase (fixed on the HTML page, absolute in the component)
        if (d > 12) {
          count += 1;
          if (d > max) max = d;
        }
      }
      return { count, max, total: A.width * A.height };
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

for (const name of BROWSERS) {
  const browser = await playwright[name].launch();
  const helper = await diffPage(browser);
  for (const scenario of [...PARITY, ...ERRORS]) {
    for (const colorScheme of THEMES) {
      for (const width of WIDTHS) {
        const tag = `${name}/${scenario}/${colorScheme}/${width}`;
        const opts = { viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' };
        const [cH, cR] = [await browser.newContext(opts), await browser.newContext(opts)];
        const [pH, pR] = [await cH.newPage(), await cR.newPage()];
        // Engines log some messages for any page under this CSP (WebKit reports style-src-attr when a <select> is
        // created). The React page may only log what the HTML dashboard also logs in the same browser.
        const logs = { html: [], react: [] };
        const keep = (list) => (m) => {
          if (['error', 'warning'].includes(m.type()) && !/Failed to load resource/.test(m.text()))
            list.push(m.text());
        };
        pH.on('console', keep(logs.html));
        pR.on('console', keep(logs.react));
        pR.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
        await pH.goto(`http://127.0.0.1:${html.port}/s/${scenario}/`);
        await pR.goto(`http://127.0.0.1:${react.port}/s/${scenario}/`);
        const settled = () =>
          !document.querySelector('.dy-viz[aria-busy="true"]') &&
          document.querySelectorAll('.dy-panel, .dy-err').length > 0;
        await Promise.all([settle(pH, settled), settle(pR, settled)]);
        const overflow = await pR.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        if (overflow > 0) problems.push(`${tag} react page overflows by ${overflow}px`);
        if (PARITY.includes(scenario)) {
          for (const panel of PANELS) {
            const [a, b] = [pH.locator(`.${panel}`), pR.locator(`.${panel}`)];
            if (!(await a.count()) || !(await b.count())) {
              problems.push(
                `${tag} ${panel} missing (html ${await a.count()}, react ${await b.count()})`,
              );
              continue;
            }
            const [bufA, bufB] = [await a.screenshot(), await b.screenshot()];
            const d = await diff(helper.page, bufA, bufB);
            rows.push(
              `${tag} ${panel}: ${d.size ? `SIZE ${d.size}` : `${d.count}/${d.total} px differ (max ${d.max})`}`,
            );
            // Anti-aliasing slivers on diagonal strokes and a last pixel row may differ by sub-pixel layout: allow 0.5% of the panel.
            if (d.size || d.count / d.total > 0.005)
              problems.push(
                `${tag} ${panel} differs from the HTML dashboard: ${d.size ?? `${d.count} px, max delta ${d.max}`}`,
              );
          }
        } else {
          const stamp = await pR
            .locator('.dy-stamp')
            .first()
            .textContent()
            .catch(() => null);
          rows.push(`${tag} error page: ${stamp}`);
        }
        // The React page may only log what the HTML dashboard also logs in the same browser.
        const fresh = logs.react.filter((m) => !logs.html.includes(m));
        for (const m of fresh) problems.push(`${tag} console message only on the React page: ${m}`);
        shared += logs.react.length - fresh.length;
        if (scenario === 'ok' || (name === 'chromium' && scenario === 'hostile')) {
          await pR.screenshot({
            path: join(out, `react-${name}-${scenario}-${colorScheme}-${width}.png`),
            fullPage: true,
          });
          await pH.screenshot({
            path: join(out, `html-${name}-${scenario}-${colorScheme}-${width}.png`),
            fullPage: true,
          });
          shots += 2;
        }
        await cH.close();
        await cR.close();
      }
    }
  }
  await helper.ctx.close();
  await browser.close();
}
await html.close();
await react.close();
console.log(rows.join('\n'));
console.log(`${shots} screenshots in ${out}`);
console.log(
  `${shared} engine console messages were identical on the HTML dashboard (not counted as problems)`,
);
console.log(
  problems.length
    ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}`
    : 'no console errors, CSP violations, overflow or pixel differences against the HTML dashboard',
);
process.exit(problems.length ? 1 : 0);

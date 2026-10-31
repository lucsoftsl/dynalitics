// Visual check against the mock API with the handler's real CSP. Playwright is NOT a dependency of
// this repo: point PLAYWRIGHT_CORE at any playwright-core install, e.g.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node scripts/screenshots.mjs [outDir]
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startPreview } from './preview-server.mjs';

const core = process.env.PLAYWRIGHT_CORE;
if (!core) throw new Error('set PLAYWRIGHT_CORE to a playwright-core directory');
const { chromium } = await import(join(core, 'index.mjs'));
const out = process.argv[2] ?? '/tmp/dynalitics-shots';
await mkdir(out, { recursive: true });

const WIDTHS = [320, 768, 1024, 1440];
const THEMES = ['light', 'dark'];
const SCENARIOS = (
  process.env.SCENARIOS ??
  'ok,ramp,empty,forbidden,unreachable,timeout,slow,nvr-unavailable,hostile,sparse-fields'
).split(',');

const { port, close } = await startPreview();
const browser = await chromium.launch();
const problems = [];
const shots = [];
const verdicts = [];

for (const scenario of SCENARIOS) {
  for (const colorScheme of THEMES) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      const tag = `${scenario}/${colorScheme}/${width}`;
      page.on('console', (m) => {
        if (['error', 'warning'].includes(m.type()) && !/Failed to load resource/.test(m.text()))
          problems.push(`${tag} console ${m.type()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
      await page.goto(`http://127.0.0.1:${port}/s/${scenario}/`);
      if (scenario === 'slow') await page.waitForTimeout(800);
      else
        await page
          .waitForFunction(
            () =>
              document.querySelector('#dy-grid') &&
              !document.querySelector('.dy-viz[aria-busy="true"]') &&
              document.querySelectorAll('.dy-panel, .dy-err').length > 0,
            null,
            { timeout: 15000 },
          )
          .catch(() => problems.push(`${tag} never settled`));
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 0) problems.push(`${tag} horizontal overflow ${overflow}px`);
      if (scenario === 'ok' || scenario === 'ramp') {
        // DESIGN 7.6.6: either the numeral is stacked, or no line segment enters its grown box.
        const verdict = await page.evaluate(() => {
          const wrap = document.querySelector('.p-hero .dy-hero-wrap');
          const num = document.querySelector('.p-hero .dy-hero-num');
          const line = document.querySelector('.p-hero polyline.line');
          if (!wrap || !num || !line) return 'missing';
          if (wrap.classList.contains('dy-hero--stacked')) return 'stacked';
          const r = num.getBoundingClientRect();
          const m = line.getScreenCTM();
          const pts = line
            .getAttribute('points')
            .trim()
            .split(/\s+/)
            .map((p) => p.split(',').map(Number))
            .map(([x, y]) => ({ x: m.a * x + m.e, y: m.d * y + m.f }));
          const box = { l: r.left - 12, r: r.right + 12, b: r.bottom + 12 };
          for (let i = 1; i < pts.length; i++) {
            const [p0, p1] = pts[i - 1].x <= pts[i].x ? [pts[i - 1], pts[i]] : [pts[i], pts[i - 1]];
            if (p1.x < box.l || p0.x > box.r) continue;
            const at = (x) =>
              p1.x === p0.x
                ? Math.min(p0.y, p1.y)
                : p0.y + ((p1.y - p0.y) * (x - p0.x)) / (p1.x - p0.x);
            if (Math.min(at(Math.max(p0.x, box.l)), at(Math.min(p1.x, box.r))) < box.b)
              return 'COLLISION';
          }
          return 'overlay-clear';
        });
        verdicts.push(`${tag} numeral: ${verdict}`);
        if (verdict === 'COLLISION' || verdict === 'missing')
          problems.push(`${tag} numeral ${verdict}`);
      }
      if (scenario === 'ok') {
        await page.selectOption('.p-hero select', 'plan');
        await page.waitForFunction(
          () => !document.querySelector('.p-hero .dy-viz[aria-busy="true"]'),
        );
        await page.waitForTimeout(200);
        const splitFile = join(out, `split-${colorScheme}-${width}.png`);
        await page.locator('.p-hero').screenshot({ path: splitFile });
        shots.push(splitFile);
        await page.focus('.p-hero .dy-chart');
        await page.keyboard.press('ArrowLeft');
        const focusFile = join(out, `focus-${colorScheme}-${width}.png`);
        await page.locator('.p-hero').screenshot({ path: focusFile });
        shots.push(focusFile);
        await page.selectOption('.p-hero select', '');
      }
      const file = join(out, `${scenario}-${colorScheme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
      await ctx.close();
    }
  }
}
await browser.close();
await close();
console.log(`${shots.length} screenshots in ${out}`);
console.log(verdicts.join('\n'));
console.log(
  problems.length
    ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}`
    : 'no console errors, CSP violations or horizontal overflow',
);

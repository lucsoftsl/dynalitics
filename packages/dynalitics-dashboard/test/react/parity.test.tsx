// @vitest-environment jsdom
// The React dashboard must produce the same DOM as Dan's HTML dashboard for every panel: the same
// CSS then gives the same pixels (docs/DESIGN.md 12.2: "same class names"). Both run against the
// same typed mock API; differences must be listed in ALLOWED below, never silently ignored.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DynaliticsDashboard } from '../../src/react/index.js';
import type { Scenario } from '../fixtures/api.js';
import { mockFetch } from '../fixtures/api.js';
import { mount, settle } from '../ui/harness.js';
import { click, mountReact, qa, settleReact, type Mounted } from './render.js';

/** Attributes whose values are instance ids (differ by design) or DOM properties React does not mirror as attributes. */
const DROP_ATTRS = new Set(['id', 'for', 'aria-labelledby', 'aria-describedby']);

function ser(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return '';
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attributes]
    .filter((a) => !DROP_ATTRS.has(a.name))
    .filter((a) => !(tag === 'option' && a.name === 'selected'))
    .filter((a) => !(tag === 'input' && a.name === 'checked'))
    .map((a) => `${a.name}="${a.value}"`)
    .sort()
    .join(' ');
  return `<${tag}${attrs ? ` ${attrs}` : ''}>${[...node.childNodes].map(ser).join('')}</${tag}>`;
}

const panelsOf = (root: ParentNode): Record<string, string> =>
  Object.fromEntries(
    qa(root, '.dy-panel').map((p) => {
      const key = ['p-hero', 'p-pages', 'p-nvr', 'p-consent', 'p-table'].find((c) =>
        p.classList.contains(c),
      );
      return [key ?? 'unknown', ser(p)];
    }),
  );

const gridOf = (root: ParentNode): string => {
  const g = root.querySelector('#dy-grid, .dy-grid');
  return g ? ser(g) : '';
};

async function htmlSnapshot(scenario: Scenario, range?: string) {
  mount(scenario);
  await settle();
  if (range) {
    (document.querySelector(`#dy-range input[value="${range}"]`) as HTMLInputElement).click();
    await settle();
  }
  const out = { panels: panelsOf(document.body), grid: gridOf(document.body) };
  document.body.innerHTML = '';
  return out;
}

let mounted: Mounted | null = null;
beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

async function reactSnapshot(scenario: Scenario, range?: string) {
  mounted = await mountReact(
    <DynaliticsDashboard endpoint="/s/x" fetch={mockFetch(scenario)} locale="en-GB" />,
  );
  await settleReact();
  if (range) {
    await click(mounted.container.querySelector(`.dy-range input[value="${range}"]`));
    await settleReact();
  }
  const out = { panels: panelsOf(mounted.container), grid: gridOf(mounted.container) };
  await mounted.unmount();
  mounted = null;
  return out;
}

const CASES: readonly (readonly [Scenario, string?])[] = [
  ['ok'],
  ['ok', '90d'],
  ['ok', '24h'],
  ['ramp'],
  ['empty'],
  ['nvr-unavailable'],
  ['nvr-exact'],
  ['sparse-fields'],
  ['no-cursor'],
  ['hostile'],
];

describe('React panels have the same DOM as the HTML dashboard', () => {
  const cases = CASES.map(([scenario, range]) => ({ scenario, range }));
  test.each(cases)('scenario $scenario $range', async ({ scenario, range }) => {
    const html = await htmlSnapshot(scenario, range);
    const react = await reactSnapshot(scenario, range);
    // Guard against comparing two empty things: all five panels exist and carry real markup.
    expect(Object.keys(html.panels).sort()).toEqual([
      'p-consent',
      'p-hero',
      'p-nvr',
      'p-pages',
      'p-table',
    ]);
    for (const key of Object.keys(html.panels))
      expect(html.panels[key]?.length, key).toBeGreaterThan(200);
    expect(Object.keys(react.panels).sort()).toEqual(Object.keys(html.panels).sort());
    for (const key of Object.keys(html.panels))
      expect(react.panels[key], key).toBe(html.panels[key]);
  });

  test.each(['forbidden', 'unreachable', 'html-reply', 'meta-forbidden'] as const)(
    'page-level failure %s renders the same error block',
    async (scenario) => {
      const html = await htmlSnapshot(scenario);
      const react = await reactSnapshot(scenario);
      expect(react.grid).toBe(html.grid);
      expect(react.grid).toContain('dy-err');
    },
  );
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { transformCss } from '../../scripts/react-css.mjs';

const SOURCE = readFileSync(join(import.meta.dirname, '../../src/ui/styles.css'), 'utf8');
const css = transformCss(SOURCE);

describe('the React stylesheet is the HTML stylesheet, scoped to .dy-root', () => {
  test('keeps every component rule untouched', () => {
    for (const rule of [
      '.dy-panel',
      '.dy-hero-wrap',
      '.dy-chart',
      '.dy-table',
      '.dy-legend',
      '.f-cat1',
      '.dy-na-state',
    ])
      expect(SOURCE).toContain(rule);
    // Same rule text apart from the scoped page-level selectors.
    const strip = (s: string): string => s.replace(/\s+/g, ' ');
    expect(strip(css)).toContain(
      strip(SOURCE.slice(SOURCE.indexOf('.dy-defs {'), SOURCE.indexOf('.dy-defs {') + 600)),
    );
  });

  test('nothing leaks into the host page: no :root, html or body selectors', () => {
    expect(css).not.toMatch(/:root/);
    expect(css).not.toMatch(/(^|[\s,{};])(html|body)\s*[{,:]/m);
    expect(css).not.toMatch(/^\*/m);
    expect(css).not.toMatch(/^:focus-visible/m);
  });

  test('tokens live on .dy-root, the dark theme on [data-theme=dark], and the OS preference applies without JavaScript', () => {
    expect(css).toMatch(/^\.dy-root \{[^}]*--bg: #f3eee4/m);
    expect(css).toMatch(/^\.dy-root\[data-theme='dark'\] \{[^}]*--bg: #151410/m);
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*\.dy-root:not\(\[data-theme\]\) \{[^}]*--bg: #151410[^}]*--rule-strong: #7a7360/,
    );
    expect(css).toMatch(/@media \(min-width: 720px\) \{\s*\.dy-root \{/);
  });

  test('the reset, focus ring and grain overlay are scoped and the grain no longer covers the viewport', () => {
    expect(css).toMatch(
      /\.dy-root \*,\s*\.dy-root \*::before,\s*\.dy-root \*::after \{\s*box-sizing: border-box/,
    );
    expect(css).toMatch(/^\.dy-root :focus-visible \{[^}]*outline: 2px solid var\(--focus\)/m);
    const grain = /\.dy-root::before \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(grain).toContain('position: absolute');
    expect(grain).not.toContain('position: fixed');
    expect(css).not.toContain('min-height: 100vh');
    expect(css).toMatch(/forced-colors: active\) \{\s*\.dy-root::before/);
    expect(css).toMatch(/@media print \{\s*\.dy-root::before/);
  });

  test('is plain CSS with a do-not-edit header and no external requests', () => {
    expect(css.startsWith('/* dynalitics-dashboard/react')).toBe(true);
    expect(css).not.toMatch(/@import|url\(\s*['"]?https?:/);
  });

  test('fails loudly when the HTML stylesheet changes shape instead of shipping a leaky file', () => {
    expect(() => transformCss('.dy-panel { color: red; }')).toThrow(/styles\.css/);
    expect(() => transformCss(`${SOURCE}\nbody .x { color: red; }`)).toThrow(/body/);
  });
});

// Derives the React stylesheet from the HTML dashboard's (src/ui/styles.css), so both share every
// component rule. Only the page-level rules differ: the HTML page owns <html>, <body> and :root, a React
// component inside someone else's page must not, so those selectors are scoped under `.dy-root`.
// The script fails (never guesses) if the source stops matching, so the two can never silently drift.

const HEADER =
  '/* dynalitics-dashboard/react styles. Generated from src/ui/styles.css by scripts/build-react.mjs: do not edit. */\n';

function expect(css, name, pattern) {
  if (!pattern.test(css))
    throw new Error(
      `react-css: expected ${name} in src/ui/styles.css but it is gone (the HTML stylesheet changed shape; update scripts/react-css.mjs)`,
    );
}

export function transformCss(source) {
  let css = source;
  const swap = (name, pattern, replacement) => {
    expect(css, name, pattern);
    css = css.replace(pattern, replacement);
  };

  // Tokens: dark theme first (its selector also starts with :root), then every plain :root (also inside @media).
  swap(
    "':root[data-theme=dark]'",
    /^:root\[data-theme='dark'\] \{/m,
    ".dy-root[data-theme='dark'] {",
  );
  swap('`:root {` token blocks', /^(\s*):root \{/gm, '$1.dy-root {');
  // The universal reset only for our subtree.
  swap(
    'the box-sizing reset',
    /^\*,\n\*::before,\n\*::after \{/m,
    '.dy-root,\n.dy-root *,\n.dy-root *::before,\n.dy-root *::after {',
  );
  // `html` only set text-size-adjust: the host page owns it.
  swap('the `html` rule', /^html \{[^}]*\}\n/m, '');
  // `body` becomes the component root: no forced viewport height, own stacking context for the grain.
  swap('the `body` rule', /^body \{([^}]*)\}/m, (_m, decls) => {
    const kept = decls.replace(/\n\s*min-height: 100vh;/, '');
    return `.dy-root {${kept}  isolation: isolate;\n}`;
  });
  // Grain overlay: covers the component, not the viewport.
  swap('the grain overlay', /^body::before \{/m, '.dy-root::before {');
  swap(
    'the grain overlay position',
    /(\.dy-root::before \{[^}]*?)position: fixed;/,
    '$1position: absolute;',
  );
  // forced-colors and print blocks list body::before too.
  css = css.replace(/\bbody::before\b/g, '.dy-root::before');
  swap('the global focus ring', /^:focus-visible \{/m, '.dy-root :focus-visible {');

  // Any bare html/body word in selector position (also `body .x`, `html > body`), comments ignored.
  const leak = /(^|[\s,{};>+~])(html|body)(?=[\s,{:.#[>+~]|$)/m.exec(
    css.replace(/\/\*[\s\S]*?\*\//g, ''),
  );
  if (leak) throw new Error(`react-css: an unscoped ${leak[2]} selector is left in the stylesheet`);
  const rootLeft = /:root/.exec(css);
  if (rootLeft) throw new Error('react-css: a :root selector is left in the stylesheet');

  // Follow the OS without JavaScript when the host does not pin a theme (the data-theme attribute is absent).
  const dark = /^\.dy-root\[data-theme='dark'\] \{([^}]*)\}/m.exec(css);
  if (!dark) throw new Error('react-css: dark theme block missing after the transform');
  css += `\n@media (prefers-color-scheme: dark) {\n  .dy-root:not([data-theme]) {${dark[1]}}\n}\n`;
  return HEADER + css;
}

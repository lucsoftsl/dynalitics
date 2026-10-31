#!/usr/bin/env node
// Verifies the colour tokens of docs/DESIGN.md section 2 (v1.1).
//   node docs/check-design-tokens.mjs          -> prints the tables used in DESIGN.md 2.5, exit 1 on any failure
// Keep TOKENS in sync with DESIGN.md 2.1; CI should run this after any token change.
// Contrast: WCAG 2.x relative luminance. Colour-blind separation: Machado et al. 2009 (severity 1.0) in linear RGB,
// then CIE76 delta E (D65), the same method QA used in QA-REVIEW-1.md F-28.

const TOKENS = {
  light: {
    bg: '#F3EEE4',
    surface: '#FAF7F0',
    surface2: '#E9E2D3',
    ink: '#1A1915',
    ink2: '#4F4B43',
    ruleStrong: '#8C8472',
    accent: '#B03A0A',
    returning: '#2A4A9E',
    granted: '#1D6B57',
    declined: '#566170',
    unknown: '#6F695B',
    danger: '#9E1B1B',
    cat: ['#264573', '#732EB8', '#248F8F', '#6F8F24', '#862D36'],
    catOn: ['bg', 'bg', 'ink', 'ink', 'bg'],
  },
  dark: {
    bg: '#151410',
    surface: '#1D1B16',
    surface2: '#2A2720',
    ink: '#F0EADC',
    ink2: '#B2AB9B',
    ruleStrong: '#7A7360',
    accent: '#FF8A5B',
    returning: '#93AAFF',
    granted: '#55C9A2',
    declined: '#9AA4B2',
    unknown: '#8D8676',
    danger: '#FF7B72',
    cat: ['#96B3DC', '#9770DB', '#3DCFAA', '#E0E085', '#D46752'],
    catOn: ['bg', 'bg', 'bg', 'bg', 'bg'],
  },
};
const MIN_TEXT = 4.5,
  MIN_NONTEXT = 3,
  MIN_CAT_DE = 25;
const HOVER_BAR_MIX = 0.3; // top-pages row bar on hover (DESIGN 6.5)

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (h) => {
  const c = rgb(h).map(lin);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const cr = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mix = (fg, bg, a) =>
  '#' +
  rgb(fg)
    .map((v, i) =>
      Math.round((v * a + rgb(bg)[i] * (1 - a)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

const MAT = {
  prot: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deut: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  trit: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const TYPES = ['norm', 'prot', 'deut', 'trit'];
const sim = (h, t) => {
  const c = rgb(h).map(lin);
  return t === 'norm' ? c : MAT[t].map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
};
const lab = ([r, g, b]) => {
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(X / 0.95047), f(Y), f(Z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const dE = (a, b, t) => {
  const A = lab(sim(a, t)),
    B = lab(sim(b, t));
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};

let failed = 0;
const check = (ok, msg) => {
  if (!ok) {
    failed++;
    console.log('  FAIL', msg);
  }
};
const f2 = (n) => n.toFixed(2);

for (const [name, t] of Object.entries(TOKENS)) {
  console.log(`\n===== ${name.toUpperCase()} =====`);
  console.log('token        on bg   on surface  on surface-2   (text needs 4.5, non-text 3)');
  for (const k of [
    'ink',
    'ink2',
    'accent',
    'returning',
    'granted',
    'declined',
    'unknown',
    'danger',
    'ruleStrong',
  ]) {
    const r = [t.bg, t.surface, t.surface2].map((b) => cr(t[k], b));
    console.log(
      `${k.padEnd(12)} ${f2(r[0]).padStart(6)} ${f2(r[1]).padStart(10)} ${f2(r[2]).padStart(12)}`,
    );
    const nonText = k === 'ruleStrong';
    const need = nonText ? MIN_NONTEXT : MIN_TEXT;
    check(
      r[0] >= need && r[1] >= need,
      `${name} ${k} on bg/surface ${f2(r[0])}/${f2(r[1])} < ${need}`,
    );
    // --c-unknown is never text on surface-2; rule-strong never needs to beat its own hover fill.
    if (!nonText && k !== 'unknown')
      check(r[2] >= need, `${name} ${k} on surface-2 ${f2(r[2])} < ${need}`);
  }
  console.log('\nseries      colour   on bg  on surface  label-on  label ratio');
  t.cat.forEach((c, i) => {
    const on = t.catOn[i] === 'bg' ? t.bg : t.ink;
    const rb = cr(c, t.bg),
      rs = cr(c, t.surface),
      rl = cr(on, c);
    console.log(
      `cat-${i + 1}       ${c}  ${f2(rb).padStart(5)} ${f2(rs).padStart(10)}  ${t.catOn[i].padEnd(8)} ${f2(rl).padStart(6)}`,
    );
    check(rb >= MIN_NONTEXT && rs >= MIN_NONTEXT, `${name} cat-${i + 1} non-text contrast`);
    check(rl >= MIN_TEXT, `${name} cat-${i + 1} label text ${f2(rl)} < 4.5`);
  });
  console.log(
    '\nstacked-series separation, delta E (CIE76) under each vision type; need >= ' +
      MIN_CAT_DE +
      ' everywhere',
  );
  let worst = { v: 1e9, p: '' };
  const perType = Object.fromEntries(TYPES.map((x) => [x, 1e9]));
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++) {
      for (const x of TYPES) {
        const v = dE(t.cat[i], t.cat[j], x);
        perType[x] = Math.min(perType[x], v);
        if (v < worst.v) worst = { v, p: `cat-${i + 1}/cat-${j + 1} (${x})` };
      }
    }
  console.log(
    '  worst per vision type:',
    TYPES.map((x) => `${x} ${perType[x].toFixed(0)}`).join(', '),
    ' | worst pair',
    worst.p,
    worst.v.toFixed(1),
  );
  check(
    worst.v >= MIN_CAT_DE,
    `${name} categorical worst-pair delta E ${worst.v.toFixed(1)} < ${MIN_CAT_DE}`,
  );

  console.log(
    '\nsemantic pairs, min delta E over the four vision types (informational; declined and unknown are also hatched/dotted)',
  );
  for (const [a, b] of [
    ['accent', 'returning'],
    ['accent', 'unknown'],
    ['returning', 'unknown'],
    ['granted', 'accent'],
    ['granted', 'declined'],
  ]) {
    console.log(
      `  ${(a + ' vs ' + b).padEnd(24)}`,
      Math.min(...TYPES.map((x) => dE(t[a], t[b], x))).toFixed(0),
    );
  }

  console.log('\ntop-pages row text over the accent bar (DESIGN 6.5)');
  for (const m of [0.22, HOVER_BAR_MIX, 0.38]) {
    const bar = mix(t.accent, t.bg, m);
    console.log(
      `  bar ${Math.round(m * 100)}%  ink ${f2(cr(t.ink, bar))}  ink-2 ${f2(cr(t.ink2, bar))}`,
    );
    if (m <= HOVER_BAR_MIX) {
      check(cr(t.ink, bar) >= MIN_TEXT, `${name} ink on ${m} bar`);
      check(cr(t.ink2, bar) >= MIN_TEXT, `${name} ink-2 on ${m} bar`);
    }
  }
  console.log(
    `  text on accent fill (bg on accent) ${f2(cr(t.bg, t.accent))}; tooltip (bg on ink) ${f2(cr(t.bg, t.ink))}`,
  );
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);

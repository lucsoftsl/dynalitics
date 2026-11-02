# dynalitics dashboard: visual design and component spec

Status: **v1.1** (2026-10-30). Author: Bella (design). Supersedes v1.0 (same day). v1.1 answers `docs/QA-REVIEW-1.md` (Olivia) and Alex's decisions of the same day.
Audience: Dan (implements the self-contained HTML dashboard first, then the React components from the same design), Olivia (visual and a11y checks).
Companion files: `docs/design-mockup.html` (static, no network, open it in a browser; `#state=`, `#theme=`, `#range=` and `#split=` switches are described in section 13), `docs/SPEC.md` (Tom's API contract, section 10 is what this design is wired to), `docs/check-design-tokens.mjs` (runs the contrast and colour-blind checks behind section 2.5; exit code 1 on any failure).
Rule for readers: if the mockup and this document disagree, this document wins; fix the mockup after.

## Changelog: v1.0 to v1.1 (read this first, Dan)

Dan has already built v1.0 in `packages/dynalitics-dashboard`. Everything that changes in the build is listed here; anything not listed is unchanged. "Dan: do" says the concrete follow-up. IDs are QA finding numbers; "A#" are Alex's decisions.

| #   | Finding  | Sections                | What changed                                                                                                                                                                                                                                                                                                                                                                         | Dan: do                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | F-09, A1 | 6.4, 7.4, 8.3, 11       | New vs returning is clamped to `meta.limits.newVsReturningMaxRangeDays` (31) and says so. Exact copy, label placement and states are now specified (6.4.1). The v1.0 "BAD REQUEST" outcome can no longer happen for this panel.                                                                                                                                                      | Clamping already shipped: keep `windowFor`/`isCapped` and the note copy. **Add** the eyebrow `No. 3 · {WINDOW LABEL}` (`LAST 31 DAYS` when capped, else the range label) and put the window in the table caption, chart `aria-label` and live summary (6.4.1). Unexpected 400 `range_too_large` on this panel: `[Reload page]`, not "Try 7 days". |
| D2  | F-06, A4 | 6.7, 10                 | `userId` is masked by default like every other personal value (`pii.maskUserId`, default true). The User cell second line shows the value exactly as the server sends it; the Username column header now covers both values. A column titled "User ID" appears when only `userId` is mapped. The reveal button unmasks user id too.                                                  | No masking logic in the client (never add any). Mark the Username (or User ID) header with the lock plus hidden "(masked)" text; update fixtures/tests so `userId` looks masked (example shape `u_***42`, the shape is the server's). Reveal copy: 6.7.                                                                                           |
| D3  | A3, F-37 | 6.3, 6.6, 6.7, 8.2      | Denied rows now store only page, time and consent=false (plus host constants). Consent sub-line reworded so it is exactly true under the new storage rule and under read-time new/returning; the table note now lists user id; split-by "No value" is described as "rows without a value for this field", never as "denied consent".                                                 | Change the consent sub-line string (`panels/consent.ts`) and the table note string (6.6, 6.7). Legend text "No value" stays; its explanation is a title/hidden text (6.3).                                                                                                                                                                        |
| D4  | F-28, A5 | 2.1, 2.2, 2.5, 6.3, 7.5 | New categorical palette `--cat-1..5` in both themes (navy, violet, teal, olive, wine / lighter equivalents) verified under normal, protan, deutan and tritan vision (worst-pair delta E 29.9 light, 28.8 dark; v1.0 had 4.5). New `--cat-N-on` tokens. Required non-colour encodings for stacked series: direct labels, legend in stack order, tooltip/table in the same order.      | Replace the 10 `--cat-*` values (light, dark, and the `prefers-color-scheme` copy), add `--cat-N-on` (2.1), build the direct labels with the split-by chart. Swatch classes `dy-sw-cat1..3` need `cat4`/`cat5` too.                                                                                                                               |
| D5  | F-25     | 2.1, 2.2, 2.5, 4.6, 6.5 | Dark `--rule-strong` `#6B6554` to `#7A7360` (control borders were 2.96:1 on `--surface`, now 3.64). Light `--c-accent` `#B53D0C` to `#B03A0A` (accent text on the `--surface-2` hover wash was 4.48:1, now 4.71; found while recomputing, not in QA). Top-pages hover bar 38 % to 30 % and rank/share text switches to `--ink` on hover. All stated ratios corrected; new table 2.5. | Change `--rule-strong` (dark, two places) and `--c-accent` (light) in `styles.css`; in the page-row hover rule use 30 % and set `.dy-rank`/`.dy-share` to `--ink` on `:hover`.                                                                                                                                                                    |
| D6  | F-23     | 6.4, 6.7, 8.6 (new), 11 | Calm `unavailable` state (8.6), the `approximate` caveat gets a visible tag as well as the note, table columns and widgets are driven by `meta.fields` / `meta.widgets` (a column for an unmapped role disappears, no "—"), paging caption when `fields.id` is false.                                                                                                                | `api.ts` already parses `unavailable`: add the visual block 8.6 (no red, no retry, `role="status"`), the `ESTIMATE` tag (6.4), column hiding and the paging caption (6.7).                                                                                                                                                                        |
| D7  | F-24     | 4.4, 7.6                | Hero numeral collision rule rewritten: measure the numeral box and test every line segment under its full width (v1.0 only looked at the first 40 % of points).                                                                                                                                                                                                                      | Replace the 40 %/35 % heuristic with the measured test (7.6); add the 5 totals test vectors.                                                                                                                                                                                                                                                      |
| D8  | F-26     | 9.1                     | `<html lang="en">`: the UI copy is English only. Browser locale still drives number/date formatting.                                                                                                                                                                                                                                                                                 | Nothing: `template.html` already has `lang="en"`. Do not set `lang` from `navigator.language`.                                                                                                                                                                                                                                                    |
| D9  | F-27, A2 | 0, 12.1                 | Size budget restated: **45 KB gzipped** for the whole HTML string (today about 20 KB gzipped, 60 KB raw), raw guard **65 KB**. The v1.0 per-part caps (CSS 11 / JS 28 / markup 6 KB) are dropped.                                                                                                                                                                                    | Add the two size assertions to the build/CI (12.1). No code change.                                                                                                                                                                                                                                                                               |
| D10 | F-42     | 8.3, 10, 12.2           | A redirect or opaque response to an API call is "UNEXPECTED REPLY", not "UNREACHABLE"; a network failure on the first `/api/meta` call gets an extra sentence about expired single sign-on. The served HTML page works with ambient credentials only (documented); the React component gets a `getRequestInit` prop for bearer-token hosts.                                          | Use `redirect: 'manual'` (or check `response.redirected`) and map `opaqueredirect` to UNEXPECTED REPLY; add the sentence (8.3). React prop is phase 2.                                                                                                                                                                                            |
| D11 | F-43     | 6.1, 6.7, 7.7, 9.2      | Theme button has one constant label "Dark theme" and `aria-pressed` (v1.0 flipped the label and the state). `aria-description` "masked" replaced by visually hidden text in the header. Charts get an `aria-describedby` hint and a visible keyboard hint on focus.                                                                                                                  | `dashboard.ts` theme button; column headers; chart host (7.7).                                                                                                                                                                                                                                                                                    |

Not changed on purpose: UTC-only time (F-25-adjacent questions in 12.3), the layout and breakpoints, the type pairing, motion, the state machine, the security rules in section 10 (only extended).

---

## 0. Direction in two sentences, and decisions you need to know

**Direction: "Ledger".** A broadsheet / accountant's-ledger look: warm newsprint (light) or night-press ink (dark), hairline rules instead of cards, oversized serif numerals as the headline of every panel, monospace for every piece of data, and a single vermilion "stamp" colour. Consent **declined** is drawn as hatched "void" ink and missing identity as dotted ink, never as an error red, so absence of data is visible, calm and honest.

Decisions that deviate from, or sharpen, the brief (details in the sections named):

1. **Fonts are system stacks, not self-hosted files.** The handler's CSP (SPEC 10.5) is `default-src 'none'` with no `font-src`, so even a base64 `@font-face` is blocked. Two families, both system-safe (section 3). If the user ever relaxes the CSP, nothing in this design needs to change.
2. **Everything is shown in UTC**, labelled "UTC". The server buckets in UTC only (SPEC 3.4, 10.3); drawing UTC day-buckets with local-time labels would put visits on the wrong day for most users. A local-time toggle needs server support, so it is not in v1 (section 12, open question 1).
3. **"New vs returning" has three states, not two**: new, returning, **unknown** (`is_first_visit` is NULL for every declined visit and for anonymous ones). Dropping the third would hide that, e.g., 20 % of traffic was never classified.
4. **No generic KPI-card strip.** Each panel owns its headline number (hero total, consent rate, new share). This is the main anti-"dashboard-by-numbers" move.
5. **Tooltips and legends are never the only carrier of meaning.** Every chart has a "Table" toggle (real `<table>`), arrow-key exploration, and an `aria-label` summary (section 9).
6. **Resource budget** for the HTML page: **45 KB gzipped** for the whole self-contained string, with a **raw size guard of 110 KB** since v1.2 (the explorer, section 14; it was 65 KB, see D9 and D10). No libraries. (v1.0 said 45 KB uncompressed with per-part caps; the build measured 62 KB raw, the budget was restated, see D9.)

---

## 1. Design principles (each maps to a rule below)

| #   | Principle                                | Consequence                                                                                                                                                      |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Numbers are the headline.**            | Panel headline numerals at 56-104 px serif, labels at 12 px mono. Scale contrast of roughly 8:1 between numeral and label.                                       |
| P2  | **Rules, not boxes.**                    | Panels are separated by hairlines and whitespace. The only "box" is the stacked-sheet effect on the hero and the table (section 4.4). No uniform bordered cards. |
| P3  | **Absence is a first-class state.**      | Declined = hatched, unknown = dotted, not-collected cell = hatched. Never red, never blank.                                                                      |
| P4  | **One accent, used semantically.**       | Vermilion means: "new", "current / in-progress", focus, selected data point. It is never decorative.                                                             |
| P5  | **Tight inside, loose between.**         | Spacing rhythm 8 / 12 inside modules, 48 / 72 between sections (ratio about 1:6).                                                                                |
| P6  | **Every pixel of data has a text twin.** | Table toggle, `aria-label` summaries, live region on keyboard exploration.                                                                                       |

---

## 2. Tokens

All colours were checked with a WCAG 2.x relative-luminance script; ratios are against the theme background `--bg` unless stated.

### 2.1 CSS custom properties (copy as is; HTML dashboard puts this in the nonce'd `<style>`)

```css
:root {
  color-scheme: light;

  /* surfaces + ink */
  --bg: #f3eee4; /* newsprint */
  --surface: #faf7f0; /* panel "sheet" */
  --surface-2: #e9e2d3; /* hover wash, skeleton, hatch ground */
  --ink: #1a1915; /* 15.2:1 */
  --ink-2: #4f4b43; /* secondary text, 7.5:1 */
  --rule: #cbc2af; /* decorative hairlines only (1.5:1, never carries meaning alone) */
  --rule-strong: #8c8472; /* axis baselines, control borders: 3.2:1 on bg, 3.5:1 on surface */

  /* semantic data colours */
  --c-accent: #b03a0a; /* vermilion stamp, 5.3:1 on bg, 4.7:1 on surface-2 */
  --c-new: var(--c-accent);
  --c-returning: #2a4a9e; /* 7.1:1 */
  --c-granted: #1d6b57; /* 5.5:1 */
  --c-declined: #566170; /* slate, drawn hatched, 5.4:1 */
  --c-unknown: #6f695b; /* drawn dotted, 4.7:1 */
  --c-danger: #9e1b1b; /* errors only, 6.9:1 */

  /* categorical series for "split by" (max 5 + other + none).
     Verified under normal, protan, deutan and tritan vision (2.5). Series order is fixed, never reorder. */
  --cat-1: #264573; /* navy */
  --cat-2: #732eb8; /* violet */
  --cat-3: #248f8f; /* teal */
  --cat-4: #6f8f24; /* olive */
  --cat-5: #862d36; /* wine */
  /* text colour for the direct label drawn on each series fill, all >= 4.5:1 (2.5) */
  --cat-1-on: var(--bg);
  --cat-2-on: var(--bg);
  --cat-3-on: var(--ink);
  --cat-4-on: var(--ink);
  --cat-5-on: var(--bg);

  /* derived roles */
  --focus: var(--c-accent);
  --tip-bg: var(--ink);
  --tip-fg: var(--bg);
  --area-opacity: 0.14;
  --grain-opacity: 0.06;
  --sheet: 0 1px 0 var(--rule), 0 7px 0 -3px var(--surface-2), 0 8px 0 -3px var(--rule);

  /* type */
  --font-serif:
    'Iowan Old Style', 'Palatino Linotype', Palatino, 'URW Palladio L', P052, 'Book Antiqua', serif;
  --font-mono:
    ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, 'DejaVu Sans Mono',
    monospace;
  --fs-hero: clamp(3.75rem, 2.2rem + 6.4vw, 6.5rem); /* 60 -> 104 px */
  --fs-kpi: clamp(2.5rem, 1.9rem + 2.4vw, 3.75rem); /* 40 -> 60 px */
  --fs-h2: 1.25rem; /* panel title, serif italic */
  --fs-body: 1rem; /* serif, messages */
  --fs-data: 0.8125rem; /* mono, table + lists, 13 px */
  --fs-label: 0.75rem; /* mono caps, 12 px, the floor: nothing smaller anywhere */
  --lh-tight: 1;
  --lh-body: 1.5;
  --lh-data: 1.35;
  --track-label: 0.08em;

  /* space: 4px base */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 24px;
  --s-6: 32px;
  --s-7: 48px;
  --s-8: 72px;
  --gutter: var(--s-4); /* 16 at 320; 24 at >=720; 32 at >=1024 (see 5.1) */
  --page-pad: var(--s-4);

  /* radius (deliberately uneven: square data, soft chips) */
  --r-0: 0; /* panels, charts, table, bars */
  --r-1: 2px; /* inputs, buttons, tooltip */
  --r-pill: 999px; /* consent chip only */

  /* motion */
  --dur-fast: 120ms;
  --dur-base: 240ms;
  --dur-slow: 640ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);

  /* layers */
  --z-tip: 20;
  --z-skip: 30;
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #151410;
  --surface: #1d1b16;
  --surface-2: #2a2720;
  --ink: #f0eadc; /* 15.4:1 */
  --ink-2: #b2ab9b; /* 8.1:1 */
  --rule: #3a362c;
  --rule-strong: #7a7360; /* 3.9:1 on bg, 3.6:1 on surface */
  --c-accent: #ff8a5b; /* 7.9:1 */
  --c-returning: #93aaff; /* 8.3:1 */
  --c-granted: #55c9a2; /* 9.0:1 */
  --c-declined: #9aa4b2; /* 7.3:1 */
  --c-unknown: #8d8676; /* 5.1:1 */
  --c-danger: #ff7b72; /* 7.3:1 */
  --cat-1: #96b3dc;
  --cat-2: #9770db;
  --cat-3: #3dcfaa;
  --cat-4: #e0e085;
  --cat-5: #d46752;
  --cat-1-on: var(--bg);
  --cat-2-on: var(--bg);
  --cat-3-on: var(--bg);
  --cat-4-on: var(--bg);
  --cat-5-on: var(--bg);
  --area-opacity: 0.18;
  --grain-opacity: 0.05;
}

/* no stored choice -> follow the OS. Repeat the dark block here (the build should template it once). It must include the v1.1 values of --rule-strong, --cat-1..5 and --cat-N-on. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    /* same declarations as :root[data-theme="dark"] */
  }
}
```

Theme switch: a masthead button (section 6.1). `<head>` runs a 3-line inline script (nonce'd) **before first paint** that sets `data-theme` from `localStorage['dynalitics-theme']` (`'light' | 'dark'`, in a `try/catch`; absent = follow OS). That avoids a flash. React: same logic in a `useTheme` hook plus the same head script is not available, so apply on mount and accept one frame of default theme.

### 2.2 Token reference (what each is for)

| Token                    | Light                           | Dark                                             | Use                                                                                            | Never use for                                                                                                 |
| ------------------------ | ------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--bg`                   | `#F3EEE4`                       | `#151410`                                        | page background                                                                                | panels                                                                                                        |
| `--surface`              | `#FAF7F0`                       | `#1D1B16`                                        | hero + table "sheet", tooltip-free panels sit on `--bg`                                        | text colour                                                                                                   |
| `--surface-2`            | `#E9E2D3`                       | `#2A2720`                                        | hover wash, skeleton blocks (v1.1: skeletons use `--rule`), hatch ground                       | text background for `--c-unknown` (4.2 / 4.1:1); `--rule-strong` borders do not need to beat it (2.9 / 3.2:1) |
| `--ink` / `--ink-2`      | `#1A1915` / `#4F4B43`           | `#F0EADC` / `#B2AB9B`                            | primary / secondary text, hero line, selected control fill                                     |                                                                                                               |
| `--rule`                 | `#CBC2AF`                       | `#3A362C`                                        | row separators, gridlines (decorative)                                                         | the only indicator of anything (fails 3:1)                                                                    |
| `--rule-strong`          | `#8C8472`                       | `#7A7360` (v1.0 `#6B6554`)                       | axis baseline, button/segment borders, input borders (>= 3:1 on `--bg` and `--surface`, 2.5)   | body text                                                                                                     |
| `--c-accent` / `--c-new` | `#B03A0A` (v1.0 `#B53D0C`)      | `#FF8A5B`                                        | "new" series, focus ring, last point, selected tick, "revealed PII" bar                        | decoration                                                                                                    |
| `--c-returning`          | `#2A4A9E`                       | `#93AAFF`                                        | "returning" series                                                                             |                                                                                                               |
| `--c-granted`            | `#1D6B57`                       | `#55C9A2`                                        | consent granted (solid)                                                                        |                                                                                                               |
| `--c-declined`           | `#566170`                       | `#9AA4B2`                                        | consent declined (**hatched**, diagonal)                                                       | errors                                                                                                        |
| `--c-unknown`            | `#6F695B`                       | `#8D8676`                                        | unknown identity / "no value" (**dotted**)                                                     | text on `--surface-2`                                                                                         |
| `--c-danger`             | `#9E1B1B`                       | `#FF7B72`                                        | error stamps and error text                                                                    | declined consent (that is not a failure)                                                                      |
| `--cat-1..5`             | navy, violet, teal, olive, wine | steel blue, violet, mint, pale olive, terracotta | "split by" custom-field series (>= 3.2:1 light, >= 4.6:1 dark; colour-blind separation in 2.5) | consent / new / returning (those have fixed semantic colours); text (use `--cat-N-on` for labels)             |

Text on filled accent: use `--bg` (5.26:1 light, 7.93:1 dark). **Never** `--ink` on accent (2.89 light / 1.94 dark, fails).

Contrast of data marks follows WCAG 1.4.11 (>= 3:1 against adjacent colour). All series colours exceed it on `--bg` and `--surface` (2.5). Adjacent stacked series are additionally separated by a 1.5 px gap in `--surface`/`--bg` colour. The semantic states granted / declined / unknown are distinguished by **pattern** (solid / diagonal hatch / dot) and by text labels, and categorical series (split by) by **direct labels, stack-ordered legend and tooltip order** (6.3); colour is never the only carrier. v1.1 changed the palette because v1.0's vermilion and ochre series were nearly identical under deuteranopia (delta E 4.5), contrary to what v1.0 claimed.

### 2.5 Verified contrast and colour-blind separation (v1.1)

Generated by `node docs/check-design-tokens.mjs` (exit 1 on any failure; run it in CI after any token change). Ratios are WCAG 2.x. Text needs 4.5:1, non-text marks and control borders 3:1. Colour-blind separation is CIE76 delta E after Machado 2009 simulation (severity 1.0), the same method as QA-REVIEW-1 F-28; the check requires **>= 25** between every pair of the five categorical series under normal, protan, deutan and tritan vision (below about 15 two area fills are hard to tell apart).

| Token (light)   | on `--bg` | on `--surface` | on `--surface-2` | Token (dark)    | on `--bg` | on `--surface` | on `--surface-2` |
| --------------- | --------- | -------------- | ---------------- | --------------- | --------- | -------------- | ---------------- |
| `--ink`         | 15.21     | 16.44          | 13.64            | `--ink`         | 15.37     | 14.34          | 12.42            |
| `--ink-2`       | 7.50      | 8.11           | 6.73             | `--ink-2`       | 8.07      | 7.53           | 6.52             |
| `--c-accent`    | 5.26      | 5.68           | 4.71             | `--c-accent`    | 7.93      | 7.40           | 6.41             |
| `--c-returning` | 7.06      | 7.63           | 6.33             | `--c-returning` | 8.28      | 7.73           | 6.69             |
| `--c-granted`   | 5.52      | 5.96           | 4.95             | `--c-granted`   | 9.01      | 8.41           | 7.28             |
| `--c-declined`  | 5.44      | 5.88           | 4.88             | `--c-declined`  | 7.31      | 6.82           | 5.91             |
| `--c-unknown`   | 4.72      | 5.10           | 4.23 (no text)   | `--c-unknown`   | 5.09      | 4.76           | 4.12 (no text)   |
| `--c-danger`    | 6.91      | 7.47           | 6.20             | `--c-danger`    | 7.31      | 6.82           | 5.91             |
| `--rule-strong` | 3.21      | 3.47           | 2.88 (n/a)       | `--rule-strong` | 3.90      | 3.64           | 3.16 (n/a)       |

`--rule-strong` is a control border: it must reach 3:1 against the surfaces the control sits on (`--bg`, `--surface`), not against its own hover fill. v1.0's dark value failed that on `--surface` (2.96, the hero and table sheets). Tooltip (`--tip-fg` on `--tip-bg`): 15.21 light, 15.37 dark. Text on a filled accent chip (`--bg` on `--c-accent`): 5.26 light, 7.93 dark.

| Series | Light fill | on `--bg` / `--surface` | label text | label ratio | Dark fill | on `--bg` / `--surface` | label text | label ratio |
| ------ | ---------- | ----------------------- | ---------- | ----------- | --------- | ----------------------- | ---------- | ----------- |
| cat-1  | `#264573`  | 8.33 / 9.00             | `--bg`     | 8.33        | `#96B3DC` | 8.58 / 8.01             | `--bg`     | 8.58        |
| cat-2  | `#732EB8`  | 6.46 / 6.98             | `--bg`     | 6.46        | `#9770DB` | 4.96 / 4.63             | `--bg`     | 4.96        |
| cat-3  | `#248F8F`  | 3.36 / 3.63             | `--ink`    | 4.52        | `#3DCFAA` | 9.39 / 8.77             | `--bg`     | 9.39        |
| cat-4  | `#6F8F24`  | 3.23 / 3.49             | `--ink`    | 4.72        | `#E0E085` | 13.31 / 12.43           | `--bg`     | 13.31       |
| cat-5  | `#862D36`  | 7.44 / 8.04             | `--bg`     | 7.44        | `#D46752` | 5.14 / 4.80             | `--bg`     | 5.14        |

Colour-blind separation of the five categorical series (minimum over all pairs, delta E):

| Theme                 | normal | protanopia | deuteranopia | tritanopia | worst single pair                                         |
| --------------------- | ------ | ---------- | ------------ | ---------- | --------------------------------------------------------- |
| light v1.1            | 47     | 32         | 30           | 31         | cat-1/cat-2 under deuteranopia, 29.9                      |
| dark v1.1             | 49     | 29         | 29           | 29         | cat-1/cat-3 under deuteranopia, 28.8                      |
| light v1.0 (replaced) | n/a    | n/a        | n/a          | n/a        | cat-2 vermilion / cat-4 ochre under deuteranopia, **4.5** |

Semantic pairs, minimum delta E over the four vision types (light / dark): new vs returning 91 / 82; returning vs unknown 40 / 34; new vs unknown 36 / 29; granted vs new 36 / 26; **granted vs declined 13 / 16**. The last pair is low under red-green blindness on purpose-tolerated grounds: declined is always drawn **hatched** and always carries the word "Declined", so colour is not what separates them.

Top-pages row text over the accent bar (6.5), at 22 % / 30 % / 38 % bar mix: `--ink` 10.92 / 9.65 / 8.49 light, 10.37 / 8.66 / 7.13 dark; `--ink-2` 5.39 / 4.76 / **4.19** light, 5.44 / 4.55 / **3.74** dark. The 38 % hover of v1.0 failed for `--ink-2`; v1.1 caps the hover at 30 % **and** switches rank and share text to `--ink` on hover.

Focus ring (`--focus` = `--c-accent`, 2 px): 5.26 / 5.68 on `--bg` / `--surface` in light, 7.93 / 7.40 in dark. (v1.0 said the ratio on `--surface` is "higher still"; in dark it is slightly lower, still passing.)

### 2.3 Patterns (SVG `<defs>`, once per document, hidden but not `display:none`)

Put one `<svg width="0" height="0" aria-hidden="true" focusable="false" class="dy-defs">` at the top of `<body>`. Style the strokes with **classes**, not `var()` in attributes (older Safari ignores `var()` in presentation attributes).

```html
<svg width="0" height="0" aria-hidden="true" focusable="false" class="dy-defs">
  <defs>
    <pattern
      id="dy-hatch"
      width="6"
      height="6"
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(45)"
    >
      <rect width="6" height="6" class="dy-pat-ground" />
      <line x1="0" y1="0" x2="0" y2="6" stroke-width="2" class="dy-hatch-line" />
    </pattern>
    <pattern id="dy-dots" width="5" height="5" patternUnits="userSpaceOnUse">
      <rect width="5" height="5" class="dy-pat-ground" />
      <circle cx="2.5" cy="2.5" r="1.1" class="dy-dot" />
    </pattern>
    <pattern
      id="dy-hatch-other"
      width="6"
      height="6"
      patternUnits="userSpaceOnUse"
      patternTransform="rotate(-45)"
    >
      <rect width="6" height="6" class="dy-pat-ground" />
      <line x1="0" y1="0" x2="0" y2="6" stroke-width="2" class="dy-other-line" />
    </pattern>
  </defs>
</svg>
```

```css
.dy-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}
.dy-pat-ground {
  fill: var(--surface-2);
}
.dy-hatch-line {
  stroke: var(--c-declined);
}
.dy-dot {
  fill: var(--c-unknown);
}
.dy-other-line {
  stroke: var(--ink-2);
}
```

HTML swatches (legend chips, table cells) use CSS equivalents:

```css
.dy-sw-granted {
  background: var(--c-granted);
}
.dy-sw-declined {
  background: repeating-linear-gradient(135deg, var(--c-declined) 0 2px, var(--surface-2) 2px 5px);
}
.dy-sw-unknown {
  background:
    radial-gradient(var(--c-unknown) 1.1px, transparent 1.3px) 0 0 / 5px 5px,
    var(--surface-2);
}
.dy-sw-new {
  background: var(--c-new);
}
.dy-sw-returning {
  background: var(--c-returning);
}
```

Swatch size: 12 x 12 px, `--r-0`, 1 px `--rule-strong` outline (so the light ones stay visible).

### 2.4 Paper grain

`body::before`, `position: fixed; inset: 0; pointer-events: none; opacity: var(--grain-opacity); z-index: 0;` with a data-URI SVG `feTurbulence` (`baseFrequency .8`, 160 x 160 tile, under 500 bytes). Allowed by CSP (`img-src data:`). Hide it under `@media (forced-colors: active), print, (prefers-reduced-transparency: reduce)`. Content sits at `position: relative; z-index: 1`.

---

## 3. Typography

Two families, both system, no network. **Serif for voice and numerals, mono for data.**

| Role       | Family | Size         | Weight | Style / settings                                                                          | Used for                                                   |
| ---------- | ------ | ------------ | ------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `hero-num` | serif  | `--fs-hero`  | 400    | `font-variant-numeric: lining-nums tabular-nums; line-height: 1; letter-spacing: -0.03em` | the visits total (once per page)                           |
| `kpi-num`  | serif  | `--fs-kpi`   | 400    | same                                                                                      | consent %, new %                                           |
| `wordmark` | serif  | 1.5rem       | 700    | italic, `letter-spacing: -0.01em`                                                         | "dynalitics" in masthead                                   |
| `h2`       | serif  | `--fs-h2`    | 600    | italic                                                                                    | panel titles                                               |
| `body`     | serif  | `--fs-body`  | 400    | `line-height: 1.5`                                                                        | empty/error messages, notes                                |
| `label`    | mono   | `--fs-label` | 500    | `text-transform: uppercase; letter-spacing: var(--track-label)`                           | eyebrows, axis titles, column headers, buttons             |
| `data`     | mono   | `--fs-data`  | 400    | `font-variant-numeric: tabular-nums; line-height: 1.35`                                   | table cells, list rows, axis ticks (ticks 12 px), tooltips |

Rules:

- Lining, tabular numerals are required for the big numbers; the stack deliberately has **no Georgia** (its numerals are old-style and would jump). Palatino / Iowan / Palatino Linotype / generic `serif` all have lining defaults.
- Nothing below 12 px, anywhere (labels, ticks, tooltips).
- Never `font-weight` above 700; mono uses 400/500 only.
- `h1` is the visually small wordmark ("dynalitics"); the hero number is **not** a heading, it is `<p class="dy-hero-num">` inside the panel labelled by the panel's `h2`.
- All visitor strings (page, username, email) use mono + `overflow-wrap: anywhere; unicode-bidi: isolate;` (section 10).

---

## 4. Spacing, radius, depth, motion

### 4.1 Spacing rhythm

| Context                    | Gap                                              |
| -------------------------- | ------------------------------------------------ |
| eyebrow label to numeral   | `--s-2` (8)                                      |
| numeral to chart           | `--s-3` (12)                                     |
| panel title row to content | `--s-4` (16)                                     |
| between panels in the grid | `--gutter` (16 / 24 / 32)                        |
| between grid **rows**      | `--s-7` (48) at >= 720, `--s-6` (32) below       |
| masthead to first row      | `--s-7` (48)                                     |
| last row to footer         | `--s-8` (72)                                     |
| table row padding          | 10 px block, 12 px inline (min row height 52 px) |

### 4.2 Radius

Data is square (`--r-0`): panels, charts, bars, table, swatches. Controls get `--r-1` (2 px). The consent chip is a pill (`--r-pill`). This unevenness is intentional: only "stamps" are round.

### 4.3 Masthead double rule

Under the masthead: a 3 px `--ink` rule, 3 px gap, then a 1 px `--ink` rule (newspaper nameplate). Implement as `border-bottom: 1px solid var(--ink)` plus a `::after` 3 px block; no images.

### 4.4 Depth and layering (three, all static)

1. **Stacked sheets**: the hero panel and the recent-visits table wrap use `background: var(--surface); box-shadow: var(--sheet); padding: var(--s-5)`. Other panels sit directly on `--bg` with a 2 px `--ink` top rule (a "column head").
2. **Numeral over chart**: in the hero panel, the 104 px total sits **on top of** the chart's upper-left area (absolute, `pointer-events: none`). If the numeral would meet the line it moves above the chart instead; the test is measured, not a fixed percentage (7.6).
3. **Tooltip** is an inverted chip (`--tip-bg` / `--tip-fg`) with a 2 px square nub, the only element using `z-index`.

### 4.5 Motion

All motion is `transform`, `opacity`, `clip-path`. No layout properties. Durations: `--dur-fast` 120 ms (hover), `--dur-base` 240 ms (state changes), `--dur-slow` 640 ms (first reveal).

| What                     | How                                                                                                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First chart reveal       | wrapper `clip-path: inset(0 100% 0 0)` -> `inset(0 0 0 0)`, 640 ms `--ease-out` (line + area together, works on the `<svg>` root)                                                                                                      |
| Columns grow in          | each `<rect>` `transform: scaleY(0)` -> `1`, `transform-origin: bottom`, `transform-box: fill-box`, 400 ms, stagger `calc(var(--i) * 12ms)` capped at 360 ms total (`--i` set with `el.style.setProperty('--i', n)`, which CSP allows) |
| Range-selector indicator | the selected-segment pill slides with `transform: translateX(calc(var(--i) * 100%))`, 240 ms                                                                                                                                           |
| Table row hover          | accent bar `::before { transform: scaleY(0) -> 1 }` 120 ms; background wash is instant (no transition on `background`)                                                                                                                 |
| Refreshing               | old data stays at `opacity: .5` (120 ms) plus a 2 px top progress bar `transform: scaleX(0) -> .85` over 8 s `linear`, then holds until done (opacity only for completion fade)                                                        |
| Skeleton                 | `opacity` pulse `.55 <-> 1`, 1.2 s, alternate                                                                                                                                                                                          |
| Tooltip                  | `opacity` 0 -> 1, 120 ms; its position is set via `transform: translate(x, y)` (never `left/top`)                                                                                                                                      |

`@media (prefers-reduced-motion: reduce)`: remove every `transition` and `animation`, show final states immediately; the skeleton does **not** pulse (static `.8` opacity); the progress bar is a static 2 px bar at `opacity: .5`; tooltips and crosshair appear instantly. Do not gate anything meaningful behind motion.

### 4.6 Interaction states (every control)

| Control                                       | Default                                                           | Hover                                                                                                             | Active            | Focus-visible                                                  | Disabled                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Button (`dy-btn`)                             | transparent, 1 px `--rule-strong` border, label caps, min 44 x 44 | `--surface-2` fill                                                                                                | `translateY(1px)` | 2 px `--focus` outline, 3 px offset                            | `opacity .45`, `cursor: not-allowed`, still focusable only if `aria-disabled` (prefer real `disabled`) |
| Range segment                                 | label caps, transparent                                           | `--surface-2`                                                                                                     | `translateY(1px)` | outline on the **group item**, 3 px offset                     | n/a                                                                                                    |
| Range segment selected                        | `--ink` fill, `--bg` text, via the sliding pill                   | pill unchanged                                                                                                    |                   |                                                                |                                                                                                        |
| Chart (focusable)                             | none                                                              | crosshair + tooltip follow pointer                                                                                |                   | 2 px `--focus` outline around plot, crosshair at current point |                                                                                                        |
| Top-page row                                  | bar `--c-new` at 22 % mix (see 6.5)                               | bar to 30 % (v1.0: 38 %); rank and share text become `--ink`; path gets `text-decoration: underline 1px` offset 3 |                   | row is not focusable (no action)                               |                                                                                                        |
| Table row                                     | no fill                                                           | `--surface-2` fill + 3 px accent bar on the left                                                                  |                   | rows are not focusable                                         |                                                                                                        |
| Link-like text buttons ("Load more", "Retry") | caps label + underline 2 px `--ink`                               | underline becomes `--c-accent`                                                                                    | `translateY(1px)` | outline                                                        | `aria-busy` shows "Loading..."                                                                         |

Focus ring spec (WCAG 2.4.7, 2.4.11, 2.4.13): `outline: 2px solid var(--focus); outline-offset: 3px;` (5.3:1 light, 7.9:1 dark against `--bg`; on `--surface` 5.7 and 7.4, see 2.5). Never `outline: none` without a replacement. No sticky or fixed UI overlaps a focused element (the masthead is not sticky).

---

## 5. Layout

### 5.1 Grid and breakpoints

Mobile-first. Container `max-width: 1280px; margin-inline: auto; padding-inline: var(--page-pad)`.

| Breakpoint (min-width) | Test viewport | `--page-pad` / `--gutter` | Grid                                 |
| ---------------------- | ------------- | ------------------------- | ------------------------------------ |
| base                   | 320           | 16 / 16                   | 1 column                             |
| 720                    | 768           | 24 / 24                   | 2 columns for the middle row         |
| 1024                   | 1024          | 32 / 32                   | 12 columns                           |
| 1280                   | 1440          | 40 / 32                   | 12 columns, container capped at 1280 |

DOM order (also reading order and tab order, identical at every breakpoint): masthead, hero (visits over time), top pages, new vs returning, consent, recent visits, footer.

Zero horizontal overflow at every width: `min-width: 0` on all grid children; `overflow-wrap: anywhere` on visitor strings; charts size to container width (7.1); the table collapses to stacked rows below 1024 (6.7). Verify at 320, 375, 768, 1024, 1440, 1920.

### 5.2 Wireframes

Legend: `[]` control, `###` hero numeral, `~~~` line chart, `|||` columns, `===` ranked bar, `/// ` hatch.

**1440 (container 1280, 12 cols, gap 32)**

```
+--------------------------------------------------------------------------------------------+
| dynalitics (wordmark)                [24h|7d|30d|90d]      Updated 12:05 UTC [Refresh] [Theme]|
|============================================================================================|
|                                                                                            |
|  VISITS  ·  7 DAYS                                 | TOP PAGES                 [Top 10 v]    |
|  ###  801  (104px, overlaps chart)                 | 1  /pricing        310 ====== 39%      |
|  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ (340 px tall)    | 2  /               280 =====  35%      |
|  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~                  | 3  /docs/start      96 ==      12%     |
|  Oct 24   25    26    27    28    29    30        | ...                                    |
|  Split by [None v]            [Chart|Table]        | Other pages  211  /////// 26%          |
|  <------------- cols 1-8 ---------------->         | <---------- cols 9-12 --------->       |
|                                                                                            |
|  NEW VS RETURNING                                  | CONSENT                                |
|  34%  new  (of 412 identified)  [kpi 60px]         | 82.5%  granted   [kpi 60px]            |
|  [====new====|======returning======|//unknown//]   | [=====granted=====|/// declined ///] |
|  ||||||||||||||| stacked columns ||||||||||||||    | ||||| 100% columns |||||               |
|  <------------- cols 1-7 ---------------->         | <---------- cols 8-12 --------->       |
|                                                                                            |
|  RECENT VISITS                       [Show full values]   (sheet)                          |
|  TIME(UTC)  PAGE            CONSENT   FIRST  IP          EMAIL            USERNAME         |
|  12:01:44   /pricing        ● Granted  No    203.0.x.x   j***@example.com j*** · u_42      |
|  12:01:02   /               ◪ Declined —     not collected                                  |
|  ... 25 rows                                               [Load 25 more]                  |
+--------------------------------------------------------------------------------------------+
```

**1024 (container 960, 12 cols, gap 32)**

```
+--------------------------------------------------------------+
| dynalitics        [24h|7d|30d|90d]   Updated 12:05 [R] [Th]  |
|==============================================================|
| VISITS · 7 DAYS                                               |
| ###  801                                                      |
| ~~~~~~~~~~~~~~~~~~~~~~~~ (300 px)       [Chart|Table]         |
| <------------------- cols 1-12 ------------------->           |
|                                                               |
| TOP PAGES (cols 1-6)         | NEW VS RETURNING (cols 7-12)   |
| 1 /pricing  310 ====== 39%   | 34% new                        |
| 2 /         280 =====  35%   | [split bar]                    |
| ...                          | |||| columns ||||              |
|                                                               |
| CONSENT (cols 1-12, horizontal: kpi + bar left, columns right)|
| 82.5% granted  [bar]         | ||||||| 100% columns |||||||    |
|                                                               |
| RECENT VISITS (cols 1-12, full 7-column table, sheet)         |
+--------------------------------------------------------------+
```

**768 (container 720, 2 cols, gap 24)**

```
+--------------------------------------------+
| dynalitics                    [Theme]      |
| [   24h |  7d  |  30d  |  90d   ]  (full)  |
| Updated 12:05 UTC            [Refresh]     |
|============================================|
| VISITS · 7 DAYS                            |
| ###  801                                   |
| ~~~~~~~~~~~~~~~~~~~~~~ (260 px)            |
| [Chart|Table]                              |
|                                            |
| TOP PAGES (full width)                     |
| 1 /pricing   310 ====== 39%                |
| ...                                        |
|                                            |
| NEW VS RETURNING    | CONSENT              |
| 34% new             | 82.5% granted        |
| [split bar]         | [split bar]          |
| |||| columns ||||   | |||| columns ||||    |
|                                            |
| RECENT VISITS (rows as 2-line grid, 6.7)   |
|  12:01:44  /pricing        ● Granted  No   |
|  203.0.x.x · j***@example.com · j*** u_42  |
+--------------------------------------------+
```

**320 (single column, pad 16, 288 px content)**

```
+--------------------------+
| dynalitics        [Theme]|
| [24h|7d |30d|90d]       |  (4 equal segments, 44 px tall)
| Updated 12:05 [Refresh]  |
|==========================|
| VISITS · 7 DAYS          |
| ### 801  (60 px)         |  numeral sits ABOVE the chart here
| ~~~~~~~~~~~~ (220 px)    |
| [Chart|Table]            |
| Split by [None v]        |
|                          |
| TOP PAGES   [Top 10 v]   |
| 1 /pricing               |
|   310 =====  39%         |  rows are 2 lines: path, then count + bar
| ...                      |
|                          |
| NEW VS RETURNING         |
| 34% new                  |
| [split bar]              |
| |||| columns (180) ||||  |
|                          |
| CONSENT                  |
| 82.5% granted            |
| [split bar]              |
| |||| columns (180) ||||  |
|                          |
| RECENT VISITS            |
| 12:01:44 · 30 Oct        |
| /pricing                 |
| ● Granted · First: No    |
| IP 203.0.x.x             |
| Email j***@example.com   |
| User j*** · u_42         |
| ------------------------ |
| [Load 25 more]           |
+--------------------------+
```

Chart heights: hero 220 (320) / 260 (768) / 300 (1024) / 340 (1440). Column charts: 180 / 200 / 200 / 220. Plot margins inside every SVG: top 8, right 8, bottom 28, left 40 (y labels right-aligned to x = 32).

---

## 6. Components

DOM uses semantic elements. Class prefix `dy-`. Anything in `[]` is a state or modifier class. Everything shown here applies to both the HTML build and React (React: one component per section, same markup and classes, `useId` for ids, no `dangerouslySetInnerHTML`).

### 6.1 Masthead (`<header class="dy-mast">`)

Contents left to right: wordmark `<h1 class="dy-wordmark">dynalitics</h1>` (italic serif, with a 10 x 10 vermilion square before it, decorative); range selector; "Updated 12:05:00 UTC" (`<time>`, mono 12 px, `--ink-2`); `[Refresh]` button; `[Theme]` toggle button: **one constant visible label "Dark theme"** with `aria-pressed="true"` while the dark theme is on (v1.0 flipped the label between "Dark" and "Light" as well as the state, which reads as a contradiction); a half-filled square glyph, not a sun icon.

- **Range selector** (`role="radiogroup" aria-label="Date range"`, four `<button role="radio" aria-checked>` or real radio inputs styled; prefer real `<input type="radio">` in a `<fieldset>` with visually-hidden legend): `24h`, `7d`, `30d`, `90d`. Default **7d** (matches `meta.defaults.rangeDays`). Equal-width segments (min 56 px, 44 px tall), 1 px `--rule-strong` border, the selected state is the sliding `--ink` pill with `--bg` text. Arrow keys move and select (radiogroup semantics). Range is mirrored in the URL hash `#range=7d` (shareable; hash so the server never sees it).
- At < 720: the selector moves to its own full-width row below the wordmark row; "Updated ..." and Refresh share the next row.
- Masthead is not sticky.

### 6.2 Panel anatomy (shared)

```html
<section class="dy-panel" aria-labelledby="h-consent">
  <header class="dy-panel-head">
    <p class="dy-eyebrow">No. 4</p>
    <!-- mono label, --ink-2 -->
    <h2 id="h-consent" class="dy-h2">Consent</h2>
    <!-- serif italic -->
    <div class="dy-panel-tools">...</div>
    <!-- Chart|Table toggle, selects -->
  </header>
  <p class="dy-kpi-num">...</p>
  <!-- headline number -->
  <p class="dy-kpi-sub">...</p>
  <!-- one honest sentence -->
  <div class="dy-viz">
    <!-- aria-busy while loading -->
    <figure>svg + legend + figcaption</figure>
    <div class="dy-table-wrap" hidden>...</div>
    <!-- data-table twin -->
  </div>
  <p class="dy-live" role="status" aria-live="polite"></p>
  <!-- visually hidden -->
</section>
```

Each panel loads **independently** (five parallel requests after `/api/meta`) and owns its own loading, empty and error state (section 8). Panel top rule: 2 px `--ink` (except hero, which has the stacked-sheet look). Eyebrow numbers "No. 1" to "No. 5" are decoration (`aria-hidden`).

### 6.3 Visits over time (hero, `No. 1`)

- **Headline**: `data.total` in `hero-num`. Eyebrow row: `VISITS · {range label}` e.g. `VISITS · LAST 7 DAYS`. Sub-line (`kpi-sub`, serif 16 px): "{peak label} was the busiest {interval}: {n} visits." (computed client-side from points; omit if total is 0).
- **Chart**: area + line over `points[]`. Line `--ink` 2 px, `stroke-linejoin: round`. Area under the line `--c-accent` at `--area-opacity`. Gridlines: horizontal only, 1 px `--rule`, 3 to 4 of them; baseline 1 px `--rule-strong`. Y labels left, mono 12 px `--ink-2`; no y-axis title (the headline says what it is). X labels along the bottom (7.3).
- **Current bucket** (the last point, partial): drawn as hollow marker (`--bg` fill, 2 px `--c-accent` stroke), line segment into it **dashed** (`stroke-dasharray: 4 3`), label "so far" in tooltip. Filled vermilion dot (r 4) on the last point of a complete series is not used; the in-progress treatment is the accent moment.
- **Hover/focus**: vertical 1 px `--ink` crosshair + 5 px dot on the nearest point; tooltip (6.10).
- **Split by** (`<select class="dy-select">`, label "Split by", options from `meta.breakdowns`, plus "None", default None): when set, call `visits-over-time?breakdown=key` and draw **stacked areas** from `breakdown.series`, same x axis, no line, each area separated from the next by a 1.5 px stroke in `--surface`. Colour mapping:
  - `consent`: `"true"` -> `--c-granted` solid, `"false"` -> `url(#dy-hatch)`.
  - `isFirstVisit`: `"true"` -> `--c-new`, `"false"` -> `--c-returning`, `null` -> `url(#dy-dots)`.
  - custom keys: series in server order get `--cat-1..5` (v1.1 palette, 2.5); the **server order is the stack order, bottom to top**; `isOther` -> `url(#dy-hatch-other)`; `value: null, isOther: false` ("no value") -> `url(#dy-dots)`. Never reorder or re-colour by size.
  - **Non-colour encodings, all required (F-28)**: (1) **direct label** inside each coloured band at the last complete bucket (never the in-progress one) when the band is >= 20 px tall (12 px text needs air; at 18 px it touched the neighbouring bands in the mockup): series name (max 12 characters, ellipsis), mono 12 px, right-aligned 8 px inside the band, fill `var(--cat-N-on)` (>= 4.5:1, 2.5); hatched and dotted bands are not labelled in place (the legend names them). (2) The legend lists series in **stack order from top to bottom** (what the eye reads) with each series' total. (3) Tooltip and keyboard live-region text list series in that same top-to-bottom order. (4) The table twin has one column per series in that order. (5) 1.5 px `--surface` separator between bands. Colour alone never identifies a series.
  - Legend under the chart (6.9). Series labels are text from the API: `textContent` only. Display `null` as "No value" and `isOther` as "Other". The legend entry "No value" carries the explanation "Rows without a value for this field." as a `title` and as visually hidden text; it must **never** say or imply "denied consent" (denied rows have no custom data, but so do ordinary rows that simply lack the field; F-37).
  - The headline number stays the total; the legend shows each series' total.
  - Build this **after** the core five widgets (phase 1b); the `<select>` is hidden until it exists. React ships it in the first cut if cheap.
- **Table twin**: columns `Period (UTC)`, `Visits` (and one column per series when split). Caption = panel title + range.

### 6.4 New vs returning (`No. 3`)

- **Eyebrow**: `No. 3 · {WINDOW LABEL}`, the same pattern as the hero's `No. 1 · LAST 7 DAYS`. `{WINDOW LABEL}` names the window this panel actually shows: the selected range's label normally (`LAST 7 DAYS`), **`LAST {cap} DAYS` when the range is capped** (6.4.1). It is rendered in every state (loading, ready, empty, error, unavailable), so it never changes when data arrives.
- **Headline** `kpi-num`: `new / (new + returning)` as a percent, with a small serif unit after it: "34%" then `new` (`label` caps, `--c-new`) baseline-aligned. If `new + returning` is 0 -> "—" and sub-line "No visitors could be classified yet." When the data is approximate (below) a small **`ESTIMATE` tag** follows the unit: mono caps 12 px, `--ink`, 1 px solid `--rule-strong` border, `--r-1`, padding 2 x 6; it is not colour-coded (the meaning is the word). `approximate` is known from `meta.widgets.newVsReturning.approximate` (so the tag is present while loading) and from `data.approximate`.
- **Sub-line** (honesty line, always shown when `unknown > 0`): "Based on {identified} visits with a known visitor. {unknown} ({pct}%) could not be classified: declined consent or no usable identity." (This is the string v1.0 code ships; it replaces the v1.0 spec wording "Of {identified} visits ...".)
- **Notes** (each its own `dy-note` paragraph, mono 12 px `--ink-2`, directly under the sub-line and above the split bar, in this order; omit the ones that do not apply): (1) the cap note (6.4.1); (2) the `approximate` caveat, exact copy: "Visitors are matched by IP address as well as user id, so shared addresses can merge people and hashed addresses reset when the salt changes. Read these as estimates, not a head count."; (3) always: "Unknown means no consent, or consent but no usable identity." Declined visits are always `unknown`: they store only page, time and consent=false, so they cannot be classified, and the three numbers are never presented as a census of people (SPEC 10.9 rule 8).
- **Split bar** (full width, 20 px tall, `--r-0`, three segments in this order: new, returning, unknown; segments narrower than 3 px grow to 3 px; unknown is `url(#dy-dots)` with 1 px `--rule-strong` outline). Direct labels sit **above** the bar segments when there is room (>= 56 px), otherwise only in the legend. Widths are computed in JS on the SVG (`width` attributes), so no inline styles.
- **Columns**: one stacked column per bucket, order bottom to top: returning, new, unknown. Gap between columns 2 px (1 px if bar < 6 px wide). Corner radius 0. Tooltip lists all three plus the share.
- **Legend**: `■ New  ■ Returning  ▨ Unknown` with totals (6.9).

#### 6.4.1 Range cap (F-09, Alex's decision)

The new-vs-returning query is expensive, so the server refuses ranges longer than `meta.limits.newVsReturningMaxRangeDays` (`cap`, SPEC default 31; `400 range_too_large` beyond it). v1.0 sent the selected range regardless, so 90d put this panel into an error state. Now the panel **clamps and says so**:

- `capped` = `selectedRange.days > cap`. The range selector is **not** changed: 90d stays selectable because it still applies to the other four panels. The cap is per panel.
- **Window when capped**: `to = meta.now`, `from = meta.now - cap days`, interval `hour` when `cap <= 1`, otherwise `day` (the selected range's interval, e.g. weekly for 90d, is not used). Not capped: the normal window from 7.4. This is exactly what `windowFor(range, meta.now, cap)` already does.
- **Label** (two places, both always visible when capped): (a) the eyebrow `No. 3 · LAST 31 DAYS`; (b) the cap note as the first `dy-note` under the sub-line. Exact copy: `Showing the last {cap} days: this widget is capped at {cap} days.` (singular for `cap = 1`: `Showing the last day: this widget is capped at 1 day.`). Not capped: no note, eyebrow shows the range label.
- **Names the window elsewhere**: the table twin caption `New vs returning visits per day, last 31 days (UTC)`; the chart `aria-label` ends "Window: last 31 days."; the live-region summary `New vs returning loaded (last 31 days): ...`; the first-bucket tooltip says "partial period" from the clamped `from`, not the selected range's.
- **States when capped**:

| State       | What shows                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| loading     | normal skeleton; eyebrow already says `LAST 31 DAYS`; no note yet (the skeleton has no text)                                                     |
| ready       | eyebrow + sub-line + cap note + (ESTIMATE tag and caveat if approximate) + unknown definition + split bar + chart                                |
| empty       | eyebrow + the 8.2 empty block + the cap note below it (so an empty 31-day window is not mistaken for an empty 90-day one)                        |
| unavailable | eyebrow + the 8.6 block; no cap note (there is no data to qualify)                                                                               |
| error       | eyebrow + the 8.3 block. A `400 range_too_large` here means meta is stale (the host lowered the cap): action `[Reload page]`, never "Try 7 days" |

- Hosts that lower the cap below 30 are covered by the same rule (`30d` is then capped too).

### 6.5 Top pages (`No. 2`)

An ordered list, not a bar chart: the bar is a **row underlay**, so it reads like a ledger.

```html
<ol class="dy-pages">
  <li class="dy-page-row">
    <span class="dy-rank">1</span>
    <span class="dy-page v">/pricing</span>
    <!-- visitor text: textContent -->
    <span class="dy-count">310</span>
    <span class="dy-share">39%</span>
    <span class="dy-bar" aria-hidden="true"></span>
    <!-- width via el.style.setProperty('--w', '100%') -->
  </li>
</ol>
```

- Grid per row: `rank 28px | page 1fr | count auto | share 48px`. At 320 the row becomes two lines: line 1 `rank + page` (page wraps, `overflow-wrap: anywhere`), line 2 `count + share` right-aligned; the bar underlays both lines.
- Bar: absolutely positioned, `height: 100%`, `transform-origin: left; transform: scaleX(var(--w-ratio))` where the ratio is `visits / maxVisitsInList` (so the top page always fills the row); colour `color-mix(in srgb, var(--c-accent) 22%, transparent)`; on row hover **30 %** (v1.0: 38 %, which pushed `--ink-2` text to 4.2:1 light / 3.7:1 dark). `color-mix` has full evergreen support (2023+); fallback line before it: `background: var(--surface-2)`.
- Text always sits above the bar (`position: relative`). Contrast over the bar, measured (2.5): `--ink` is 10.9 / 9.7 (light) and 10.4 / 8.7 (dark) at 22 % / 30 %; `--ink-2` is 5.4 / 4.8 and 5.4 / 4.6. v1.0 claimed "ink 11:1 or better" at 38 %; the real figures at 38 % were 8.5 light and 7.1 dark. On `:hover` the rank and share text switch from `--ink-2` to `--ink` (no transition) so nothing falls below 4.5:1.
- Rank numeral: serif 20 px, `--ink-2`. Page path: mono 13 px `--ink`. Count: mono 13 px 500. Share: `--ink-2`, `Math.round(share * 100) + '%'`, "<1%" when share < 0.005 and visits > 0.
- Footer row "Other pages": `otherVisits` with a hatched (`.dy-sw-declined`-style but `--ink-2` lines) underlay and its share (`otherVisits / totalVisits`). Hidden when 0.
- `[Top 10 v]` select in the panel head: 10 / 25 / 100 (`limit` param; clamp to `meta.limits.topPagesMax`). Changing it refetches only this panel.
- Rows are **not** links and not focusable (visitor strings must never become `href`s; SPEC 10.9 rule 1).
- Panel headline `kpi-num`: none; this panel's headline is the list itself (the one panel without a big numeral, on purpose, to vary rhythm). Eyebrow row shows `TOP {n} OF {pages count shown + other}`.

### 6.6 Consent (`No. 4`)

- **Headline** `kpi-num`: `totals.rate` as percent with one decimal ("82.5%"), then `granted` (caps label, `--c-granted`). `rate: null` -> "—" and sub-line "No visits in this range."
- **Sub-line** (always shown), exact copy: "{denied} visits declined. Declined visits store only the page and the time. No IP, user id, name or email is kept, and they are never counted as new or returning." This is true under the storage rule that a denied row holds only page, timestamp and consent=false (SPEC 8.1, 8.2). It deliberately does not mention host constants (SPEC 3.6, e.g. a tenant id): those are not visitor data. v1.0 said "no IP, name, email or first-visit flag"; that implied a stored flag, which read-time new-vs-returning no longer has.
- **Split bar**: granted (solid `--c-granted`) vs declined (`url(#dy-hatch)`, 1 px outline `--c-declined`). Labels above: `Granted 340` left, `Declined 72` right, mono.
- **Columns**: 100 % stacked per bucket (granted bottom, declined top). Buckets with 0 + 0 visits draw a 1 px `--rule-strong` stub at the baseline (so empty is visible, not a gap) and "No visits" in the tooltip. Y axis labels `0%, 50%, 100%`.
- Rate is **of visits, not of people**; the table twin header says "Share of visits".

### 6.7 Recent visits table (`No. 5`)

The only dense data surface; wrapped in the stacked-sheet look.

Columns (>= 1024), `table-layout: fixed` so a masked IP never breaks mid-value. Widths at 1024-1279: Time 104 | Page auto | Consent 116 | First visit 92 | IP 116 | Email 168 | Username 108 (Page keeps about 200 px). At >= 1280: 120 | auto | 124 | 104 | 136 | 208 | 144. Header row: label caps, `--ink-2`, 2 px `--ink` rule above, 1 px `--ink` rule below. Rows: 1 px `--rule` bottom border, no zebra, min height 52 px, `vertical-align: top`.

| Cell                      | Rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time                      | line 1 `HH:MM:SS` mono 13 px 500 `--ink`; line 2 `30 Oct` mono 12 px `--ink-2`. `<time datetime="ISO">`. Content from `timestamp`, formatted with `Intl.DateTimeFormat`, `timeZone: 'UTC'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Page                      | mono 13 px, `overflow-wrap: anywhere`, wraps up to any length (never truncated, never a link).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Consent                   | chip: `● Granted` (solid 10 px `--c-granted` square-dot + text) or `▨ Declined` (10 px hatched swatch + text), pill outline 1 px `--rule-strong`. Text always present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| First visit               | **Column exists only if `meta.fields.isFirstVisit` is true** (it is true exactly when the new-vs-returning widget is available, SPEC 10.5). `Yes` / `No` in mono, `—` (em dash, visually hidden "unknown") when `isFirstVisit` is null: always for declined rows (never classified) and for rows without a usable identity. Yes is `--c-new` text weight 500 (4.71:1 even on the hover wash), No is `--ink-2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| IP, Email, Username       | **four distinct states**, never confuse them: (a) value present -> mono text, shown **exactly as the API returned it** (masked by default: `203.0.x.x`, `j***@example.com`, `j***`; the client never masks or unmasks anything itself); while `meta.piiMasked` is true each of these column headers carries a small lock glyph and visually hidden text " (masked)" (replaces v1.0's `aria-description`, which assistive tech does not reliably announce); (b) `consent === false` -> **"not collected"** in serif italic `--ink-2` on a hatched ground (`repeating-linear-gradient(135deg, transparent 0 4px, var(--rule) 4px 5px)`); for declined rows these cells merge into **one** cell (`colspan` = number of personal columns that exist) reading "Not collected: visitor declined consent"; (c) `consent === true`, the column exists and the value is null -> `—` with visually hidden "not provided"; (d) the column **does not exist** because `meta.fields.<name>` is false (role unmapped, SPEC 3.2): no header, no cell, no `—`. The table simply has one column fewer and Page takes the width; the merged "not collected" cell spans only the remaining personal columns and is omitted when none remain (declined rows are then identified by the Consent chip alone). |
| Username cell second line | `userId`, **masked by default exactly like the other personal values** (SPEC `pii.maskUserId`, default true), rendered as received (shape is the server's, e.g. `u_***42`), mono 12 px `--ink-2`. It shares the Username column, so the header's lock and "(masked)" text cover both. Shown only when `meta.fields.userId` is true and the value is non-null. If only `userId` is mapped (no username), the column is titled **"User ID"** and shows the id as its main line; if neither is mapped the column is absent. When revealed (below) the plain id is shown, which is how support still gets it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**PII reveal**: only render the button when `meta.features.piiRevealable` is true (from `/api/meta`). `[Show full values]` (`aria-pressed`); it unmasks IP, email, username **and user id**. Pressing it refetches `recent-visits?pii=reveal`. While revealed: the sheet gets a persistent 3 px `--c-accent` top bar and a mono caption "Showing personal data. Hide when sharing your screen." and the button reads `[Hide full values]`. Reload resets to masked (never stored). If the response says `piiMasked: true` anyway, show a one-line note "The server kept values masked." and set the button back to unpressed (SPEC 10.6: the server decides).

**Below 1024** the table keeps real table semantics (`role="table"` etc. set **explicitly** on the elements, because `display: grid` can strip native semantics in some browsers) and each `<tr>` becomes a grid:

- 720 to 1023: row grid `time 110px | page 1fr | consent 120px | first 90px`; second row spanning all columns holds IP, Email, Username as three inline `label: value` groups (`flex-wrap: wrap`, 16 px gap). Each `<td>` carries `data-label` for the CSS `::before` caption (labels for the second row only). Columns that do not exist (`meta.fields`) are simply not rendered; the grid is built from the columns present.
- < 720: each row is a stacked block, 12 px between lines: time + date line, page, consent + first visit, then IP / Email / User lines each with a 56 px caps label (`IP`, `EMAIL`, `USER`). 1 px `--rule` separator, 16 px block padding. The header row is visually hidden (still in the DOM for assistive tech).

**Paging**: 25 rows by default (`meta.defaults.recentLimit`). `[Load 25 more]` button below the table uses `nextCursor`, appends rows, moves focus to the first new row's time cell (`tabindex="-1"` programmatically), announces "25 more visits loaded" in the live region. Button hidden when `nextCursor` is null; replaced by a mono caption "End of range." **Exception**: when `meta.fields.id` is false there is never a cursor, so the caption is instead "Showing the latest {n} visits." (otherwise it would claim the range ended). The table uses the page range (same as hero). No sorting UI (server order is newest first and fixed). No row actions.

### 6.8 Buttons and selects

`dy-btn`: mono caps 12 px, 44 px min height/width, padding 0 16 px, 1 px `--rule-strong` border, `--r-1`. `dy-btn--text`: no border, underline 2 px (used for "Load more", "Retry"). `dy-select`: native `<select>` (no custom dropdown; native is accessible), 44 px tall, 1 px `--rule-strong`, `--r-1`, mono 13 px, `appearance: none` plus a CSS-drawn caret (`::after` triangle on the wrapper); label always visible above or beside.

### 6.9 Legend

Inline list under the chart: `<ul class="dy-legend">` of `<li><span class="dy-sw dy-sw-new"></span> New <span class="dy-legend-n">90</span></li>`; mono 12 px; wraps; 16 px gap. Legend items are not interactive in v1 (no series toggling), so they are not buttons. Totals use the same numbers as the table twin.

### 6.10 Tooltip

One per chart, `role="presentation"` (the live region carries the text for assistive tech). Inverted chip: `--tip-bg`/`--tip-fg`, mono 12 px, `--r-1`, padding 8 12, `max-width: 240px`, `pointer-events: none`. Content (text nodes only): line 1 period (`Sat 25 Oct 2026`, UTC; `25 Oct, 14:00-15:00 UTC`; `Week of 20 Oct`; add " (so far)" for the last bucket), then one line per series: swatch + name + value (`412 visits`). Position: `transform: translate(x, y)` computed so it flips to the left of the pointer when it would pass the right edge and stays within the chart box. Touch: tap shows it, tap elsewhere hides; no hover dependence for any information.

---

## 7. Chart construction rules (identical in HTML and React)

### 7.1 Sizing

Inline `<svg>` with `viewBox="0 0 W H"` where `W` = container `clientWidth`, `H` from section 5.2 heights. Re-render on resize via `ResizeObserver` (rAF-debounced). Text is in real SVG `<text>` at **constant** 12 px (that is why the viewBox equals pixels: no scaling of text). `role="img"` plus `aria-label` (9.2). No inline `style=""` attributes (CSP); use attributes and classes.

### 7.2 Scales

- X: bands for columns (`bandWidth = (plotW - gap * (n - 1)) / n`, floor at 2 px; if `bandWidth < 3` at 90d/hour edge cases, drop the gap to 1), points for the line (`x = left + i * plotW / (n - 1)`; `n = 1` -> centre).
- Y: starts at 0 always. `niceScale(max)`: `step` = the smallest of 1, 2, 5 x 10^k that is >= `max / 3`; `yMax = step * ceil(max / step)`; draw a gridline every `step` (so 3 to 4 intervals, always round labels such as 0/200/400/600, never 333.3). Percent charts use fixed 0/50/100 %. If max is 0 -> `yMax` 4, `step` 1 (the empty state replaces the chart anyway, 8.2).
- Number formats: axis `Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1})`; headline numerals `toLocaleString()`; percents `Math.round(rate * 1000) / 10` + `%` (100 -> "100%", 0 -> "0%").

### 7.3 X-axis labels

Target >= 64 px between label centres. Pick the step `k = ceil(64 / pxPerBucket)`; label every `k`-th bucket; always label the first, never crowd the last (drop the one before it). Formats (UTC): `hour` -> `HH:00` (with the date `30 Oct` on the first label and at midnight), `day` -> `25 Oct` (or `25` with the month shown on the first label and on the 1st), `week` -> `20 Oct`, `month` -> `Oct`. 12 px mono `--ink-2`; tick marks 4 px `--rule-strong`.

### 7.4 Interval per range

| Range        | `from`            | `interval` | Buckets            |
| ------------ | ----------------- | ---------- | ------------------ |
| 24h          | `meta.now` - 24 h | `hour`     | 25 (first partial) |
| 7d (default) | `meta.now` - 7 d  | `day`      | 8                  |
| 30d          | `meta.now` - 30 d | `day`      | 31                 |
| 90d          | `meta.now` - 90 d | `week`     | 14                 |

`to` = `meta.now` (never the client clock; avoids skew). Send full ISO strings with `Z` (`2026-10-23T12:05:00.000Z`). 90d uses weekly buckets because 90 daily columns at 288 px are under 3 px wide. First and last buckets are partial; the last is styled as "so far" (6.3); the first is drawn normally but the tooltip says "partial period" when `from` is after the bucket start.

**Per-panel cap (v1.1)**: the table above is the window for hero, top pages, consent and recent visits. The new-vs-returning panel applies `meta.limits.newVsReturningMaxRangeDays` on top: when the selected range is longer than the cap, its window is `meta.now - cap days` to `meta.now` with `day` buckets (6.4.1), e.g. 90d becomes the last 31 days and 31 daily columns, while the other panels keep 14 weekly buckets over 90 days.

### 7.5 Colour application summary

| Series               | Fill / stroke                                        | Pattern                                                                           |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| visits line          | stroke `--ink`, area `--c-accent` @ `--area-opacity` | solid                                                                             |
| new                  | `--c-new`                                            | solid                                                                             |
| returning            | `--c-returning`                                      | solid                                                                             |
| unknown              | `url(#dy-dots)`                                      | dotted                                                                            |
| granted              | `--c-granted`                                        | solid                                                                             |
| declined             | `url(#dy-hatch)`                                     | hatched 45 deg                                                                    |
| other (split by)     | `url(#dy-hatch-other)`                               | hatched -45 deg                                                                   |
| split-by series 1..5 | `--cat-1..5` (2.5)                                   | solid, plus direct label (`--cat-N-on`), stack-ordered legend/tooltip/table (6.3) |
| split-by "no value"  | `url(#dy-dots)`                                      | dotted                                                                            |

### 7.6 Hero numeral collision rule

**Revised in v1.1 (F-24).** v1.0 only looked at the first 40 % of points, but a 104 px numeral such as "1,234,567" is about 480 px wide and can cover more than 40 % of an 830 px plot; the line (`--ink`) over the numeral (`--ink`) is 1:1 contrast wherever they cross.

At < 720 the numeral is always in flow above the chart. At >= 720 it overlaps the plot's upper-left unless the test below says it would meet the line:

1. Draw the chart. **In the same task, before paint**, measure the numeral: `r = numeral.getBoundingClientRect()`, converted to plot coordinates. The collision box is `r` grown by 12 px on every side.
2. Test **every polyline segment** of the line against that box, including the dashed in-progress segment and the hollow marker (not only vertices, not only a leading share of the points): clip each segment to the box's x range and take the smallest `y` (the highest point on screen); a collision exists when that `y` is less than the box's bottom edge.
3. Collision, a numeral wider than 60 % of the plot, or no usable measurement -> add class `dy-hero--stacked` (numeral in flow above the chart). The stacked layout moves the plot down, so it needs no second test.
4. Re-run the test on every draw: resize (same rAF as the chart redraw), range change, split-by change, new data. Set or clear the class from scratch each time (no hysteresis state).
5. The area fill under the line may sit behind the numeral (`--ink` on the accent tint is above 9:1); gridlines are decorative. Only the line itself matters.
6. Test vectors (Olivia): totals 7, 80, 801, 12,345 and 1,234,567, each at 1024 and 1440 wide, each with data that peaks early and data that peaks late: either `dy-hero--stacked` is present, or the numeral's box does not intersect the line's bounding polyline (Playwright bounding-box test).

### 7.7 Keyboard and screen reader behaviour of a chart

See 9.3. The chart container is `tabindex="0"` with `role="group"` and `aria-roledescription="chart"`; the inner `<svg>` is `role="img"` with the summary label. **Keyboard hint (v1.1, F-43)**: the container has `aria-describedby` pointing at a visually hidden `<p>` "Use the left and right arrow keys to move between periods. Escape closes the tooltip.", and a visible one-line caption under the chart, mono 12 px `--ink-2`: "← → explore · Esc close". The caption is always in the DOM and its height is always reserved (no layout shift); it becomes visible (`opacity` 0 to 1) only while the chart matches `:focus-visible`. Pointer users never see it.

---

## 8. States

Each panel has its own state machine: `loading -> ready | empty | error`, plus `refreshing` (has data, loading new). Mark the `.dy-viz` wrapper with `aria-busy="true"` while loading. Use the panel live region for transitions.

### 8.1 Loading (first load)

Skeleton shaped like the final content, no spinners:

- headline numeral: a `--surface-2` block 0.9 em tall and 5 ch wide; sub-line: two 70 % / 45 % wide 12 px blocks.
- charts: the real axes and baseline drawn, with 3 `--surface-2` gridline-aligned blocks (area silhouette), or for columns 12 grey stubs of varying height (fixed pseudo-random heights, no random per render).
- top pages: 10 rows, each with a `--surface-2` bar (random-looking fixed widths 100, 82, 74, 60, 51, 44, 33, 28, 20, 14 %) and short grey text blocks.
- table: header real, 6 skeleton rows.
- Skeleton blocks use `--rule` (not `--surface-2`, which is nearly invisible on `--bg`).
- All blocks pulse with the opacity animation (static under reduced motion). A visually-hidden "Loading visits over time" message goes to the live region once.
- Delay: only show skeletons if a request is still pending after **200 ms** (no flash on fast responses).

### 8.2 Empty (no data in range)

Per panel, driven by data (`hero: data.total === 0`; `top pages: pages.length === 0`; `new vs returning: totals sum 0`; `consent: granted + denied = 0`; `table: visits.length === 0`).

Illustration: an **empty ledger**, a 160 x 56 inline SVG of 4 ruled lines (1 px `--rule-strong`), a dotted baseline, and a small vermilion square at the start of line 1 (the "entry not yet written"). Decorative (`aria-hidden`). Keep chart axes visible behind it? No: replace the chart.

Copy (serif 16 px, left-aligned, max 44 ch):

| Panel              | Title (serif italic 20 px)            | Body                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero (range < 90d) | "The ledger is empty for this range." | "No visits between {from} and {to} (UTC)." + button `[Try 90 days]` (hidden when range is already 90d)                                                                                                                                                         |
| Hero (90d)         | "Nothing recorded yet."               | "dynalitics has not stored a visit in the last 90 days. Call `track()` from a route handler, check that your app's `onError` is not reporting insert errors, then refresh." (the word `track()` and `onError` in mono, fixed copy, no user data) + `[Refresh]` |
| Top pages          | "No pages yet."                       | "Pages appear once visits are recorded."                                                                                                                                                                                                                       |
| New vs returning   | "Nobody classified yet."              | "Visits count as new or returning only when consent was given and an identity was supplied."                                                                                                                                                                   |
| Consent            | "No consent decisions yet."           | "Granted and declined visits will appear here."                                                                                                                                                                                                                |
| Table              | "No visits in this range."            | "Newest visits appear here as soon as they are written."                                                                                                                                                                                                       |

If the hero is empty, the other panels still render their own result (they will almost always be empty too); do **not** collapse the grid (layout stability, CLS).

### 8.3 Error

Errors are **per panel** except a failing `/api/meta` (see below). Panel error block: a 2 px `--c-danger` top rule, a stamp-style label (mono caps, 1 px `--c-danger` border, rotate 0, **no** rotation), then message and action. Error text colour `--c-danger` for the stamp only; body copy in `--ink` (contrast).

Map responses to copy. Never print `error.message` as the main text; fixed copy keyed by status/code, with the server `error.code` shown small in mono as a reference.

| Condition                                                                                                                                                              | Stamp              | Title                                        | Body                                                                                                                                                                                                                                                                                                                                         | Action                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| HTTP 403 `forbidden`; also 401                                                                                                                                         | `NOT AUTHORISED`   | "You can't view analytics."                  | "The app that serves this page said no. Sign in with an account that is allowed to see analytics, then reload."                                                                                                                                                                                                                              | `[Reload page]` only (retry is pointless)                                                                             |
| Redirect or non-JSON reply: `fetch` ok but `JSON.parse` fails, `response.redirected`, or `response.type === 'opaqueredirect'` (request made with `redirect: 'manual'`) | `UNEXPECTED REPLY` | "The analytics endpoint didn't return data." | "It returned something that isn't analytics JSON, or redirected somewhere else. This usually means a login page, single sign-on or a proxy in front of this route. Check the route and its authorisation."                                                                                                                                   | `[Retry]`                                                                                                             |
| Network failure (`fetch` rejects, offline)                                                                                                                             | `UNREACHABLE`      | "Can't reach the analytics endpoint."        | "Check your connection and that the server is running. Nothing was lost; data stays in your database." On the **first** `/api/meta` request only, add: "If this page sits behind single sign-on, your sign-in may have expired: reload the page." (a cross-origin sign-in redirect is indistinguishable from a network error in the browser) | `[Retry]`                                                                                                             |
| 504 `timeout`                                                                                                                                                          | `TIMED OUT`        | "That took too long."                        | "The query exceeded its time limit. Choose a shorter range."                                                                                                                                                                                                                                                                                 | `[Try 7 days]` (if range > 7d) + `[Retry]`                                                                            |
| 503 `unavailable`                                                                                                                                                      | `UNAVAILABLE`      | "The database is busy or unavailable."       | "Try again in a moment."                                                                                                                                                                                                                                                                                                                     | `[Retry]`                                                                                                             |
| 400 `range_too_large` / `invalid_parameter`                                                                                                                            | `BAD REQUEST`      | "That range isn't allowed."                  | "Choose a shorter range." (plus `param` name in mono if present)                                                                                                                                                                                                                                                                             | `[Try 7 days]`; on the new-vs-returning panel (it is normally clamped, 6.4.1) a 400 means stale meta: `[Reload page]` |
| 404 `not_found`                                                                                                                                                        | `NOT FOUND`        | "This route doesn't exist."                  | "The dashboard and server versions may not match. Update both packages."                                                                                                                                                                                                                                                                     | none                                                                                                                  |
| 5xx `internal` / anything else                                                                                                                                         | `ERROR`            | "Something went wrong on the server."        | "The server logged the details. Try again."                                                                                                                                                                                                                                                                                                  | `[Retry]`                                                                                                             |

Behaviour:

- **Retry** re-requests only that panel; the button becomes `Retrying...` (`aria-busy`, disabled) and is re-enabled after the response; a 2 s minimum cooldown applies, **no automatic retry loop** (SPEC 10.9 rule 4).
- `role="alert"` on the error block **only for the first error** on a page; subsequent panel errors use `role="status"` so a total outage does not read five alerts in a row.
- **`/api/meta` fails or returns 403**: show a single page-level error (same block, full width, in place of the grid below the masthead) and **do not** request the other endpoints (an unauthorised caller would otherwise trigger five more 403s). Other `/api/meta` failures: same block with `[Retry]`.
- Stale data: if a refresh fails after a successful load, keep the old data at full opacity and put a one-line `UNAVAILABLE`/`UNREACHABLE` stamp **above** the panel with `Showing data from 12:05 UTC. [Retry]`; never blank a panel that has data.

The served HTML page authenticates with **ambient credentials only** (`credentials: 'same-origin'`: the host's session cookie). Hosts that authorise with an `Authorization: Bearer` header cannot use the served page, because it has no way to attach one; they use the React component with `getRequestInit` (12.2). Document this in the README (F-42).

### 8.4 Refreshing / range change

Keep the previous render at `opacity: .5`, show the 2 px progress bar on the panel top (4.5), set `aria-busy="true"`, disable nothing. Cancel in-flight requests on range change (`AbortController`); only the latest response may render (guard with a request id) so a slow old response can't overwrite a fast new one.

### 8.5 Partial data

Different panels may be in different states at once (hero ready, table error). Do not coordinate them except for `/api/meta` and the shared range. The masthead "Updated" time is the time of the **last successful hero response**.

### 8.6 Unavailable (calm, not an error) (F-23)

SPEC 10.4: a widget that cannot be computed because of how the table is mapped or configured answers `200` with `success: true`, `data: null` and `unavailable: { reason, message }`. `meta.data.widgets.<widget>.available === false` says the same before any request. Typical case: new vs returning with reasons `no_identity_column`, `identity_not_reliable` or `disabled_by_host`. This is a normal, quiet state. It is **not** an error: no red, no stamp, no retry, no error styling.

- **Decide from meta first**: if `meta.widgets.<w>.available` is false, do not call the route; render this state from the meta `reason`/`message`. If the route itself answers `unavailable` (config changed between calls), render it identically. Discriminate on the envelope: `error !== null` is an error (8.3), `unavailable !== null` is this state (SPEC 10.4 warns the two names are easy to confuse; the 503 code `unavailable` is a database outage and uses the error block).
- **Block** (in the widget's slot, same minimum height as the chart state it replaces so the grid does not jump; keeps the panel's normal top rule, **not** the red one): a label `NOT AVAILABLE` (mono caps 12 px, `--ink-2`, 1 px **dashed** `--rule-strong` border, `--r-1`, padding 4 x 8); title in serif italic 20 px "{Panel title} isn't available here."; body = `unavailable.message` **verbatim as text** (the server sends a fixed English sentence, e.g. "New vs returning needs a user id or IP address column, and neither is configured."; escape it like every API string); a reference line in mono 12 px `--ink-2` "reason: {reason}" (an enum from the server, shown as text). No illustration (it is not "empty"), no action (configuration cannot be fixed from the page), no auto-retry, no live-region `alert`: `role="status"`.
- **Effects elsewhere**: the panel's eyebrow stays (6.4); the recent-visits table drops the First visit column (`fields.isFirstVisit` is false, 6.7); other panels are unaffected. If the hero's own widget were ever unavailable, the same block replaces the chart and the headline numeral shows "—".
- The block is never combined with the cap note (6.4.1): there is no data to qualify.

---

## 9. Accessibility (target: WCAG 2.2 AA)

### 9.1 Structure

`<html lang="en">` (v1.1: fixed to the language of the shipped copy, which is English only; v1.0 derived it from `navigator.language`, so a German user's screen reader would have read English with German pronunciation, WCAG 3.1.1). Number and date formatting still follow the browser locale (11) and need no `lang` markup; `<title>dynalitics</title>`; skip link first in `<body>` (`<a class="dy-skip" href="#main">Skip to analytics</a>`, visible on focus, `z-index: var(--z-skip)`); landmarks `<header>`, `<main id="main" tabindex="-1">`, `<footer>`; one `<h1>`, panel titles `<h2>`; `<section aria-labelledby>`. Footer: "dynalitics {version} · data stays in your database · times in UTC" (mono 12 px).

### 9.2 Chart text alternatives

- `<svg role="img" aria-label="...">` summary generated from data: hero "Visits per day, 24 Oct to 30 Oct UTC. Total 801. Highest: 25 Oct with 412. Lowest: 24 Oct with 0." New vs returning "Visits by new, returning and unknown visitors per day. 90 new, 250 returning, 72 unknown in total." Consent "Consent per day. 340 granted, 72 declined, 82.5% granted overall."
- Chart containers also have `aria-describedby` to a keyboard hint (7.7).
- **`[Chart | Table]` toggle** in each chart panel (`role="group"`, two `aria-pressed` buttons; both always visible). Table view = real `<table>` with `<caption>`, `<th scope="col">`, `<th scope="row">` for the period, right-aligned numerals. Table view persists per panel for the session (in memory). Default: Chart.
- Legends and totals are real text in the DOM, not drawn in SVG.

### 9.3 Keyboard map

| Where             | Keys                                                                                                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page              | `Tab` order = DOM order: skip link, theme, range group (one tab stop), refresh, then per panel: selects, chart/table toggle, chart (one tab stop), table "Load more".                                                                                                                                                       |
| Range group       | `Left`/`Right`/`Up`/`Down` move and select; `Home`/`End` first/last.                                                                                                                                                                                                                                                        |
| Chart (focused)   | `Left`/`Right` previous/next bucket, `Home`/`End` first/last, `Esc` hides the crosshair and tooltip. Each move updates the crosshair, the tooltip, and the panel live region: "25 Oct: 412 visits" (all series for stacked charts: "25 Oct: returning 250, new 90, unknown 72"). `Up`/`Down` are not used (so they scroll). |
| Toggles / buttons | `Enter` / `Space`.                                                                                                                                                                                                                                                                                                          |
| Table             | read with a screen reader's table navigation; rows aren't tab stops.                                                                                                                                                                                                                                                        |

All pointer-only information (tooltips) is available by keyboard (above) and in the table twin. No drag gestures anywhere (WCAG 2.5.7). Interactive targets are >= 44 x 44 px (>= 24 x 24 required, WCAG 2.5.8) including the segment buttons, selects, toggle buttons and "Load more".

### 9.4 Colour and contrast

All text >= 4.5:1 and all non-text marks and control borders >= 3:1 in **both** themes, from the verified tables in 2.5 (reproduce with `node docs/check-design-tokens.mjs`). Rules that keep it true: `--rule` (1.5:1) is decoration only; `--c-unknown` is never text on `--surface-2`; `--rule-strong` borders are required against `--bg` and `--surface` only; hover text on the top-pages bar is `--ink`. Colour is never the sole carrier: consent granted/declined = shape + hatch + word; new/returning = labelled; unknown = dotted + word; categorical series = direct labels + stack-ordered legend/tooltip/table (6.3). v1.0 claimed all of this but missed four cases (QA F-25, F-28); 2.5 lists what changed.

### 9.5 Forced colours, zoom, spacing

- `@media (forced-colors: active)`: chart strokes `CanvasText`, area `Highlight`-tinted via `fill: Canvas` + `stroke: Highlight`, selected segment `Highlight` / `HighlightText`, hatch and dot patterns keep working (they are SVG shapes), grain off. Chips keep their text labels. Test in Windows High Contrast / Chrome emulation.
- 200 % zoom and 320 CSS px reflow (WCAG 1.4.10) are covered by the single-column layout. Text spacing overrides (1.4.12) must not clip: no fixed heights on text containers (use `min-height`).
- Print: hide masthead controls, grain, buttons; keep charts and table (charts are SVG).

### 9.6 Live regions

One visually-hidden `role="status"` per panel (`.dy-live`) for: loading start (only if > 200 ms), result summary ("Visits over time loaded: 801 visits"), keyboard chart exploration, "25 more visits loaded". Do not announce on every tooltip hover.

---

## 10. Security-minded UI rules (restating SPEC 10.9 as design constraints)

1. **Every API string is text, never HTML**: page, username, email, userId, IP, custom values, series `value`s, error `message`/`param`. HTML build: `textContent`, `document.createTextNode`, `setAttribute` with text values only. React: default escaping; **no** `dangerouslySetInnerHTML`; no `href` or `src` built from data. A helper `el(tag, className, text)` is the only DOM factory in the HTML build, it never touches `innerHTML` (lint with a grep in CI: `innerHTML|outerHTML|insertAdjacentHTML|document.write|eval|new Function` must not appear in the dashboard source).
2. **Bidi and invisible characters**: every visitor-supplied string is wrapped with `class="v"` -> `unicode-bidi: isolate; overflow-wrap: anywhere;` (stops RTL-override strings from reordering neighbouring cells), and the page path is also given `dir="auto"`.
3. **Class names and CSS custom properties** are set from our own constants only. Never `className = data.something`, never selectors built from data. Numeric CSSOM values (`--w`, `--i`) are produced by `Number()` of server numbers and clamped (`0..1`).
4. **No inline `style=""` attributes or inline handlers** (the CSP forbids them): use classes, SVG attributes, `el.style.setProperty(...)` (CSSOM is allowed under `style-src 'nonce'`).
5. **No third-party anything**: no fonts, icons, images, analytics. Icons used (theme half-square, lock, dots) are inline SVG or CSS shapes. The only network calls are `GET {base}/api/*` with `credentials: 'same-origin'` (so the served page works with cookie/session authorisation only, 8.3).
6. **PII**: masked by default; the only UI to reveal is the explicit toggle described in 6.7; revealed state is never persisted, never put in the URL hash, never copied into the live region text, and is hidden while printing (`@media print { .dy-revealed .dy-pii { visibility: hidden } }`).
7. **Errors never echo server text as HTML**, and never expose hostnames or SQL (the server already guarantees this; the UI additionally uses fixed copy).
8. **Version/identity**: footer shows the package version only (from `meta.version`'s companion constant in the bundle), never the table name or DB.

---

## 11. Data mapping (API -> UI)

All paths relative to `{base}`; envelope per SPEC 10.4 (`success`, `data`, `unavailable`, `meta`, `error`). A response with `unavailable !== null` has `data: null` and is shown per 8.6, not as an error.

| Widget           | Request                                                                         | Fields used                                                                                                                        | Derived                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot             | `GET /api/meta`                                                                 | `data.now`, `defaults`, `limits` (incl. `newVsReturningMaxRangeDays`), `breakdowns`, `widgets`, `fields`, `features.piiRevealable` | `from = now - range`; hide "Split by" when `breakdowns` is empty; `widgets.<w>.available === false` -> 8.6 without calling the route; table columns from `fields` (6.7); `widgets.newVsReturning.approximate` -> ESTIMATE tag; cap window for new-vs-returning (6.4.1); PII toggle only if `piiRevealable` |
| Visits over time | `GET /api/visits-over-time?from&to&interval[&breakdown]`                        | `data.points[].bucket/visits`, `data.total`, `data.breakdown.series[]`                                                             | peak/lowest for summary, in-progress last bucket                                                                                                                                                                                                                                                           |
| Top pages        | `GET /api/top-pages?from&to&limit`                                              | `data.pages[].page/visits/share`, `data.totalVisits`, `data.otherVisits`                                                           | bar ratio = `visits / pages[0].visits`; other share = `otherVisits / totalVisits`                                                                                                                                                                                                                          |
| New vs returning | `GET /api/new-vs-returning?from&to&interval` with the **capped window** (6.4.1) | `data.points[].bucket/new/returning/unknown`, `data.totals`, `data.approximate`, `data.basis`, `unavailable`                       | new share = `new / (new + returning)`, identified = `new + returning`; eyebrow label from the effective window                                                                                                                                                                                             |
| Consent          | `GET /api/consent-rate?from&to&interval`                                        | `data.points[].granted/denied/rate`, `data.totals`                                                                                 | bucket share = `granted / (granted + denied)`; empty bucket if both 0                                                                                                                                                                                                                                      |
| Recent visits    | `GET /api/recent-visits?from&to&limit=25[&cursor][&pii=reveal]`                 | `data.visits[]` (all fields), `data.nextCursor`, `meta.piiMasked`                                                                  | consent state drives cell state (6.7)                                                                                                                                                                                                                                                                      |

Fire hero, top pages, new vs returning, consent and recent visits in parallel after `/api/meta` resolves. Global concurrency note: the server runs at most 4 queries at once (SPEC 10.3); five parallel requests will queue server-side for a moment. That is fine, but it is one reason for per-panel skeletons rather than a global spinner. Do **not** poll on a timer in v1; "Refresh" is manual.

Time display: always UTC (`timeZone: 'UTC'`), locale from the browser (`undefined`) for number/date formatting, but the month names then follow the locale. Axis and tooltip strings must not exceed 12 chars on the axis.

---

## 12. Implementation notes for Dan

### 12.1 HTML dashboard (priority 1)

- Single file string with `%%DYNALITICS_NONCE%%` on every `<style>` and `<script>` and `<meta name="dynalitics-base" content="%%DYNALITICS_BASE%%">` (SPEC 10.8). Three inline blocks: theme bootstrap script (first, in `<head>`), `<style nonce>`, main `<script nonce>` (end of `<body>`).
- Vanilla JS, one bundle. Size budget (v1.1): the whole HTML string is **<= 45 KB gzipped** (build CI warns above 40 KB, fails above 45 KB) and has a **raw guard of 65 KB** (fails above). Today it is about 20 KB gzipped and 60 KB raw, so there is room; the guards exist to stop regressions. v1.0's per-part caps are retired. Modules as before: `api` (fetch with abort and typed error mapping), `fmt`, `el` (safe DOM factory), `chart`, `panels`, `main`. No dead code.
- State per panel: `{ status: 'loading'|'ready'|'empty'|'error', data, error, reqId }`. A single `render(panel)` swaps content; never rebuild the masthead on data changes.
- SVG: build with `document.createElementNS`; set attributes only; reuse the shared `<defs>` (2.3). Avoid layout thrash: compute geometry first, then append once.
- The static mockup (`design-mockup.html`) contains working drawing code for the line/area, columns and split bars with sample data; it is **design reference**, not production code. Copy the CSS (tokens + component rules) as the starting stylesheet if useful.

### 12.2 React components (priority 2)

Built and documented in `docs/REACT.md` (`dynalitics-dashboard/react`). Same CSS (the HTML stylesheet scoped under `.dy-root`, generated at build time, so the two cannot drift) and the same class names; a parity test compares the DOM of every panel with the HTML dashboard's. Public pieces: `DynaliticsDashboard`, `DynaliticsProvider`, `RangeSelector`, `VisitsOverTime`, `TopPages`, `NewVsReturning`, `ConsentRate`, `RecentVisits` and the `useDynalitics()` hook. Props (as built; v1.1 proposed `range` and `getRequestInit`): `endpoint`, `getRequestInit`, `theme` (`system` | `light` | `dark`), `locale`, `defaultRange`, `onRangeChange`, `landmark`, `className`, `reloadPage`, `fetch`. Differences from the HTML page, all deliberate because it lives inside another page: no URL-hash mirroring (use `onRangeChange` / `defaultRange`), no version in the footer, and `landmark="region"` to avoid a second `<main>`.

### 12.3 Open questions (need an owner's decision, none blocks Dan)

1. **Local time zone**: v1 is UTC-only. Supporting local time properly needs the server to accept a UTC offset for bucketing (Tom). Alex, please decide whether that is wanted post-v1.
2. **"Declined" and "first visit"**: resolved by Alex's decision (denied rows store only page, timestamp and consent=false, so they are `unknown` by construction). The consent and new-vs-returning copy in 6.4/6.6 relies on it; Tom please keep SPEC 8.2 and 10.5 in line.
3. **User id mask shape** (new in v1.1): the UI renders whatever the server sends for `userId` while masked. Tom to state the shape in SPEC 10.6 (QA suggests keep first 2 and last 2 characters, or a short HMAC prefix); the mockup uses `u_***42`.
4. **`unavailable.message` length**: the UI shows it verbatim; Tom to keep it a single English sentence of at most about 160 characters, no markup.
5. **Page-level empty vs "no data ever"**: the API has no "total rows" call, so the empty state cannot distinguish "quiet range" from "never configured" except by trying 90d (the copy handles that with the `[Try 90 days]` action).

---

## 13. Mockup and acceptance checklist

### 13.1 `docs/design-mockup.html`

Single file, no network, sample data embedded. Verified with Playwright screenshots at 320 / 768 / 1024 / 1440, light and dark, plus loading, empty, 403 and unreachable states: no horizontal overflow, no console errors. Known cosmetic gap: at 768 the two side-by-side panels (New vs returning, Consent) wrap the Chart/Table toggle onto a second line; acceptable, or hide the `No. n` eyebrow below 1024. v1.1 additions: re-checked with Playwright screenshots at 320 / 768 / 1024 / 1440 in both themes (see the report with this revision for what was and was not verified). Preview switches in the URL hash (design aid only): `#theme=light|dark`, `#state=ok|loading|empty|forbidden|unreachable|refreshing|unavailable`, `#range=24h|7d|30d|90d`, `#split=none|consent|plan` (`plan` draws five stacked series with direct labels to judge the v1.1 palette). `#range=90d` shows the capped new-vs-returning panel; `#state=unavailable` shows the 8.6 block and the table without the Email and First visit columns. A small "mockup controls" strip at the bottom lists them (not part of the product).

### 13.2 Visual checks for Olivia (run on both themes)

- [ ] 320, 375, 768, 1024, 1440, 1920: no horizontal scroll, no clipped text, no overlapping elements.
- [ ] Hero numeral is legible against the chart at 1024 and 1440 (7.6 rule), and sits above the chart at 320/768.
- [ ] Declined = hatched everywhere (split bar, columns, table chip, legend, tooltip swatch). Unknown = dotted everywhere.
- [ ] Table: declined rows show one "not collected" cell, never `—` and never blank; granted rows with null show `—`.
- [ ] A visitor string like `<img src=x onerror=alert(1)>` or `‮evil` renders as inert text and does not reorder neighbouring cells.
- [ ] Keyboard only: reach every control, arrow through a chart, hear/see live-region text, toggle Chart/Table, load more, focus ring always visible.
- [ ] `prefers-reduced-motion`: no animation at all; `forced-colors`: charts and chips still readable.
- [ ] States: loading (> 200 ms only), empty (each copy), 403 (no retry button), unreachable (retry with cooldown), timeout (offers 7 days), refreshing (old data dimmed).
- [ ] Contrast and colour-blind: `node docs/check-design-tokens.mjs` exits 0 (CI), and matches the `styles.css` token values (diff the two token sets).
- [ ] Range 90d with a mocked `meta.limits.newVsReturningMaxRangeDays = 31`: the new-vs-returning panel shows no error, eyebrow `No. 3 · LAST 31 DAYS`, the cap note, 31 daily columns; the other panels keep the 90-day view. With cap 14, 30d is also capped.
- [ ] `unavailable`: mocked meta with `newVsReturning.available:false` and `fields.email:false` -> calm block (no red, no retry button, `role="status"`), no Email column, no First visit column.
- [ ] `approximate: true` shows the ESTIMATE tag and the caveat note.
- [ ] userId in the table is masked by default (fixture `u_***42`) and plain only after reveal.
- [ ] Hover on a top-pages row: rank and share are `--ink`; hover bar is 30 %.
- [ ] Split by `plan` in both themes: five series distinguishable in a grayscale / deuteranopia emulation (Chrome DevTools "Emulate vision deficiencies"), direct labels readable.
- [ ] Hero numeral test vectors from 7.6.
- [ ] `<html lang="en">`; theme button label is constant and `aria-pressed` toggles; chart has the keyboard hint.
- [ ] Size: HTML string <= 45 KB gzipped and <= 65 KB raw.

---

## 14. Log explorer (v1.2, SPEC section 18)

Added 2026-10-31 at the user's request: "Grafana-type logs and Splunk". It is a second **view** of the same page, not a second page, so the CSP, the base path and the masthead stay as they are.

**D10 (budget).** The explorer adds roughly 25 KB raw and 6 KB gzipped. The binding budget stays **45 KB gzipped**; the raw regression guard moves from 70 KB to **110 KB**. If the page ever needs more, split the explorer into its own nonce'd script served by the handler before raising the gzip budget.

### 14.1 Navigation and URL

- Masthead, between the wordmark and the range control: `<nav aria-label="Views">` with two buttons, **Overview** and **Explorer** (`dy-view-btn`, `aria-current="page"` on the active one). Shown only when `meta.widgets.explorer.available`.
- The hash carries the whole explorer state so a view can be shared: `#view=explorer&range=7d&q=<encodeURIComponent>&split=page&tail=15`. `range=` keeps its old meaning; an Overview hash stays `#range=7d`.
- The range control offers only ranges within `meta.explorer.limits.maxRangeDays` while the explorer is shown (31 days by default: 24h, 7d, 30d). Switching to the explorer from 90d selects 30d and says so in the explorer's live region.

### 14.2 Layout

```
| Overview  Explorer          [24h|7d|30d]            Updated 12:05 UTC [Refresh] [Theme] |
|=========================================================================================|
| SEARCH VISITS                                                                           |
| [ pricing plan:pro -consent:false                              ] [Search]  Syntax ▸     |
| 1 843 matches                                     Split by [None v]   Live [Off v]       |
|-----------------------------------------------------------------------------------------|
| No. 1 MATCHES OVER TIME (columns, 200 px; click a column to zoom)       [Chart|Table]   |
|-----------------------------------------------------------------------------------------|
| No. 2 FIELDS   (facets side by side: auto-fit columns of at least 240 px)               |
| PAGE                    | CONSENT                 | PLAN                                |
|  /pricing    [−]  512   |  true      [−]  1500    |  pro       [−]  21                  |
|  ====                   |  =======                |  ==                                 |
|-----------------------------------------------------------------------------------------|
| No. 3 MATCHING VISITS (full width, sheet; the recent-visits table of 6.7)               |
```

Every explorer block spans the full container width. The results table needs it: its fixed column widths (6.7) leave no room for Page in a narrower column (found in the first screenshot at 1440). DOM order = query bar, histogram, fields, results.

### 14.3 Components

- **Query bar** (`dy-query`): a `<form role="search">` with a visible label "Search visits", a full-width `<input type="search">` in mono 15 px (`spellcheck=false`, `autocomplete=off`), and a `Search` button. A `<details class="dy-syntax">` "Syntax" lists the forms of SPEC 18.2 and the searchable fields from `meta.explorer.fields` (key + type). Enter submits; an unchanged query re-runs.
- **Query errors** (`invalid_query`): under the input, one line in `--ink` with the server's fixed message, then the query text again with the character at `position` wrapped in `<mark class="dy-q-at">` (text nodes only; the query is the user's own input). `aria-invalid="true"` on the input and `aria-describedby` pointing at the message. The panels below keep their previous data and show nothing new (no error blocks for a 400 on the query).
- **Matches line**: `n matches` in mono 13 px from `search` (`matched`). With a zoom active, a chip `Zoomed to 29 Oct (UTC) [Reset zoom]`.
- **Split by** (`dy-select`): None plus every field with `facet: true`. **Live** (`dy-select`): Off, 5 s, 15 s, 30 s; options below `tailMinIntervalMs` are not offered.
- **Histogram** (`p-xhist`, `No. 1`): stacked columns (7.x rules, `drawColumns`), one series "Matches" in `--c-cur` or the split series of 6.3 (`buildSplit`, same colours and patterns). Click or Enter on a column zooms to that bucket: a day bucket becomes that day by hour; hour buckets do not zoom. Table twin as everywhere.
- **Field sidebar** (`p-xfields`, `No. 2`, full width, facets side by side): per facet field a mono caps heading, then up to `facetTop` rows: value (visitor text, wraps), count, a 4 px ranked bar (`--c-cur`), and two buttons: the value itself (adds `key:value`, quoted when needed) and `−` ("Exclude key = value", adds `-key:value`). Then "No value" (dotted swatch, adds `-key:*`, i.e. excludes rows that have one) when `nullCount > 0`, and "Other values" (hatched, not clickable) when `otherCount > 0`. A value containing `"` cannot be expressed in the query language (SPEC 18.2 has no escapes): its buttons are omitted and the row says why in visually hidden text.
- **Results** (`p-xresults`, `No. 3`, sheet): the recent-visits table of 6.7, unchanged, including masking, reveal and Load more. During live tail, rows that were not in the previous poll get `is-new` (3 px `--c-accent` left rule, fades after 10 s with `prefers-reduced-motion` respected) and the live region says "3 new matching visits".

### 14.4 States

- Loading, empty, error and unavailable per panel exactly as section 8. Empty: "No visits match this search." with body "Try fewer words, or a longer range."
- Live tail pauses while `document.hidden` or while any explorer request is in flight, and resumes on the next tick. It never retries a failed tick on its own: an error stops the tail and the Live select returns to Off with the note "Live updates stopped after an error."

## 15. HTTP status and errors (v1.3, SPEC section 20)

Added 2026-11-01 at the user's request: log 4xx and 5xx errors with their reason and "display them accordingly". Everything here appears only when the server reports a status column (`meta.widgets.errors.available`, `meta.fields.status`); a dashboard on a table without one looks exactly as before.

### 15.1 Colour

Status classes are semantic, never categorical (`--cat-*` are not used for them), and colour is never the only signal: the code is always printed.

| Class    | Token          | Light          | Dark           | Badge (`dy-status--*`)                     |
| -------- | -------------- | -------------- | -------------- | ------------------------------------------ |
| 1xx, 2xx | `--c-ok`       | `#8c8472`      | `#7a7360`      | outline in `--ink-2`                       |
| 3xx      | `--c-redirect` | `#b9af99`      | `#4d483b`      | outline in `--ink-2`                       |
| 4xx      | `--c-client`   | `#9a5800`      | `#f0ae4a`      | outline and text in `--c-client`, 10% tint |
| 5xx      | `--c-server`   | = `--c-danger` | = `--c-danger` | solid `--c-server`, text `--surface`       |

The badge carries a visually hidden class name (" server error"), so a screen reader hears "503 server error". Success is deliberately quiet: the eye should go to amber and red.

### 15.2 Errors panel (`p-errors`, No. 5; the table becomes No. 6)

Full width from 720 px. From 1024 px two columns (1.4 : 1): left the KPI, right the lists.

- **KPI**: the failure rate (`totals.rate`) in the KPI numeral with `failed` in `--c-server` when anything failed; one sentence "271 of 2,945 responses failed: 98 server errors (5xx), 173 client errors (4xx). Visits without a stored status are not counted."; the split bar (ok, 4xx, 5xx).
- **Chart**: the stacked columns of 6.x (`bucketChart`) with Succeeded / 4xx / 5xx, legend and table twin in the order 5xx, 4xx, Succeeded; the table twin adds "Failed" (per-bucket rate).
- **Failing pages**: the ranked rows of Top pages without rank and share; count reads `41 · 29 5xx` when any are server errors; the bar is tinted `--c-server` if the page had a 5xx, else `--c-client`.
- **Errors by reason**: badge + reason (mono, visitor text) or "no reason given" (serif italic); same bars. If `reasonsStored` is false, a one-line note under the list says how to start storing them.
- Empty: "No responses with a status yet." / "Pass status to track() after each response; failed requests will appear here."

### 15.3 Elsewhere

- **Recent visits / matching visits**: a Status column after Page (badge, then the reason on line two in mono 12 px; a dash when there is no status). It is not personal, so declined rows show it too. 720–1023 px: rows with a status use five columns (96 / 1fr / 112 / 124 / 96); below 720 px the badge keeps its natural width and the reason follows it on the same line.
- **Split by `statusClass`** (overview hero and explorer histogram): the 15.1 colours with the names "2xx success", "3xx redirect", "4xx client error", "5xx server error".
- **Explorer quick filters** (`dy-xquick`, after Live): three chip buttons, `5xx`, `4xx`, `All errors`, writing `statusClass:5xx`, `statusClass:4xx`, `status:>=400` into the query and searching. `aria-pressed` reflects the current query; pressing the active one clears it.

## 16. Country map (v1.4, SPEC section 21)

Added 2026-11-02 at the user's request, modelled on the map in keynest's admin analytics. The panel exists only when the server reports `meta.widgets.countryMap.available` and `meta.countryMap` (the host set `extendedAnalyticsEnabled: true` and declared a `geo: 'country'` field); otherwise nothing is mounted and nothing is requested.

### 16.1 Placement

`p-geo`, "Where visitors come from", after Errors (No. 5, or No. 6 with Errors); Recent visits moves down one number. Full width from 720 px. From 1024 px two columns (2 : 1): the map left, the list right; below that the list follows the map.

### 16.2 Map

- The shapes come from `/api/world-map` once per page (both forms keep them for the page's lifetime); every range change asks only `/api/countries`.
- Equirectangular, Antarctica left out, in a framed `--surface` box. Countries without visits are `--surface-2` with a `--surface` hairline (`vector-effect: non-scaling-stroke`, so borders stay thin when zoomed).
- **Shading**: four steps relative to the busiest country (`ceil(visits / max × 4)`), `--c-accent` mixed into `--surface-2` at 25 / 50 / 75 / 100 %. In dark mode busier countries are brighter, so the hint says "Stronger colour means more visits", not "darker".
- A shaded country has a `<title>` "Spain: 1,237 visits" (names from `Intl.DisplayNames` in the page locale).
- **Zoom**: a `+` / `−` / reset (`⤢`, only while zoomed) stack top-right, 1.6× per press, 1× to 12×; double-click zooms in; pinch or Ctrl/⌘ + wheel zooms towards the pointer; a plain wheel scrolls the page. While zoomed, dragging pans (`touch-action: none` only then, so at 1× a finger still scrolls the page). The view never leaves the map.

### 16.3 List and clicks

- The 8 busiest countries (flag from the code's letters, name, count, a bar relative to the first row like Top pages), then "Unknown country" (italic serif, hatched bar) when `unknown > 0`, then "+ n more countries".
- **HTML page**: when the explorer is on and lists the geo field, every shaded country (map: `role="button"`, `tabindex="0"`, Enter/Space) and every list row (a button) opens the Explorer with `country:ES`; the unknown row opens it with `-country:*` (no stored code). A drag that ends on a country is not a click. Without the explorer the map and list are read-only and the hint leaves out the click sentence.
- **React**: there is no explorer in the React form yet, so its map and list are always read-only, with exactly the read-only HTML markup (parity scenario `countries-no-explorer`).

### 16.4 States

Loading: a 240 px chart skeleton. Empty ("No visits in this range." / "Countries appear once visits with a country code are recorded."). Unavailable and error states as section 8. A shape whose path is not made of `M`, `l`, `z` and integers, or whose code is not two capital letters, is dropped before it reaches the DOM (SPEC 21.4).

# QA review 2: verification of the finished work

Reviewer: Olivia (QA). Snapshot: **2026-10-31, 02:53Z to 06:40Z** (all times UTC, from `date -u`). Scope: independent verification of Bella's React components, Dan's HTML dashboard, my own `SECURITY.md` and Dan's READMEs against SPEC v0.4.2, and one full run of the unit and integration suites on the real PostgreSQL 17 and MySQL 8.4 containers.

Nothing in this document is taken from the authors' reports. Application code and the authors' files were not edited. No commit, no publishing, no task moved to done.

**Moving target.** Tom and Dan were editing `packages/dynalitics` while I worked. SPEC went from v0.4 to **v0.4.2** during the review (existing-table mode step 1 landed). `src/lock/` did not exist at 06:36Z, so I could not review the lock-layer extraction. I saw no transient red in the suites or gates at the times I ran them (06:35Z to 06:38Z); every earlier red was my own files or an environment problem, both described below.

---

## 1. Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 0     |
| MEDIUM   | 2     |
| LOW      | 6     |

No exploitable defect found. The two MEDIUM items are unproven claims, not bugs: nobody has run the dashboard against the real handler in a browser, and no tool has verified rendered colour contrast.

**What I ran, and the result**

| Check                                                                               | Result (time)                                                                                                                      |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bella's React tests (`test/react`)                                                  | 7 files, **90 passed** (03:04Z)                                                                                                    |
| My new adversarial tests (`packages/dynalitics-dashboard/test/qa/`)                 | 2 files, **60 tests: 53 passed + 7 expected-fail** (06:38Z); 40 React cases, 20 HTML cases                                         |
| Whole dashboard package incl. QA tests                                              | 18 files, 290 passed + 7 expected-fail (05:40Z)                                                                                    |
| Full unit suite with coverage                                                       | 54 files, **1,039 passed + 7 expected-fail**; coverage 94.53% statements, 85.31% branches, 94.48% functions, 96.11% lines (06:35Z) |
| Integration suite (`DYNALITICS_INTEGRATION=1`, real PostgreSQL 17 + MySQL 8.4)      | 8 files, **313 passed, 0 failed** (06:36Z)                                                                                         |
| Leftover objects after the integration run (tables, roles/users, schemas/databases) | **0** in PostgreSQL, **0** in MySQL (baseline before: 0). Containers running afterwards: the same five as before                   |
| `npm run lint`, `format:check`, `typecheck`, `check-release --ci`                   | all PASS at 06:38Z (lint and format failed at 06:37Z because of my own new test files; fixed, see 2.5)                             |
| axe-core 4.14.0 in Chromium (Playwright), React and HTML dashboards                 | **0 violations** in 20 of 24 runs; 1 moderate best-practice finding in the 4 error-state runs (F-05)                               |
| SQL Server                                                                          | **not run** (no server available; CI job `integration (mssql)` has never run)                                                      |

"7 expected-fail" are my tests that document known defects with `test.fails`: they stay green and turn red the day the defect is fixed (then change `test.fails` to `test`).

---

## 2. Findings

### MEDIUM

#### F-01 · MEDIUM · The dashboard has never run against the real handler and a real database

- **Claim:** `README.md` line 5: "the read endpoint (`dynalitics/handler`) and the dashboard have all run against real PostgreSQL and MySQL in local integration tests."
- **Evidence:** the dashboard code (HTML and React) is exercised only against the fixture API `test/fixtures/api.ts` (jsdom). The handler is tested with real PostgreSQL and MySQL (`integration/handler-security.test.ts`, 136 tests) and serves the dashboard HTML string (checked: nonce, CSP, base), but no test executes the dashboard JavaScript against the real handler's JSON. My browser runs (section 3) also used the fixture API.
- **Why it matters:** contract drift between `src/read` and the dashboard parsers (`parseMeta`, `interpretEnvelope`) would go unseen until a user opens the page. The statement in the README is stronger than the evidence.
- **Fix:** one Playwright test: real `createHandler` on a PostgreSQL fixture with tracked rows, the built `dashboard.html` served through it, assert the five panels render real numbers and axe is clean. Until then reword the README: "the handler has run against real databases; the dashboard has run against a mock of its API."

#### F-02 · MEDIUM · No automated tool has verified rendered colour contrast

- **Claim:** DESIGN section 9.4 and the READMEs imply WCAG AA contrast "in both themes".
- **Evidence:** axe-core's `color-contrast` rule returned **0 violations but 2,704 undecidable nodes** over the 24 runs. Reasons (HTML page): SVG text over pattern fills (`imgNode`, 29 per page), overlaps (`bgOverlap`, 7), gradient hatch swatches (`bgGradient`, 6), pseudo-element content (`pseudoContent`, 8), very short text (10). On the React page all 281 undecidable nodes were `pseudoContent`, caused by the full-page grain overlay. With the overlay hidden (QA-only style) the React page matched the HTML page at 60 undecidable nodes, and axe could positively verify **1 node per page**. So "axe found nothing" says nothing about contrast.
- **What does hold:** Bella's `docs/check-design-tokens.mjs` recomputes token pairs and passes ("All checks passed", 06:37Z). I re-verified from the CSS that my earlier counter-cases are fixed: hover bar mix is 30% and row text switches to `--ink` on hover (`styles.css` lines 818 to 823); dark `--rule-strong` is now `#7a7360` (line 71). That is arithmetic on tokens, not a measurement of rendered pages.
- **Fix:** add a rendered-contrast test: screenshot each text element's bounding box and compute the ratio from pixels (or give axe a `?qa` mode with grain and patterns off), and include text drawn over chart patterns. Until then say "token contrast verified, rendered contrast not automatically verified".

### LOW

#### F-03 · LOW · One malformed reply shape can blank the whole React dashboard

- **Evidence:** `packages/dynalitics-dashboard/src/react/panels/VisitsOverTime.tsx:79` runs `data.points.map((p) => parseInstant(p.bucket))` and throws `TypeError: Cannot read properties of null (reading 'bucket')` for `points: [null, …]`. There is no error boundary anywhere in `src/react`. My test `wrong types where numbers or strings are expected …` (`test/qa/react-adversarial.test.tsx`, marked `test.fails`) reproduces the exception during render.
- **Impact:** React unmounts the tree on an uncaught render error with no boundary, so the user sees a blank page instead of one failed panel. I did not demonstrate the blank page in a browser. Reachable only with a malformed API reply (buggy proxy or server), hence LOW; the server-side handler produces well-formed arrays.
- **Fix:** validate `points` at the trust boundary like `parseMeta` does, or wrap each panel in an error boundary that renders the existing "unexpected reply" block.

#### F-04 · LOW · `normalizeBase` (HTML dashboard) accepts `//host` without a dot, and `/a//b`; no exploit path found

- **Evidence (code):** `src/ui/api.ts` `BASE_PATTERN = /^\/[A-Za-z0-9/_-]*$/` and `normalizeBase` strips only trailing slashes. `//evil`, `//localhost`, `//10`, `///x`, `/a//b`, `//a/` all survive. Dotted hosts and ports (`//evil.example`, `//host:8080`) are already rejected because `.` and `:` are not in the character class. The React side adds `safeEndpoint`, which rejects any base containing `//`. Tests: `test/qa/html-dashboard-base.test.ts` (6 `test.fails` cases for the survivors, 14 passing cases for what is rejected).
- **Exploit attempt (real Chromium, about 06:37Z), page served with base `//evil` and a Chromium host-resolver rule mapping `evil` to a second local server that records requests; the host page also set a `session=SECRET-COOKIE` cookie:**

  | Case                           | Requests that reached the other origin | What they carried                                       | Page shows       |
  | ------------------------------ | -------------------------------------- | ------------------------------------------------------- | ---------------- |
  | with the handler's real CSP    | **0** (2 CSP violation messages)       | n/a                                                     | UNREACHABLE      |
  | without any CSP (hypothetical) | 1 (`GET /api/meta`)                    | **no cookie, no Authorization header** (`cookie: null`) | UNEXPECTED REPLY |

  Also with a dotted host plus port (`//127.0.0.1:<port>`) the base normalises to the root and the page talks to its own origin.

- **Why there is no practical exploit:** (1) the base only comes from `<meta name="dynalitics-base">`, written by the handler from a `basePath` that `createHandler` validates and which refuses `//` at creation (`integration/handler-security.test.ts`, "basePath … refused at creation"); an attacker who can alter that meta tag already controls the page. (2) The HTML dashboard has no `getRequestInit`; it sends `credentials: 'same-origin'`, `redirect: 'manual'` and only an `accept` header, so no cookie or token goes cross-origin (also asserted in `test/qa/html-dashboard-base.test.ts`). (3) The CSP `connect-src 'self'` blocks the request in a real browser.
- **React:** a hostile `endpoint` never receives host headers or credentials. 15 hostile values (`//evil`, `///evil`, `https://evil.example`, `http://evil`, `\\evil`, `/\evil`, `/a//b`, `/a/../b`, `/..%2f`, `javascript:…`, `data:…`, `/a b`, `/a?x=1`, `/a#frag`, `//evil.example`) all produced same-origin URLs with a single leading slash while a bearer-token `getRequestInit` was active (`test/qa/react-adversarial.test.tsx`).
- **Recommended severity: LOW (defence in depth).** Fix: make `normalizeBase` itself refuse any `//` (move React's check into it) and flip the 6 `test.fails` cases.

#### F-05 · LOW · axe `heading-order` on the error state of both dashboards

- **Evidence:** 4 of 4 `forbidden` runs (HTML and React, light and dark): rule `heading-order` (moderate, best-practice): `<h3>You can't view analytics.</h3>` follows the page `<h1>` with no `<h2>` in between. No other violation anywhere in 24 runs.
- **Fix:** render the error title as `h2` in the page-level error block (both builds).

#### F-06 · LOW · Statements that became false after SPEC v0.4.2

| Where                                              | Statement                                                                              | Status now                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `README.md` line 5 and line 178                    | `tableMode: 'existing'` "not built yet" / "Not supported yet: tables you already have" | **false (understated):** step 1 is built and tested on PostgreSQL and MySQL (SPEC 17.5, `integration/existing-table.test.ts`) |
| `packages/dynalitics/README.md` line 5             | `tableMode: 'existing'` "not built yet"                                                | same                                                                                                                          |
| `README.md` line 5                                 | "the dashboard has … run against real PostgreSQL and MySQL"                            | **unproven**, see F-01                                                                                                        |
| my `SECURITY.md` (P11, P12, scope, non-guarantees) | existing mode "not built"; P11 read-side `onError`; P12 slot held until settled        | **fixed by me** (see 4)                                                                                                       |
| my `docs/DOCS-OUTLINE.md` section 3                | existing mode "rejected with not supported yet"                                        | **fixed by me**                                                                                                               |

`extraColumns` is still rejected with "not supported yet" (`unit/config-validate.test.ts`); `inspect` is still a stub. Both READMEs are correct about those two. Dan owns the README edits; I did not touch them.

#### F-07 · LOW · An invalid React `endpoint` is silently replaced by the site root

- **Evidence:** `safeEndpoint` returns `''` for anything that is not a plain same-origin path (`src/react/endpoint.ts`), and `docs/REACT.md` documents it. A typo such as `endpoint="https://app.example/admin/analytics"` therefore requests `/api/meta` on the site root with no warning, possibly reaching a different API on that origin.
- **Fix:** log a one-time `console.warn` in development builds when the value is rewritten.

#### F-08 · LOW · The single-file dashboard is still over its design budget

- **Evidence:** `dist/dashboard.html` is **67,684 bytes** (22,764 gzipped) against the 45 KB uncompressed budget in `docs/DESIGN.md` §0.6. The dashboard README no longer states a budget, but DESIGN.md still does and nothing reconciles them. `scripts/check-release.mjs` and the dashboard size test pass at 06:38Z, so the 45 KB figure in DESIGN.md is not enforced by anything.
- **Fix:** Bella decides: raise the budget in DESIGN.md or cut the build.

---

## 3. What I verified (so the list above can be read in proportion)

**React components (`src/react`, `docs/REACT.md`)**

- **XSS sinks:** none. Searched `react/` and `ui/` for `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `srcdoc`, `javascript:` and data-built `href`/`src`; the only `href` is the internal skip link `#main`. Source rules are also enforced by `test/react/security.test.tsx`.
- **Hostile strings:** ten payloads (`<img onerror>`, `"><svg onload>`, `</script><script>`, `javascript:`, SQL, template syntax, bidi override `‮`/`⁦`, NUL and lone surrogate, `__proto__`, `constructor`) in page, username, email, user id, IP, custom keys and values, top-pages and recent-visits render as inert text: 0 `script/iframe/img/svg image` elements, 0 `on*` attributes, 0 non-internal anchors. The right-to-left page string is rendered in its own element with class `v` or `dir="auto"`.
- **Pollution and size:** `__proto__`/`constructor` keys injected into every JSON reply do not pollute `Object.prototype` and do not crash; a 1 MB page string, a 20,000-character username and `1e21` counts render in under 4 s.
- **Meta with missing or wrong fields (9 variants)**, **HTTP 401/403 on meta** (one request only, no Retry button, "NOT AUTHORISED"), **redirected reply**, **opaque redirect**, **200 HTML login page containing a script** (reported as UNEXPECTED REPLY, text never shown, script never executes), **hostile error envelope** (server `message`/`param` never rendered), **hostile `unavailable` message** (inert text).
- **`getRequestInit`:** the host cannot change method, body or redirect mode (always `GET`, no body, `redirect: 'manual'`); our `accept` header wins; a throwing callback yields "not authorised", its error text is never rendered, and **no request is sent at all** (the wrapper answers 401 itself, which is stricter than I first assumed).

**axe-core 4.14.0 (pinned in `/tmp/qa-axe`, nothing added to the repo), Chromium via Playwright 1.64.1, WCAG 2.0/2.1/2.2 A and AA plus best-practice**

- Matrix: {HTML, React} x {light, dark} x {ok, hostile, empty, nvr-unavailable, forbidden} at 1440 px, plus {ok} at 320 px = 24 runs, each in two passes: pass A with the **real CSP enforced** (checks console errors, rendering, horizontal overflow), pass B with CSP bypassed only to inject axe (the CSP itself blocked the injected script on the HTML page).
- Result: **0 violations** in 20 runs, including 320 px, the hostile-data fixture and both themes; no horizontal overflow in any run; `lang="en"` on every page; the only console error in any run was the expected 403 network line. 1 moderate finding (F-05) in the 4 error-state runs.
- **Negative control:** the same pipeline on a deliberately broken page reports `button-name`, `color-contrast`, `document-title`, `heading-order`, `html-has-lang`, `image-alt`, `landmark-one-main`, `region`, so a clean result is not a tooling accident.
- **Limits of this audit:** contrast not verifiable by axe (F-02); keyboard navigation, screen-reader output and `prefers-reduced-motion` were **not** tested in this run; data came from the fixture API (F-01).

**Integration suite:** `fixture-cleanup` (6), `errors-and-cancel` (13), `db` (24), `privacy-security` (78), `handler-security` (136), `read` (34), `existing-table` (14), `scope` (8) = **313 tests, all passing**. Every one runs on PostgreSQL and MySQL only.

---

## 4. Re-check of `SECURITY.md` and the READMEs

Against SPEC v0.4.2 and the code at 06:3xZ:

- **Changed in `SECURITY.md` (mine) this round:**
  - header now cites SPEC v0.4.2;
  - scope: `tableMode: 'existing'` is "built only as step 1"; `extraColumns` and `inspect` remain not built;
  - **P11** narrowed: HTTP bodies and writer-side `onError` are tested; the content of read-side `onError` (`ReadErrorInfo`) is asserted by **no** test (`integration/handler-security.test.ts` collects the errors but asserts nothing about them);
  - **P12** narrowed: cancellation and the 503 on no free slot are tested; "a timed-out read keeps its slot until the driver settles" is **untested** (only `unit/read-handler.test.ts` "concurrency is limited" exists);
  - new non-guarantee for existing mode: SQL Server never run, a non-UTC session with a naive PostgreSQL timestamp untested (the containers run in UTC), `datetimeoffset` is statement text only, and legacy rows may contain personal data that no consent gate saw.
- **Still true and re-checked:** P1 to P10, P13 to P19 (their tests exist and pass in the 06:35Z and 06:36Z runs).
- **Dan's READMEs:** see F-06. Everything else in both READMEs that I audited last round was either fixed or is still correctly worded; I did not re-audit sections unrelated to security.

---

## 5. Environment notes (not defects)

- **Clock jumps and stalls.** Four of my own test runs "took" 9 to 17 minutes (529 s, 855 s, 719 s, 1,010 s) because a single test blocked past its 5 s timeout and the rest failed as collateral ("overlapping act() calls"). The same tests pass in under 1 s alone and in 15 s as a whole when the run finishes inside one tool call; `date -u` readings also jumped by tens of minutes between adjacent commands. I attribute it to the sandbox or host suspending the process while a command was backgrounded, with load from teammates' concurrent full runs (load average up to 7). None of those runs is counted above; the numbers in the summary come from clean foreground runs. If a teammate sees an inexplicable 5 s timeout storm in `test/qa/react-adversarial.test.tsx`, rerun before investigating.
- My QA tests are included in everyone's `vitest run`; they take about 14 s (React file) and 0.3 s (HTML file).
- I pulled nothing into the repo: `axe-core` lives in `/tmp/qa-axe` (exact version `4.14.0`, installed with `--ignore-scripts`), and the Playwright browsers are the ones already cached on this machine.

---

## 6. New files (mine) and how to rerun

- `packages/dynalitics-dashboard/test/qa/react-adversarial.test.tsx` (40 cases)
- `packages/dynalitics-dashboard/test/qa/html-dashboard-base.test.ts` (20 cases)
- `npx vitest run packages/dynalitics-dashboard/test/qa`
- Audit scripts (not in the repo): `/tmp/qa-axe/{server.mjs,run.mjs,contrast.mjs,exploit2.mjs,control.mjs}`; results in `/tmp/qa-axe/results.json`. To keep the audit, move them into `scripts/` with a pinned `axe-core` dev dependency; I did not because adding a dependency is a supply-chain decision for the maintainers.
- Edited by me: `SECURITY.md`, `docs/DOCS-OUTLINE.md` (both mine). Not edited: application code, tests or documents of Dan, Bella and Tom.

## 7. Open items for owners

- **Dan:** README existing-mode statements (F-06); reword F-01; `normalizeBase` (F-04); error-title heading level (F-05, with Bella).
- **Bella:** error boundary or `points` validation (F-03); the budget decision (F-08); rendered-contrast approach (F-02).
- **Tom:** assert read-side `onError` content and the slot-held behaviour so P11 and P12 can regain their full wording; nothing else open from this review.
- **Everyone:** SQL Server is still unverified until the `integration (mssql)` job has run on GitHub.

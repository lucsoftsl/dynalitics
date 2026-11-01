# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

dynalitics: server-side analytics that write one row per visit into the user's **own** SQL database (PostgreSQL, MySQL, SQL Server). Early release (`0.1.0`; all six packages share one version, the adapters peer on the exact core version). npm workspaces monorepo, Node >= 22, ESM, TypeScript.

- `packages/dynalitics` — the server library: `track()` writer, startup schema validation, `dynalitics sql` CLI, and the read endpoint (`dynalitics/handler`). Zero runtime deps and no peer deps; never imports a driver.
- `packages/dynalitics-{postgres,mysql,mssql}` — adapter packages (SPEC v0.5): each depends on exactly one driver (exact pin) and peers on `dynalitics` at the same version; export a frozen `DriverAdapter` (`postgres`/`mysql`/`mssql`) built on `dynalitics/adapter`. The driver code lives here (`src/driver.ts`).
- `packages/dynalitics-consent` — optional consent banner (SPEC v0.7, section 19): plain-DOM `mountConsentBanner`, React `<ConsentBanner>`/`useConsent`, and `consentFromRequest` (`/server`) that turns the `dynalitics_consent` cookie into `track()`'s boolean, failing closed. Never imports `dynalitics`; built with plain `tsc` + `scripts/copy-css.mjs`.
- `packages/dynalitics-dashboard` — browser dashboard that talks only to the read endpoint, never to a database. Ships two forms: a single self-contained HTML page (`dynalitics-dashboard/html`) and React components (`dynalitics-dashboard/react`).

## Source of truth

- `docs/SPEC.md` — architecture and API contract. **If code and SPEC disagree, the SPEC is considered wrong until it is updated first.** Section 10 is the read-handler contract the dashboard builds against.
- `docs/DESIGN.md` (+ `docs/design-mockup.html`) — dashboard visual/component spec; DESIGN.md wins over the mockup.
- `SECURITY.md` — exactly what is stored per consent state; keep it in sync with behaviour.
- `docs/DOCS-OUTLINE.md` rule: any doc statement about behaviour must be backed by a test or say "untested"; any statement about SQL Server must carry the "SQL Server has never run on a real server" banner.
- Not built yet (don't document as working): `extraColumns`, `dynalitics inspect`. `tableMode: 'existing'` is partially built (SPEC v0.4.2, section 17.5).

## Commands

```sh
npm ci                         # .npmrc: ignore-scripts=true, save-exact=true, engine-strict=true
npm run build                  # tsc -b + single-file HTML dashboard + React bundle
npm run lint && npm run typecheck && npm run format:check
npm test                       # unit tests (vitest, root config covers all packages + scripts/)
npm run test:coverage          # enforces 80% lines/functions/branches/statements
npx vitest run packages/dynalitics/test/unit/ip.test.ts   # single file
npx vitest run -t "name of test"                         # single test by name
npm run check:protocol -w dynalitics-dashboard           # vendored protocol.ts must equal server's (--write to sync)
npm run preview -w dynalitics-dashboard                  # dev server: built page + mock API, scenarios at /s/<scenario>/
```

Integration tests (real DBs) live in `packages/*/test/integration` and are excluded unless `DYNALITICS_INTEGRATION=1`:

```sh
docker compose -f docker/compose.yml up -d                 # postgres :55432, mysql :53306 (mssql: --profile mssql, :51433, amd64 only)
DYNALITICS_INTEGRATION=1 npm test                          # defaults to DYNALITICS_TEST_DIALECTS=postgres,mysql
```

Override connections with `DYNALITICS_TEST_PG_URL` / `_MYSQL_URL` / `_MSSQL_URL`. Integration runs serially with long timeouts. Dashboard e2e against the real handler: `DYNALITICS_INTEGRATION=1 PLAYWRIGHT_CORE=/path/to/playwright-core npm run e2e -w dynalitics-dashboard` (Playwright is not a repo dependency).

## Architecture

### Writer path (`packages/dynalitics/src`)

`createDynalitics` (`create.ts`) is async: validate/resolve config (`config/`) → `config.adapter.createDriver()` per credential (`driver/types.ts` holds the `Driver`/`DriverAdapter` contract, exported as `dynalitics/adapter`) → build the **column model** (`model/column-model.ts`, maps logical roles like `timestamp`, `consent`, `pageVisited`, custom fields to physical columns) → compare it against the live table (`startup/compare.ts`, `privileges.ts`, `session-timezone.ts`) and on mismatch throw `DynaliticsSchemaError` containing generated fix SQL (`startup/fix-sql.ts`).

`track()` → `track/build-row.ts` (consent gate, `track/ip.ts` truncate/hash, custom fields, limits) → `queue/pipeline.ts` (bounded background queue, retries, batching). `track()` never throws and never awaits the DB; failures go to `onError` via `report.ts`.

`dialect/` holds per-database SQL generation (quoting, types, placeholders); the adapter packages wrap each client library behind the common `Driver` interface. Tests inject a fake via `test/helpers/fake-driver.ts` and `CreateDeps` (clock, sleep, random, driver factory); `test/helpers/adapters.ts` gives tests the real adapters (`loadAdapters`) or a `stubAdapter(dialect)` for configs. `vitest.config.ts` and `tsconfig.typecheck.json` alias `dynalitics/adapter` to the core source so there is one copy of `DriverError`.

`schema/generate.ts` produces CREATE TABLE/INDEX/GRANT SQL for `dynalitics sql` (`cli/`); it never connects.

### Read path (`src/read`, exported as `dynalitics/handler`)

`createHandler(readerInstance, { authorize, dashboardHtml, ... })`: framework-agnostic handler, adapted with `toNodeListener`. `read/lock/` is the security gate (required `authorize`, base path, serving the HTML with a per-request CSP nonce). `routes.ts`/`params.ts` → `service.ts`/`queries.ts`/`buckets.ts` → `report.ts`; `mask.ts` masks personal values; `capabilities.ts` tells the dashboard which widgets the config supports; `semaphore.ts` limits concurrent queries.

### Wire protocol

`packages/dynalitics/src/protocol.ts` defines the read API types. The dashboard keeps a **vendored copy** at `packages/dynalitics-dashboard/src/protocol.ts` because the dashboard must not depend on the server package. Edit the server copy, then run `check:protocol --write`; CI fails if they differ.

### Dashboard (`packages/dynalitics-dashboard`)

- `src/ui/` — vanilla TS + `styles.css` + `template.html`, bundled by `scripts/build-html.mjs` (esbuild IIFE) into one inline HTML string. Placeholders `%%DYNALITICS_NONCE%%` and `%%DYNALITICS_BASE%%` are filled by the server handler. Must work under `default-src 'none'`: no external URLs (a build test checks), no inline event handlers.
- `src/react/` — React port of the same design; bundled by `scripts/build-react.mjs`, declarations from `tsconfig.react.json` (the main `tsconfig.json` excludes `src/react`). Tests check HTML/React parity.

## Invariants to preserve

- **No DDL at runtime.** No code path creates, alters or drops anything; schema problems throw with SQL for the user to run.
- **Privacy fails closed.** Missing or non-boolean consent = denied; denied rows store only page, timestamp, `consent=false`. Custom fields survive denial only with `personal: false` and `keepWhenDenied: true`. The opt-in `status` / `errorReason` columns (SPEC 20) are also kept on denied rows; `errorReason` must stay a code (charset-limited), never an error message.
- **Errors never leak secrets.** All errors/log output go through `redact.ts`; never include connection strings or passwords.
- Never read `X-Forwarded-For`; the caller passes the trusted IP.
- Supply chain: exact dependency versions, no lifecycle scripts, GitHub Actions pinned to commit SHAs. Releasing is in `docs/RELEASING.md`.
- CI has started running on GitHub (2026-11-01). SQL Server is "TBD": its first real run found a time-format bug (fixed in `dialect/mssql.ts`, not yet confirmed); `dynalitics-mssql` is published by `release.yml` only when `mssql.yml` is green. Releases: every push to `main` that changes a package publishes the next patch (`scripts/release-version.mjs`, docs/RELEASING.md); the workflow never commits.

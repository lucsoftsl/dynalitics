# dynalitics: architecture and API specification

Status: **draft v0.8**. Implemented and tested against real PostgreSQL 17 and MySQL 8.4: the writer (tracking, queue, schema validation, generator/CLI), the read handler and, since v0.4.2, **`existing` table mode step 1** (see 17.5). **Not implemented yet:** `extraColumns`, `dynalitics inspect`, and any run against SQL Server (see section 12). Author: Tom (backend). v0.1 to v0.4 are all dated 2026-10-30. v0.4 adds sections 15 to 17 (module seams, lock-layer extraction plan, existing-table verdict) and changes no behaviour. v0.4.1 corrects statements in section 15 that were checked against the tests. v0.4.2 implements `tableMode: 'existing'` (see the changelog and 17.5).
Audience: everyone building against this (Dan: dashboard and packaging, Bella: dashboard design, Olivia: tests).
Rule for readers: if the code and this document disagree, the document is wrong until someone fixes it here first.

Section 10 (read handler) is the contract the dashboard is built against. Section 14 lists the decisions I made and the points where I disagree with, or am worried about, the brief.

## Changelog

### v0.8 (amends v0.7): HTTP status and errors

Decided by the user on 2026-11-01: dynalitics records the response status and why a request failed, and the dashboard shows errors accordingly. Contract in **section 20**. Additive: both columns are opt-in, existing tables and configs are unchanged, and every new wire field is optional.

| #   | Change                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | Two new **opt-in** roles: `status` (default column `status_code`, integer) and `errorReason` (default `error_reason`, string 64). `columns.<role>` now also accepts `true` = "the default name". Neither is in the recommended table unless asked for. |
| H2  | `Visit` gains `status?: number \| null` (100..599) and `errorReason?: string \| null` (a code matching `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`). Invalid values are stored as `NULL` and reported (`invalid_visit`), never echoed; the visit is kept.        |
| H3  | **Consent:** both are kept on denied rows. They describe the response, not the visitor. SECURITY.md lists this as the third opt-in exception.                                                                                                          |
| H4  | New export `errorReasonOf(err)`: the error's `code`, else its `name`, if code-shaped; never its `message`.                                                                                                                                             |
| H5  | New route `GET /api/errors` (20.4). `/api/meta` gains `widgets.errors` and `fields.status` / `fields.errorReason`. Recent visits and explorer rows carry `status` / `errorReason` when the columns are mapped (keys absent otherwise).                 |
| H6  | Breakdowns and explorer fields `statusClass` (derived `1xx`..`5xx`), `status` (number) and `errorReason` (text, searchable). They come before custom fields and cannot be shadowed by one.                                                             |
| H7  | Dashboard (both forms): an Errors panel, a Status column, semantic colours for a `statusClass` split, explorer quick filters. Specified in DESIGN.md section 15.                                                                                       |

### v0.7 (amends v0.6): consent banner package

Decided by the user on 2026-10-31: dynalitics may ask for consent when the host enables it, with the message as a prop. Contract in **section 19**. The core packages are unchanged: `dynalitics` still only honours the boolean it is given.

| #   | Change                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | New optional package `dynalitics-consent`: a browser banner (plain DOM and React) that asks for consent and stores the answer in a first-party cookie, plus a server helper `consentFromRequest` that turns that cookie into the boolean `track()` takes. |
| K2  | Non-goal "a browser tracking script" stands: the banner never tracks, never sends anything anywhere, and makes no network requests.                                                                                                                       |
| K3  | "No cookies set by this library" becomes: `dynalitics`, the adapters and the dashboard set no cookies; `dynalitics-consent` sets exactly one, `dynalitics_consent`, holding only the visitor's choice, and only after the visitor chose.                  |

### v0.6 (amends v0.5): log explorer

Decided by the user on 2026-10-31: a Grafana/Splunk-style explorer in the dashboard. Full contract in **section 18**. Additive for existing clients: no route, field or meaning changes; `/api/meta` stays `version: 2` and only gains keys.

| #   | Change                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | New routes `GET /api/search`, `GET /api/search/histogram`, `GET /api/search/fields` (18.3). They take a `q` parameter in a small query language (18.2) that the server parses into allow-listed fields and **bound** values. Principle 6 and rule 10.3 are amended accordingly: the request still never supplies SQL, a column name or a sort order. |
| X2  | Only **non-personal** data is searchable or filterable: `page`, `consent`, `isFirstVisit` (write-time column only) and custom fields declared `personal: false`. A personal field in a query is `400 invalid_query` (`unknown_field`), the same answer as a field that does not exist (18.4).                                                        |
| X3  | New error code `invalid_query` (HTTP 400) with `error.reason` (fixed enum) and `error.position` (character offset in `q`). The message is a fixed sentence per reason; the query text is never echoed.                                                                                                                                               |
| X4  | `/api/meta` gains `widgets.explorer` and `explorer` (fields with their capabilities, limits). New handler option `explorer: { enabled?, maxRangeDays? }` (defaults `true`, 31 days).                                                                                                                                                                 |
| X5  | Masking (10.6) applies to `/api/search` results exactly as to `recent-visits`, under the same triple condition.                                                                                                                                                                                                                                      |
| X6  | Live tail is client-side polling of `/api/search` (streaming stays a non-goal), never faster than `explorer.limits.tailMinIntervalMs` (5000).                                                                                                                                                                                                        |

### v0.5 (amends v0.4.2): one adapter package per database

Decided by the user on 2026-10-31. Packaging and API change, no change to SQL, privacy or the read contract.

| #   | Change                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Three new packages: `dynalitics-postgres`, `dynalitics-mysql`, `dynalitics-mssql`. Each has its driver (`pg`, `mysql2`, `mssql`) as a regular, exactly pinned dependency and `dynalitics` as a peer dependency. `npm install dynalitics dynalitics-postgres` installs exactly one driver.                                               |
| A2  | `DynaliticsConfig.dialect` is replaced by `adapter: DriverAdapter` (4.3, 5.2). The dialect is read from `adapter.dialect`. There is no fallback to a string dialect: a missing or foreign `adapter` is a `DynaliticsConfigError`.                                                                                                       |
| A3  | `dynalitics` has no peer dependencies any more and never calls `import()` on a driver. The driver code (`src/driver/{postgres,mysql,mssql}.ts`) moved unchanged into the adapter packages; `importPeer` and the "Install the pg package" message are gone, because a missing adapter is now a missing import in the host's own code.    |
| A4  | New subpath `dynalitics/adapter`: the `Driver`/`DriverAdapter` types, `DriverError`, `toDriverError`, `scrubMessage` and the error helpers, so an adapter can implement the F-02 message policy without reaching into internals. `ADAPTER_API_VERSION` (currently `1`) is checked at config validation; a mismatch names both versions. |
| A5  | `DriverError` is recognised by a `Symbol.for('dynalitics.DriverError')` brand as well as `instanceof`, so an adapter that resolved a second copy of `dynalitics` is still classified correctly (retry, permission hints, error masking).                                                                                                |
| A6  | Unchanged: `dynalitics sql --dialect <d>` and `dynalitics/schema` still take a dialect **name** and need no adapter or driver.                                                                                                                                                                                                          |

### v0.4.2 (amends v0.4.1): `tableMode: 'existing'`, step 1

Code change (sections 3.1, 3.2, 3.9, 7.2, 7.3, 7.6 now describe built behaviour for the parts listed in 17.5). Contract changes:

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `tableMode: 'existing'` is accepted. `columns` is an explicit mapping; `timestamp`, `consent` and `pageVisited` are required (message in 3.1); unlisted roles are not stored. `validateOnStart: 'skip'` with `existing` is a config error. `extraColumns` is still rejected ("not supported yet").                                                                                          |
| E2  | Real string lengths are adopted in existing mode (`min(configured, real)`, unlimited types keep the configured maximum) and logged at info level. This includes `page.maxLength` for the page column. Recommended mode keeps `too_short`.                                                                                                                                                   |
| E3  | `timestamp` columns: PostgreSQL `timestamp` (naive) and, in existing mode only, MySQL `datetime` and SQL Server `datetime2` warn `naive_timestamp`. MySQL `timestamp` is accepted in both modes; at startup `SELECT TIMEDIFF(NOW(), UTC_TIMESTAMP())` runs on each driver in use, and a non-UTC session is the problem `timestamp_session_timezone`.                                        |
| E4  | Boolean roles (`consent`, `isFirstVisit`, promoted booleans) on integer columns: written as 1/0, read as `= 1` (`("col" = 1)` on PostgreSQL). `NULL` consent counts as denied.                                                                                                                                                                                                              |
| E5  | Read queries know the real timestamp type: PostgreSQL naive `timestamp` is converted to an instant before bucketing and formatting; SQL Server `datetimeoffset` is switched to UTC. Filters and ordering keep using the raw column so existing indexes apply.                                                                                                                               |
| E6  | `extra_required_column` message no longer suggests `extraColumns` (not built): `... so every INSERT would fail. Give it a default or make it nullable.` In existing mode the report header says `tableMode "existing"`, a missing mapped column gets no `ADD COLUMN` (it is probably a typo), a missing table does not offer the recommended table, and every printed fix is commented out. |
| E7  | PostgreSQL `citext` is accepted for `ip` and `userId` with the warning `case_insensitive_identity`. The startup info log lists unmapped roles with their effect on the dashboard (3.2). `/api/meta` already derived `widgets`/`fields` from the model, so unmapped roles show up as unavailable without a handler change.                                                                   |
| E8  | `dynalitics sql` still refuses `existing` mode; its message now points to `--grants-only` instead of the unbuilt `inspect`.                                                                                                                                                                                                                                                                 |

Not built in step 1 (deferred, still described as design in 7.2/7.3): integer and `uuid` values for `userId`, `inet` for `ip`, collation/charset warnings (`case_insensitive_identity` for collations, `lossy_charset`), `triggers_present`, `partitioned`, `sequence_grant`, `missing_identity_index`, `extraColumns` (constants and computed), `inspect`. SQL Server cases are written but have never run.

### v0.4.1 (amends v0.4): corrections to section 15 after QA

Documentation only. Olivia found three false statements; I verified each and fixed them: **G14** (a database-level privilege-denial test exists: `integration/db.test.ts`, PostgreSQL and MySQL), **N1** (a CI job for SQL Server exists in `ci.yml` but has never run), **15.2** (`getRequestInit` is built in `src/react`). A re-check of G1 to G14 against the actual assertions also downgraded two claims to "untested" (G10: read-side `onError` content; G11: slot held until the driver settles) and corrected the owner file to the root `SECURITY.md` and the PostgreSQL image to `postgres:17-alpine`. Test fixture: `cleanup()` in `test/integration/support.ts` no longer swallows errors; it retries, serialises role changes within a process and throws if anything is left (test: `integration/fixture-cleanup.test.ts`).

### v0.4 (amends v0.3): ownership seams, extraction plan, existing-table verdict

Documentation only. No code, no wire change, no config change. New sections: **15** (module interfaces and ownership), **16** (extraction plan for the lock layer), **17** (existing tables: feasibility verdict). Section 15.4 is the input for `SECURITY.md` (owner: Olivia): every guarantee names its backing test or says "untested".

### v0.3 (amends v0.2): decisions on QA-REVIEW-1 and the finished read handler

Every change below is a contract change unless it says otherwise. **Dan, Olivia: read the tables.** IDs are QA finding numbers.

**Wire contract of the read API (Dan)**

| #   | Where                                                   | Change                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `%%DYNALITICS_BASE%%` / `<meta dynalitics-base>` (F-07) | The placeholder is now the **normalised** base path: **`''` (empty) for the root**, never `/`; no trailing slash; always matches `^(/[A-Za-z0-9_-]+)*$`. **The client must build `base + '/api/...'` and must treat an empty string as valid.** Before, the root was `/` and produced `//api/meta` (a protocol-relative URL). |
| W2  | `recent-visits.userId` (F-06)                           | **Masked by default**, like the other personal values, with shape `u_***42` (first two and last two characters of ids of at least 6 characters; shorter ids `***`; an id containing `@` is masked as an email). Revealed under the same triple condition as email/username/IP. Render it as received.                         |
| W3  | All masked values (F-12)                                | Masking is total and fails closed: a value that is not exactly an IPv4/IPv6 address, a hash, or one e-mail address comes out as `***` (so `'1.2.3.4, 5.6.7.8'` or `'unknown'` never appear partly). `'@x.com'` is now `***`, not `***@x.com`.                                                                                 |
| W4  | `visits-over-time` breakdown (F-37)                     | A `value: null` series means **"rows without a value for this field"**. It must not be labelled "denied consent". With the strict rule below, rows with denied consent have no custom data at all unless a field opts in with `keepWhenDenied`.                                                                               |
| W5  | Denied rows (F-03)                                      | A row with denied consent now stores **only** page, timestamp and `consent = false`. Custom data (including `personal: false` fields) is no longer kept unless the field declares `keepWhenDenied: true`. Counts by `consent` are unaffected; breakdowns by custom fields will show many more `null` values.                  |
| W6  | Routing (F-17)                                          | Only exact, canonical paths route: `/`, `/api/meta`, ... Anything containing `//`, `.`, `%`, `;`, `?`, a trailing slash or other case is **404** (after `authorize`). `HEAD` and `OPTIONS` are 405.                                                                                                                           |
| W7  | Counts                                                  | Unchanged shape. Internally SQL Server uses `COUNT_BIG`; the API still returns JSON numbers.                                                                                                                                                                                                                                  |
| W8  | Protocol types                                          | **No change** to `protocol.ts` (`npm run check:protocol -w dynalitics-dashboard` still passes).                                                                                                                                                                                                                               |

**Server configuration (host code, Olivia)**

| #   | Option                                      | Change                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `authorize` (F-01)                          | Only `true` or a plain object with `allowed === true` grants access; only `revealPii === true` reveals. Any other return value is **403** and reported as `authorize_invalid_result`. New `authorizeTimeoutMs` (default 5000): a hung `authorize` is **500**, fail closed. |
| C2  | `createHandler` `scope` (F-08)              | New. `scope: { column, value }` (or a list) adds `AND column = <bound value>` to **every** read statement, probes included. Omitting it logs a warning at creation; `scope: 'none'` acknowledges that reading the whole table is intended.                                 |
| C3  | `createHandler` `pii.maskUserId` (F-06)     | New, default `true`.                                                                                                                                                                                                                                                       |
| C4  | `createHandler` `basePath` (F-07)           | `'/'`, or `'/seg/seg'` with at most one trailing slash (dropped). `//x`, `/a//b`, `/a b`, `..` etc. are refused at creation. `handler.basePath` returns the normalised value.                                                                                              |
| C5  | `createHandler` `onError` (F-40)            | Payload is now `ReadErrorInfo { route, status, code, message, cause? }`: no request, headers or query string. `route` is echoed only for known routes.                                                                                                                     |
| C6  | `customFields.<key>.keepWhenDenied` (F-03)  | New, default `false`; requires `personal: false`. Opt-in to keep a field on denied rows.                                                                                                                                                                                   |
| C7  | `page.normalize` (F-14)                     | New host hook mapping a path to a route template (`/users/42` -> `/users/:id`). Runs in host code inside `track()`. A throw is reported and the cleaned path is stored.                                                                                                    |
| C8  | `Visit.consent` non-boolean (F-31, F-03)    | **Stored as `consent = false`** with no personal data and reported as `invalid_visit`, instead of being rejected. `null`/absent behave as before (resolver, then fail closed).                                                                                             |
| C9  | `Visit.userId` (F-32)                       | Strings and finite safe integers only. Anything else is stored as NULL, the visit is kept, `invalid_user_id` is reported.                                                                                                                                                  |
| C10 | `Visit.pageVisited` (F-14)                  | An absolute URL is reduced to its path (scheme, userinfo and host are dropped); a path must start with `/`; `;matrix=params` are removed.                                                                                                                                  |
| C11 | `onError` payloads and driver errors (F-02) | Data/constraint errors carry **no message text**. Permission errors a fixed sentence. Only connection/auth/network/timeout classes keep their (redacted, scrubbed) message. Everything else: `{ name, code }`.                                                             |

**Behaviour that is not configuration**

- **Writes (F-04, F-16, F-30):** a permanent error that would fail every row (permission denied, missing object, read-only) fails the batch once and opens a circuit breaker (1 s doubling to 60 s); only data/constraint errors trigger the row-by-row retry. In `block` mode the number of waiting callers is capped at `queue.maxSize`. Retries are at-least-once: a retried batch can duplicate rows if the first attempt committed (documented, not prevented).
- **Reads (F-05):** the concurrency slot is held until the driver has settled, and the drivers cancel at the deadline (PostgreSQL `pg_cancel_backend` plus destroying the connection; MySQL `MAX_EXECUTION_TIME` hint plus destroying the connection; SQL Server `request.cancel()`). Host-supplied pools get best-effort client-side enforcement only; the host should also set `statement_timeout` / `max_execution_time` on the reader role.
- **Cache (F-15):** at most 200 entries, least recently used evicted first.
- **Text (F-33):** C1 controls, U+2028/2029 and bidi controls/marks are stripped from stored strings in addition to C0.
- **Schema (F-36):** when the table is configured without a schema, the schema the catalog found it in is used for every later statement.
- **MySQL (F-35):** owned pools bound the client-side prepared-statement cache (`maxPreparedStatements: 64`).

**Findings from QA-REVIEW-1 that this version does not fix** (reason in section 14): F-13 (mask in SQL), F-18, F-19, F-20, F-21, F-45 (existing mode / inspect), F-34 partly (`COUNT_BIG` done, driver type parsers not), F-41 (example fixed, no Next.js CI build), F-22 (already validated), F-23 to F-28, F-42 to F-44 (design and plan, not backend).

### v0.2 (amends v0.1)

Three things changed. The first two were delegated to us by the user; the third is a new requirement.

1. **New vs returning is computed at READ time by default** (8.5.1, 10.5, 10.11). The `is_first_visit` column is now optional and absent from the recommended table. The old write-time computation (LRU plus lookup) is opt-in via `firstVisit.enabled` (default `false`, 8.5.2).
2. **Two credentials are the documented default** (4.5): a writer with `INSERT` only (no SELECT) and a reader with `SELECT` only. A single credential still works and logs a warning.
3. **Existing tables are first-class.** Columns are mapped by role (3.1), unmapped optional roles degrade gracefully (3.2), validation is type-tolerant with a compatibility table (7.2), extra columns can get constants or host-computed values (3.6), table names can be schema-qualified (3.7), timestamp semantics are explicit (3.9), and there is a new read-only CLI command `dynalitics inspect` (6.4).

**Read API contract changes (Dan, Olivia). Everything not listed here is unchanged.**

| #   | Where                       | Change                                                                                                                                                                                                                                                                 |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `GET /api/meta`             | `data.version` is now `2`.                                                                                                                                                                                                                                             |
| C2  | Envelope (10.4)             | Every success response now has an `unavailable` field: `null` normally, or `{ reason, message }`, in which case `data` is `null`. This is HTTP 200, not an error. New type `UnavailableReason`.                                                                        |
| C3  | `GET /api/meta`             | New `data.widgets` (per-widget availability and, for new-vs-returning, `source`, `basis`, `approximate`) and `data.fields` (which `recent-visits` fields exist). New `limits.newVsReturningMaxRangeDays` (31). `breakdowns` no longer lists `isFirstVisit` by default. |
| C4  | `GET /api/new-vs-returning` | Computed at read time. `data` gains `source`, `basis`, `approximate`. Range is capped at `newVsReturningMaxRangeDays` (400 `range_too_large`). Can return `unavailable`. `new` now means "the identity's first-ever row is in this bucket".                            |
| C5  | `GET /api/recent-visits`    | `isFirstVisit` is computed per row at read time by default. Fields of unmapped roles are always `null`; `meta.data.fields` says which.                                                                                                                                 |
| C6  | `GET /api/consent-rate`     | A `NULL` consent value (possible in existing tables) counts as `denied`.                                                                                                                                                                                               |
| C7  | `GET /api/visits-over-time` | Breakdown by `isFirstVisit` exists only when the write-time column is enabled and mapped. Otherwise `breakdown=isFirstVisit` is `400 invalid_parameter`.                                                                                                               |
| C8  | Handler options (10.1)      | New `newVsReturning` and `widgets` options. The handler needs a **reader** credential.                                                                                                                                                                                 |
| C9  | Dashboard rules (10.9)      | Three new rules: render `unavailable`, show the `approximate` caveat, drive the UI from `meta.data.widgets` and `meta.data.fields`.                                                                                                                                    |

**Config changes (server side, not wire):** `connection` accepts `{ writer, reader }` and `role` is gone (4.5); `columns` is keyed by **role** and the key `ipAddress` is now `ip` (wire field names in responses are unchanged); new `tableMode` and `extraColumns`; `table` accepts `database.schema.name`; `firstVisit.enabled` defaults to `false`; logger gains `info`.

**Phase 1 implementation deviations** (the server package is now implemented up to the read handler; where code forced a change to this document, it is listed here and fixed inline):

1. `ColumnDef` gained `nullable` (3.4); it had been dropped from v0.1 by mistake and the DDL and `not_nullable` check need it.
2. `Dynalitics.model` is a plain `ColumnModel` and `Dynalitics.table` exists; `ResolvedModel` arrives with `existing` mode (phase 2).
3. MySQL indexes are emitted as separate `CREATE INDEX` statements instead of inline `KEY` clauses (6.3), so all three dialects print indexes the same way.
4. MySQL `TIMESTAMP` role columns are a `type_mismatch` in phase 1 (7.2 accepted them when the session is UTC); that check belongs with `existing` mode.
5. Not implemented yet (phase 2, all best-effort warnings): `triggers_present`, `partitioned`, `sequence_grant`, `missing_identity_index`, `case_insensitive_identity`, `lossy_charset`, `citext`/`uuid`/`inet` column types. `tableMode: 'existing'`, `extraColumns` and `dynalitics inspect` give a clear "not supported yet" message.
6. `queue.retry.attempts` means total attempts (1 = no retry). `ip.salt` is also registered as a secret with the redactor.
7. SQL Server: per-query `timeoutMs` is not applied (the driver only supports a pool-level `requestTimeout`, 30 s for pools dynalitics creates); PostgreSQL uses a per-query `query_timeout`, MySQL a per-query `timeout`.
8. `consent: null` is treated like an absent consent (resolver, then fail closed). A non-boolean, non-null value is no longer rejected: since v0.3 it is stored as `consent = false` and reported (C8).
9. SQL Server could not be exercised on the development Mac: the amd64 image aborts under Docker's QEMU emulation (`sqlservr: Invalid mapping of address ... in reserved address space`). The MSSQL dialect, driver wrapper and the integration tests are written and unit-tested with mocks, but have never run against a real SQL Server; `ubuntu-latest` CI is the first real run (12).
10. The compose file uses `postgres:17-alpine` and the `sa`/`root`/admin passwords there are throw-away test values; the integration helper falls back to them when the `DYNALITICS_TEST_*_URL` variables are unset.

**Read handler deviations** (implemented in `packages/dynalitics/src/read/`; examples in `docs/read-api-examples.md`):

1. `top-pages` `share` is rounded to 3 decimals, so the 10.5 example value `0.349` for 280/801 is really `0.35`; the example is corrected.
2. `DynaliticsHandler` has a `basePath` property (the adapters use it to strip the mount path), and `HandlerOptions` accepts `onError` (defaults to the instance's `onError`).
3. `new` is clamped to `identified` and `returning`/`unknown` to non-negative values, so `new + returning + unknown` always equals the bucket total even if rows arrive between the three queries.
4. `recent-visits` also returns promoted custom-field columns (declared fields only), not just the JSON column.
5. A request that cannot get a query slot within `limits.timeoutMs` is `503 unavailable`; a database timeout is `504 timeout`; any other driver error is `503`. All are generic, and the underlying (redacted) cause goes to `onError`.
6. New package exports: `dynalitics/handler` (`createHandler`, `toNodeListener`, `toFetchHandler`) and `dynalitics/protocol` (types only; `src/protocol.ts` is byte-identical to the dashboard's vendored copy, checked by `check:protocol`).
7. **QA review fixes** (first pass, docs/QA-REVIEW-1.md). **Superseded by v0.3 above**, which is authoritative: `userId` is now masked by default (not only when it contains `@`), non-boolean consent is stored as denied (not rejected), and `basePath` accepts one trailing slash (normalised away).
8. **Driver error messages (F-02).** Superseded by v0.3 (see 5.2): the policy is now by error class and covers more than data/constraint errors.
9. **Open items after the first QA pass.** Superseded: F-05, F-08 and F-03 are addressed in v0.3 (F-03's compute wiring and F-08's writer-side constant wait for `extraColumns`); see the decision log in section 14.
10. The read handler reaches the reader driver through an internal registry (`src/internals.ts`), not through the public `Dynalitics` type.

**Unchanged:** routes list, authorize-first ordering, strict parameters, masking rules, error codes and HTTP statuses, HTML placeholders, CSP, zero filling.

---

## 1. Purpose, principles, non-goals

dynalitics logs page-visit analytics into **the host application's own SQL database** and can show them in a dashboard. There is no dynalitics server, cloud or account.

Principles (each one drives concrete rules later in the document):

1. **Minimal supply chain.** `dynalitics` has **zero runtime dependencies** and no peer dependencies. Each database has its own adapter package (`dynalitics-postgres`, `dynalitics-mysql`, `dynalitics-mssql`) that depends on exactly one driver, so a host installs only the driver it uses (v0.5, A1). Dev tooling never ships.
2. **Least privilege, no DDL.** The writer path only runs `INSERT` (no SELECT) and the reader path only `SELECT`, against **one table** (4.5). It never creates, alters or drops anything. Missing structure is reported with the exact SQL to run, printed and never executed.
3. **One source of truth for columns.** A single `ColumnModel` drives the schema generator, the row builder, the startup validator and the read queries. Nothing else hard-codes a column.
4. **Privacy fails closed.** No consent means no personal data is stored. Missing consent information is treated as "no consent". PII is masked on read by default.
5. **Analytics must never hurt the host.** `track()` never throws and never waits on the database. Failures go to `onError`.
6. **No client-controlled SQL.** The read API has a fixed set of queries. Requests can only choose names from allow-lists; every value a request supplies (including the explorer's search terms, 18.2) is a bound parameter.

Non-goals (v1): creating or migrating tables; data deletion/erasure/retention (the host's job, see 11 and 13); a browser tracking script or ingestion endpoint; real-time streaming; multi-table or multi-tenant layouts; ORMs; MariaDB/SQLite/Oracle.

---

## 2. Packages and folder layout

npm workspaces monorepo. Node `>=22`, TypeScript, ESM only (Node 22.12+ can still `require()` ESM), MIT.

```
dynalitics/                         (workspace root, private)
├─ package.json  .npmrc  tsconfig.base.json  tsconfig.json (project refs)
├─ tsconfig.typecheck.json  eslint.config.js  .prettierrc.json  vitest.config.ts
├─ docs/SPEC.md
├─ docker/compose.yml               (test databases, section 12)
└─ packages/
   ├─ dynalitics/                   (server only; zero runtime deps)
   │  ├─ package.json               exports: ".", "./schema", "./handler", "./protocol", "./adapter"; bin: dynalitics
   │  ├─ src/
   │  │  ├─ index.ts                public API: createDynalitics, types, errors
   │  │  ├─ config/                 schema.ts (declarative description), validate.ts (tiny validator), defaults.ts
   │  │  ├─ model/                  column-model.ts, types.ts (logical types), identifiers.ts (pattern + quoting helpers)
   │  │  ├─ dialect/                postgres.ts, mysql.ts, mssql.ts   (pure SQL text, NO driver imports)
   │  │  ├─ driver/                 types.ts (Driver, DriverAdapter, DriverError, F-02 message policy)   -> "dynalitics/adapter"
   │  │  ├─ schema/                 generate.ts (DDL, indexes, grants), index.ts   -> "dynalitics/schema"
│  │  ├─ startup/                introspect.ts, resolve.ts (ResolvedModel), compare.ts, privileges.ts, fix-sql.ts, inspect.ts (shared with the inspect command)
│  │  ├─ track/                  build-row.ts (pure), consent.ts, ip.ts, extra-columns.ts, first-visit.ts (OPT-IN write-time LRU + lookup), limits.ts
   │  │  ├─ queue/                  queue.ts, writer.ts (batching, retry, backoff)
   │  │  ├─ read/                   handler.ts, routes/*.ts, queries/*.ts, mask.ts, adapters/{node,fetch}.ts, csp.ts
   │  │  ├─ protocol.ts             wire types of the read API, type-only  -> "dynalitics/protocol"
   │  │  ├─ redact.ts  errors.ts  logger.ts
│  │  └─ cli/                    sql.ts (never connects), inspect.ts (read-only, credential from an env var)
   │  └─ test/                      unit/  contract/  integration/  security/
   ├─ dynalitics-postgres/          (adapter: depends on pg; peer: dynalitics)      src/index.ts, src/driver.ts
   ├─ dynalitics-mysql/             (adapter: depends on mysql2; peer: dynalitics)  src/index.ts, src/driver.ts
   ├─ dynalitics-mssql/             (adapter: depends on mssql; peer: dynalitics)   src/index.ts, src/driver.ts
   └─ dynalitics-dashboard/         (browser only; never imports pg/mysql2/mssql or `dynalitics` at runtime)
      ├─ src/html/                  self-contained dashboard (built to ONE html string file)
      ├─ src/react/                 React components (phase 2; react is an optional peer)
      └─ src/client/                fetch client for the read API
```

Subpath exports keep driver-free code importable without loading anything else: `dynalitics/schema` (generator), `dynalitics/protocol` (types) and `dynalitics/adapter` (adapter contract) import no driver and no network code. `dynalitics` itself never imports `pg`, `mysql2` or `mssql`; only `packages/dynalitics-<db>/src/driver.ts` does, with a static import, and only the host's choice of adapter package decides which driver is installed and loaded (v0.5).

How the dashboard HTML gets to the browser is in section 10.8: `dynalitics-dashboard` exports the HTML as a string, the host passes it to the handler. The server package never depends on the dashboard package.

---

## 3. Column model (single source of truth)

### 3.1 Roles, mapping and table modes

dynalitics talks about **roles**; the config maps each role to a physical column name. The same mapping drives the generator, the row builder, the startup validator and the read queries.

| role            | required | holds                                                                        | personal?      |
| --------------- | -------- | ---------------------------------------------------------------------------- | -------------- |
| `timestamp`     | **yes**  | UTC instant of the visit                                                     | no             |
| `consent`       | **yes**  | whether consent was given. Required so that a refusal can always be recorded | no             |
| `pageVisited`   | **yes**  | the page (path)                                                              | no\*           |
| `ip`            | no       | visitor address, stored per `ip.mode`                                        | **yes**        |
| `userId`        | no       | host's user identifier                                                       | **yes**        |
| `username`      | no       |                                                                              | **yes**        |
| `email`         | no       |                                                                              | **yes**        |
| `custom`        | no       | JSON column for declared custom fields that are not promoted                 | per key        |
| `isFirstVisit`  | no       | write-time first-visit flag. Only used when `firstVisit.enabled` (8.5.2)     | yes (derived)  |
| `id`            | no       | surrogate key, never written. Used for cursor paging and tie-breaks          | no             |
| _(field name)_  | no       | a **promoted** custom field (3.5) stored in its own column                   | per field      |
| _(column name)_ | no       | an **extra column** (3.6) filled with a constant or a host-computed value    | per definition |

\*Query strings can carry personal data or tokens, so they are stripped by default (8.4).

`tableMode` decides what an omitted role means:

- **`'recommended'`** (default): the table was (or will be) created from the generator. Every role not set to `false` maps to its default physical name (3.3). `isFirstVisit` is the exception: it is mapped only when `firstVisit.enabled` is true.
- **`'existing'`**: the user's own table. `columns` is an **explicit** mapping; any role not listed is **unmapped**.

```ts
// An existing SQL Server table:  import { mssql } from 'dynalitics-mssql';
{
  adapter: mssql,
  connection: { writer: { connectionString: process.env.WRITER_URL! }, reader: { connectionString: process.env.READER_URL! } },
  table: 'dbo.page_views',
  tableMode: 'existing',
  columns: {
    timestamp: 'viewed_at_utc',   // required
    consent: 'gdpr_ok',           // required
    pageVisited: 'url',           // required
    userId: 'account_id',
    ip: 'remote_addr',
    id: 'view_id',
    email: false,                 // explicitly not stored (same effect as omitting it in 'existing' mode)
  },
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, column: 'plan_code' } },
  extraColumns: {
    tenant_id: { type: 'integer', constant: 7 },                      // also scopes every read query (3.6)
    session_hash: { type: 'string', compute: (v) => hashSession(v) },  // runs in host code (3.6)
  },
}
```

Config-time rules (all violations are collected and thrown together as `DynaliticsConfigError`):

- `timestamp`, `consent` and `pageVisited` are required in `existing` mode and can never be `false`. Message: `columns.consent is required when tableMode is "existing" (timestamp, consent and pageVisited must be mapped).`
- Two roles, promoted fields or extra columns may not map to the same physical column (compared case-insensitively). Message: `columns.email and columns.username both map to "contact"; each role needs its own column.`
- `custom` unmapped (or `false`) while a declared custom field is neither promoted nor removed: `customFields.plan is not promoted to a column and no JSON column is mapped. Set customFields.plan.column or map columns.custom.` Undeclared fields are never stored anyway (3.5).
- `isFirstVisit` mapped but `firstVisit.enabled` is false: `columns.isFirstVisit is mapped but firstVisit.enabled is false. Enable write-time first-visit detection or unmap the column.` The reverse is also an error: `firstVisit.enabled needs columns.isFirstVisit and at least one of columns.userId, columns.ip.`
- `firstVisit.enabled` makes the **writer** path run SELECTs (8.5.2), so it needs column-level SELECT on the identity columns for the writer credential. dynalitics cannot know the grants at config time; a failing lookup shows up at runtime as `lookup_failed` (7.5 explains the hint). This is the price of write-time detection and one reason it is off by default.

### 3.2 What happens when an optional role is unmapped

1. **The data is not stored.** Visit fields for an unmapped role are ignored (not validated, not an error, not written), regardless of consent.
2. **A startup info log lists what is not stored**, once per start, through `logger.info`:
   `dynalitics: these roles are not mapped to a column, so this data is NOT stored: ip, email. Affected dashboard widgets: new-vs-returning (identity falls back to userId only). Map them in config.columns, or ignore this notice.`
3. **Dashboard widgets that need the role degrade, they do not fail** (`unavailable` in 10.4, `widgets` in 10.5):

| unmapped role       | effect                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ip`                | new-vs-returning uses `userId` only. If `userId` is also unmapped: `unavailable` with reason `no_identity_column`. `recent-visits.ipAddress` is `null`.                                    |
| `userId`            | new-vs-returning uses `ip` if allowed (8.5.1), else `unavailable`. `recent-visits.userId` is `null`.                                                                                       |
| `username`, `email` | the `recent-visits` field is always `null`.                                                                                                                                                |
| `custom`            | custom fields must all be promoted (config error otherwise, 3.1). Breakdowns work only for promoted fields.                                                                                |
| `isFirstVisit`      | nothing: read-time computation does not need it. `breakdown=isFirstVisit` is not offered.                                                                                                  |
| `id`                | `recent-visits` returns one page: `id` is `null` on every row and `nextCursor` is always `null`. Ties on `timestamp` have no defined order; the first-visit tie-break uses timestamp only. |

`visits-over-time`, `top-pages` and `consent-rate` only need the three required roles, so they are always available.

### 3.3 Standard roles and defaults (recommended table)

| role           | default physical name | logical type | null?    | notes                                                                                                     |
| -------------- | --------------------- | ------------ | -------- | --------------------------------------------------------------------------------------------------------- |
| `id`           | `id`                  | id           | NOT NULL | DB-generated. Can be disabled with `columns.id = false`.                                                  |
| `timestamp`    | `visited_at`          | timestamp    | NOT NULL | Written by the package at `track()` time (UTC), **not** at insert time, so queue delay does not shift it. |
| `consent`      | `consent`             | boolean      | NOT NULL |                                                                                                           |
| `pageVisited`  | `page_visited`        | string(512)  | NOT NULL | Length via `page.maxLength`.                                                                              |
| `ip`           | `ip_address`          | string(64)   | NULL     | 64 fits a SHA-256/HMAC hex digest and any IPv6 text.                                                      |
| `userId`       | `user_id`             | string(128)  | NULL     | Numbers are converted to strings.                                                                         |
| `username`     | `username`            | string(128)  | NULL     |                                                                                                           |
| `email`        | `email`               | string(320)  | NULL     | Stored as given (no hashing in v1).                                                                       |
| `custom`       | `custom`              | json         | NULL     | Holds declared custom fields that are not promoted.                                                       |
| `isFirstVisit` | `is_first_visit`      | boolean      | NULL     | **Only created when `firstVisit.enabled` is true.** NULL when there is no consent.                        |

Physical names default to snake_case (PostgreSQL folds unquoted camelCase, which makes hand-written queries painful). The default name for `timestamp` is `visited_at` because `timestamp` is a type keyword in all three dialects; it is still quoted everywhere and can be renamed back with `columns.timestamp = 'timestamp'`. In recommended mode `columns.email = false` means the generator omits the column and nothing is stored.

### 3.4 Model types

```ts
export type Role =
  | 'timestamp'
  | 'consent'
  | 'pageVisited' // required
  | 'ip'
  | 'userId'
  | 'username'
  | 'email'
  | 'custom'
  | 'isFirstVisit'
  | 'id'; // optional

export type LogicalType =
  | { kind: 'id' } // DB-generated integer key
  | { kind: 'timestamp' } // UTC, millisecond precision
  | { kind: 'boolean' }
  | { kind: 'string'; maxLength: number }
  | { kind: 'integer' } // 64-bit
  | { kind: 'number' } // double precision
  | { kind: 'json' };

export interface ColumnDef {
  readonly role: Role | 'promoted' | 'extra';
  readonly key: string; // role name, custom field name, or extra column name
  readonly name: string; // physical column name, already validated against the identifier pattern (3.7)
  readonly type: LogicalType;
  readonly personal: boolean; // drives consent stripping, SQL comments, GRANT comments, masking
  readonly nullable: boolean; // what the column model requires of the DB column (needed for DDL and the not_nullable check)
  readonly dbGenerated: boolean; // true only for `id`: never inserted
}

export interface ColumnModel {
  readonly table: TableRef;
  readonly mode: 'recommended' | 'existing';
  readonly columns: readonly ColumnDef[]; // mapped columns, in DDL order
  readonly insertColumns: readonly ColumnDef[]; // minus dbGenerated, in insert order (includes extra columns)
  readonly unmappedRoles: readonly Role[]; // drives the startup info log and widget availability
  readonly customFields: ReadonlyMap<string, ResolvedCustomField>;
  readonly extraColumns: ReadonlyMap<string, ResolvedExtraColumn>;
  readonly identity: { userId?: ColumnDef; ip?: ColumnDef }; // for first-visit (read-time and write-time)
  readonly scope: readonly { column: ColumnDef; value: SqlValue }[]; // constants with scope:true, applied to EVERY read query
}

/** ColumnModel plus what introspection learned. This is what the writer and the handler use. */
export interface ResolvedModel extends ColumnModel {
  readonly encodings: ReadonlyMap<string, ValueEncoding>; // per column: how a value is bound/read for the real DB type
  readonly effectiveMaxLength: ReadonlyMap<string, number>; // existing mode: min(configured, real column length)
  readonly capabilities: Capabilities; // which widgets/fields are available and why not (feeds /api/meta)
}
export type ValueEncoding =
  | 'bool'
  | 'int01'
  | 'text'
  | 'integer'
  | 'uuid'
  | 'inet'
  | 'json'
  | 'ts-utc-instant' // timestamptz, datetimeoffset: ISO with Z / +00:00
  | 'ts-utc-wall'; // naive columns: UTC wall-clock value without zone

export declare function buildColumnModel(schema: SchemaConfig): ColumnModel; // pure, throws DynaliticsConfigError
```

`SchemaConfig` is the subset of the config that affects table shape: `table`, `tableMode`, `columns`, `customFields`, `page.maxLength` and `firstVisit.enabled`. It contains **no secrets and no functions** (so no `extraColumns`), which lets the CLI read it from a JSON file (section 6).

### 3.5 Custom fields

```ts
customFields: {
  plan:     { type: 'string',  maxLength: 32, personal: false, breakdown: true },   // stays in JSON column
  locale:   { type: 'string',  maxLength: 16, personal: false, column: true },      // promoted to real column `locale`
  campaign: { type: 'string',  maxLength: 64 },                                     // personal defaults to TRUE
}
```

- **Custom fields must be declared** (always on in v1). Undeclared keys on a visit are dropped and reported once per key per minute via `onError` (`unknown_custom_field`). Reasons: bounded size, a `personal` flag per key, and an allow-list for dashboard breakdowns.
- `personal` defaults to **true** (safe default). `breakdown: true` is only valid with `personal: false`. **`keepWhenDenied: true` (default `false`) is the only way a field survives a denied row**, and it also requires `personal: false` (F-03). Without it, a denied row stores nothing but page, timestamp and `consent = false`.
- `column: true | '<name>'` **promotes** the field to a real column (`true` = same name as the key). A promoted field is stored **only** in its real column, never duplicated in the JSON. In `existing` mode this is how custom data reaches a table that has no JSON column.
- Custom values are scalars only: `string | number | boolean | null`. No nested objects/arrays, so there is no JSON depth to attack.
- Custom key pattern: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, and `__proto__`, `constructor`, `prototype` are rejected. Host maps are built with `Object.create(null)`/`Map`, and `Object.hasOwn` is used for lookups.

### 3.6 Extra columns: constants and computed values

For columns of the user's table that are not one of our roles but should still be filled (a tenant id, a site id, a hash of something):

```ts
type ScalarType = 'string' | 'integer' | 'number' | 'boolean';
export type ExtraColumnDef =
  | { type: ScalarType; maxLength?: number; constant: CustomValue; scope?: boolean } // scope default: true
  | {
      type: ScalarType;
      maxLength?: number;
      compute: (visit: Readonly<Visit>) => CustomValue; // runs in host code
      personal?: boolean; // default: true
    };
// config: extraColumns?: Record<string /* physical column name */, ExtraColumnDef>
```

- **Constant**: written on every row, **including rows without consent** (it is configuration, not visitor data). With `scope: true` (default) the constant is also added as `AND "tenant_id" = <bound value>` to **every read query** (aggregates, first-visit probes, `recent-visits`), so a table shared by several sites/tenants only shows this one's rows. Set `scope: false` only if you really want the dashboard to see everything. Scoping comes from config, never from the request.
- **Computed**: `compute(visit)` is **host code that runs inside `track()`**, synchronously, with the host's full privileges. dynalitics does not sandbox it, time-limit it or retry it. It must be fast, pure and side-effect free. Its return value is validated like any custom value (type, `maxLength`) and then bound as a parameter, never interpolated. If it throws, returns the wrong type or is too long: the value becomes `NULL` and `onError(compute_failed)` fires; if the DB column is `NOT NULL` the event is **rejected** instead. **Under denied consent (F-03) a compute function receives only a reduced view**, `DeniedVisitView = { pageVisited, consent: false, custom }`, where `custom` holds only the `keepWhenDenied` fields; it never sees `ip`, `userId`, `username` or `email`. This is enforced in the type (a `personal: false` function is typed to take `DeniedVisitView`) and by a property test of `deniedView()` (implemented in `src/track/denied-view.ts`; the wiring into `extraColumns` lands with that feature). A `personal: true` function is not called at all when consent is denied and `NULL` is written.
- Extra columns are never returned by the read API and cannot be breakdown dimensions.
- Column name rules and uniqueness are the same as for roles. The column must exist (startup check). An extra column that is `NOT NULL` without default and **not** listed here is the startup error from 7.3.

### 3.7 Table names and identifiers

```ts
export interface TableRef {
  database?: string;
  schema?: string;
  name: string;
}
table: 'page_views' |
  'dbo.page_views' |
  'mydb.dbo.page_views' |
  { schema: 'analytics', name: 'page_views' };
```

- String form is split on `.` (at most 3 parts) and each part is validated on its own. Object form is validated the same way.
- **PostgreSQL**: `name` or `schema.name`. `database` is rejected (cross-database queries do not exist). **MySQL**: `name` or `schema.name`, where "schema" means the **database**. `database` is rejected, use `schema`. **SQL Server**: `name`, `schema.name` or `database.schema.name`; with a `database` part, introspection reads that database's catalog views (`[db].sys.*`).
- Omitted schema: PG `current_schema()`, MySQL `DATABASE()`, SQL Server `SCHEMA_NAME()`. The resolved name is printed in the startup info log. Recommendation: always set it explicitly.
- **Strict identifier validation is unchanged and applies to every part and every column name**: `^[A-Za-z_][A-Za-z0-9_]{0,62}$`. Identifiers are only ever used after that check, quoted per dialect with escape-doubling.
- Consequence for existing tables (stated plainly): names with spaces, hyphens, `$`, `#`, a leading digit, non-ASCII letters, or longer than 63 characters are **not supported in v1**. Error: `Identifier "Page Views" is not supported. Allowed: letters, digits and underscore, starting with a letter or underscore, at most 63 characters. Create a view or rename the object.`
- PostgreSQL compares quoted names **exactly**: config `UserId` does not match a column created unquoted as `userid`. MySQL and SQL Server match case-insensitively. Mapping errors mention this.

### 3.8 Types in the recommended table

| logical   | PostgreSQL                                        | MySQL (8.0+)                                              | SQL Server (2017+)                                               |
| --------- | ------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| id        | `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT` + `PRIMARY KEY` | `BIGINT IDENTITY(1,1)` + `PRIMARY KEY`                           |
| timestamp | `timestamptz`                                     | `DATETIME(3)` (stored as UTC)                             | `DATETIME2(3)` (stored as UTC)                                   |
| boolean   | `boolean`                                         | `TINYINT(1)`                                              | `BIT`                                                            |
| string(n) | `varchar(n)`                                      | `VARCHAR(n)` (table charset `utf8mb4`)                    | `NVARCHAR(n)`                                                    |
| integer   | `bigint`                                          | `BIGINT`                                                  | `BIGINT`                                                         |
| number    | `double precision`                                | `DOUBLE`                                                  | `FLOAT(53)`                                                      |
| json      | `jsonb`                                           | `JSON`                                                    | `NVARCHAR(MAX)` + `CHECK (custom IS NULL OR ISJSON(custom) = 1)` |

Collation: identity and page columns must compare **case-sensitively**, otherwise `U_42` and `u_42` are one user and `/About` and `/about` are one page. PostgreSQL does this by default. The generator emits `utf8mb4_bin` for the MySQL table and `COLLATE Latin1_General_100_BIN2` on `user_id`, `ip_address`, `page_visited` for SQL Server. Existing tables are accepted as they are; case-insensitive identity columns produce a warning (7.3).

### 3.9 Timestamp semantics (recommended and existing columns)

The package never relies on driver or session time-zone conversion. It **writes the track-time instant in UTC** and **reads every timestamp back as text that it parses as UTC**; aggregated buckets are produced by SQL as text too (`to_char`, `DATE_FORMAT`, `CONVERT(varchar...)`). Host-supplied pools with odd time-zone settings therefore cannot skew data. What that means per column type:

| column type                             | what is written                                                                             | how it is read                                   | requirement / caveat                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PG `timestamptz`                        | ISO `2026-10-30T12:01:44.120Z`, an exact instant                                            | `col AT TIME ZONE 'UTC'` formatted as text       | none. Preferred.                                                                                                                                                                              |
| PG `timestamp` (naive)                  | the same literal; PG ignores the `Z` for naive columns, so the **UTC wall clock** is stored | formatted as text, interpreted as UTC            | **warning `naive_timestamp`**: existing rows written by other code in local time will appear shifted in the dashboard. Only use if the column is UTC.                                         |
| MySQL `DATETIME(n)`                     | `2026-10-30 12:01:44.120` (UTC wall clock)                                                  | `DATE_FORMAT`, interpreted as UTC                | same naive warning. `n < 3` truncates milliseconds (warning `low_precision_timestamp`).                                                                                                       |
| MySQL `TIMESTAMP(n)`                    | UTC wall-clock string, which MySQL converts using the **session** zone                      | converted back using the session zone            | the session zone must be UTC. Checked at startup (`SELECT TIMEDIFF(NOW(), UTC_TIMESTAMP())`); otherwise **problem `timestamp_session_timezone`** (7.3). Never fixed by dynalitics (no `SET`). |
| SQL Server `DATETIME2(n)`               | `2026-10-30T12:01:44.120` (UTC wall clock, no zone)                                         | `CONVERT(varchar, col, 126)`, interpreted as UTC | naive warning as above.                                                                                                                                                                       |
| SQL Server `DATETIMEOFFSET`             | `2026-10-30T12:01:44.120+00:00`                                                             | `col AT TIME ZONE 'UTC'` formatted as text       | none.                                                                                                                                                                                         |
| SQL Server `DATETIME`, `SMALLDATETIME`  | as `DATETIME2`                                                                              | as `DATETIME2`                                   | **warning `low_precision_timestamp`**: `DATETIME` rounds to .000/.003/.007, `SMALLDATETIME` to the minute.                                                                                    |
| `date`, `time`, epoch integers, strings | not supported in v1                                                                         | -                                                | **problem `type_mismatch`**. A date has no time of day; epoch-integer columns are an open question (13).                                                                                      |

The written instant is the app server's clock at `track()`. Clock skew between app servers and rows "from the future" are possible and harmless to the queries (they are ordinary range filters).

---

## 4. Public API: types, config schema, validation

### 4.1 Entry points

```ts
// 'dynalitics'
export declare function createDynalitics(config: DynaliticsConfig): Promise<Dynalitics>;

export interface Dynalitics {
  /** Never throws, never rejects. Resolves when the event is accepted into the queue (not when it is written).
   *  In `drop` mode it resolves immediately; `void dyn.track(v)` is safe fire-and-forget. */
  track(visit: Visit): Promise<TrackResult>;
  /** Resolves when everything queued at call time has been written or has permanently failed. Never rejects. */
  flush(opts?: { timeoutMs?: number }): Promise<FlushResult>;
  /** Stops accepting events, flushes (default 5 s), then closes the pool unless the pool was supplied by the host. Idempotent. */
  close(opts?: { timeoutMs?: number }): Promise<FlushResult>;
  stats(): Readonly<DynaliticsStats>;
  readonly model: ColumnModel; // phase 1; becomes ResolvedModel when `existing` mode lands (phase 2)
  readonly table: TableRef;
  readonly capabilities: { canWrite: boolean; canRead: boolean }; // which credentials are present (4.5)
}

// 'dynalitics/handler'
export declare function createHandler(dyn: Dynalitics, options: HandlerOptions): DynaliticsHandler;
export declare function toNodeListener(
  h: DynaliticsHandler,
): (req: IncomingMessage, res: ServerResponse) => void;
export declare function toFetchHandler(
  h: DynaliticsHandler,
): (request: Request) => Promise<Response>;

// 'dynalitics-postgres' | 'dynalitics-mysql' | 'dynalitics-mssql'
export declare const postgres: DriverAdapter; // likewise `mysql`, `mssql`

// 'dynalitics/adapter'  (contract for adapter packages; no driver, no network)
export declare const ADAPTER_API_VERSION: 1;
export type { Driver, DriverAdapter, DriverOptions, Classification, CompiledQuery, Row };
export { DriverError, toDriverError, scrubMessage, isDriverError };

// 'dynalitics/schema'   (no driver, no network)
export declare function generateSql(opts: GenerateOptions): GeneratedSql;
export { buildColumnModel };
```

`createDynalitics` is `async` because it connects and validates the table (section 7). It throws `DynaliticsConfigError`, `DynaliticsConnectionError` or `DynaliticsSchemaError` (never anything containing connection details).

### 4.2 Visit and results

```ts
export type CustomValue = string | number | boolean | null;

export interface Visit {
  pageVisited: string; // required: path (query/fragment stripped by default)
  consent?: boolean; // per call; falls back to config.consent.default, then to false
  ip?: string | null; // host passes it (we never read X-Forwarded-For: spoofing is the host's call)
  userId?: string | number | null;
  username?: string | null;
  email?: string | null;
  custom?: Readonly<Record<string, CustomValue>>;
}

export type TrackResult =
  | { status: 'queued' }
  | { status: 'dropped'; reason: 'queue_full' | 'block_timeout' | 'closed' }
  | { status: 'rejected'; issues: readonly string[] }; // invalid input; nothing stored

export interface FlushResult {
  written: number;
  failed: number;
  timedOut: boolean;
}
export interface DynaliticsStats {
  queued: number;
  written: number;
  droppedFull: number;
  rejected: number;
  failed: number;
  queueLength: number;
  lruSize: number; // 0 unless firstVisit.enabled (write-time detection, 8.5.2)
  lastErrorAt: string | null;
}
```

### 4.3 Config

```ts
export type Dialect = 'postgres' | 'mysql' | 'mssql';
export type IpMode = 'raw' | 'hash' | 'truncate';

export type Credential = { connectionString: string } | { pool: unknown }; // pool: pg.Pool | mysql2 promise Pool | mssql.ConnectionPool

export interface DynaliticsConfig {
  /** v0.5: the adapter package's export, e.g. `import { postgres } from 'dynalitics-postgres'`. Supplies the dialect. */
  adapter: DriverAdapter;
  /** See 4.5. Recommended: { writer, reader }. A single Credential is "single-user mode" and logs a warning.
   *  Connection strings are kept in memory only and redacted everywhere. */
  connection: Credential | { writer?: Credential; reader?: Credential };
  acknowledgeSingleCredential?: boolean; // silences the single-credential warning; default false
  poolSize?: number; // per credential: default 4 (writer) / 2 (reader), range 1..20; ignored for host pools
  connectTimeoutMs?: number; // default 10_000
  table: string | TableRef; // 3.7: 'events', 'dbo.events', 'db.dbo.events' or { database?, schema?, name }
  tableMode?: 'recommended' | 'existing'; // default 'recommended' (3.1)
  columns?: Partial<Record<Role, string | false>>; // role -> physical column name; false = not stored
  customFields?: Record<string, CustomFieldDef>;
  extraColumns?: Record<string, ExtraColumnDef>; // 3.6: constants and host-computed values
  page?: { keepQuery?: boolean; maxLength?: number }; // defaults: false, 512 (max 700, MySQL index limit)
  ip?: { mode?: IpMode; salt?: string; ipv4Prefix?: number; ipv6Prefix?: number };
  consent?: { default?: (visit: Readonly<Visit>) => boolean }; // synchronous only
  firstVisit?: { enabled?: boolean; cacheSize?: number }; // WRITE-TIME detection, opt-in. defaults: false, 50_000 (8.5.2)
  queue?: {
    maxSize?: number; // 10_000
    batchSize?: number; // 200
    flushIntervalMs?: number; // 1_000
    backpressure?: 'drop' | 'block'; // 'drop'
    maxBlockMs?: number; // 2_000 (only for 'block')
    retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number }; // 3, 200, 5_000
  };
  limits?: { customMaxKeys?: number; customMaxBytes?: number; oversize?: 'truncate' | 'reject' }; // 20, 4096, 'truncate'
  validateOnStart?: 'strict' | 'skip'; // default 'strict'; 'skip' is for serverless cold starts / tests, logged loudly
  onError?: (info: ErrorInfo) => void; // exceptions thrown by this callback are caught and ignored
  logger?: Logger; // default: console
}

export interface CustomFieldDef {
  type: 'string' | 'integer' | 'number' | 'boolean';
  maxLength?: number; // string only; default 128, max 1024
  personal?: boolean; // default true
  column?: true | string; // promote to a real column (true = same name as the key)
  breakdown?: boolean; // allow as dashboard breakdown; requires personal: false
}

export interface ErrorInfo {
  code:
    | 'invalid_visit'
    | 'unknown_custom_field'
    | 'invalid_ip'
    | 'queue_full'
    | 'insert_failed'
    | 'lookup_failed'
    | 'consent_resolver_failed'
    | 'consent_missing'
    | 'compute_failed'
    | 'invalid_user_id'
    | 'internal';
  message: string; // already redacted
  count?: number; // coalesced repeats
  dropped?: number; // events lost, for insert_failed / queue_full
  cause?: { name: string; code?: string; message: string }; // sanitised, never the raw driver error
}
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
```

Example:

```ts
// Application process (request path): writer credential only.  import { postgres } from 'dynalitics-postgres';
const dyn = await createDynalitics({
  adapter: postgres,
  connection: { writer: { connectionString: process.env.ANALYTICS_WRITER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! },
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
  onError: (e) => myLogger.warn(e),
});

void dyn.track({
  pageVisited: '/pricing?utm_source=x',
  consent: req.cookies.analytics === 'yes',
  ip: req.ip,
  userId: session?.userId,
  username: session?.name,
  email: session?.email,
  custom: { plan: 'pro' },
});

// Admin/dashboard process (or route): reader credential only. Same table/columns/customFields/ip.mode config.
const reader = await createDynalitics({
  adapter: postgres,
  connection: { reader: { connectionString: process.env.ANALYTICS_READER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! }, // salt is not needed to read, but the mode is: new-vs-returning checks it
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
});
```

The writer and reader may also live in one process: pass `connection: { writer, reader }` once.

### 4.4 Validation approach (decision)

**A tiny hand-written validator** (`src/config/validate.ts`, about 150 lines, no dependency), not Zod or similar.

- Justification: the schema has roughly 40 fields and the supply-chain rule is the top constraint. A vetted library is a good dependency, but it is still the _only_ runtime dependency and it would sit on the config path of a package that holds a DB credential. 150 auditable lines cost less than permanent trust in a transitive tree. (This deviates from my general preference for Zod; the brief says "minimal dependencies" and I think it is right to take it literally here.)
- Behaviour: declarative schema objects (`str({min,max,pattern})`, `int(range)`, `enum([...])`, `fn()`, `obj(shape)`, `rec(valueSchema)`) -> one pass -> **collects all issues** with dotted paths (`config.queue.batchSize: expected integer 1..1000, got 0`) -> throws one `DynaliticsConfigError`. Unknown keys are errors (catches typos like `ipMode`). The same schema object produces the defaults table, so docs and code cannot drift.
- The TypeScript config types are written by hand; drift between them and the validator is caught by `expectTypeOf` tests plus a test that validates a fully populated example config.
- Per-visit input uses the same primitives but a hot-path implementation (no allocation of issue arrays unless something is wrong).

### 4.5 Credentials: two by default, one tolerated

**Documented default: two credentials.** The **writer** has `INSERT` on the table and nothing else (no SELECT). The **reader** has `SELECT` on the table and nothing else. A compromised web process then cannot read the personal data it just wrote, and the dashboard process cannot insert or alter anything.

```ts
connection: {
  writer: Credential;
  reader: Credential;
} // recommended: both in one process
connection: {
  writer: Credential;
} // tracking-only process (the reader lives elsewhere)
connection: {
  reader: Credential;
} // dashboard-only process
connection: {
  connectionString: '...';
} // single-user mode (also { pool })
```

Capabilities follow from what is present (there is no separate `role` option any more):

| code path                                                                               | credential used                                             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `track()`, queue, batched `INSERT` (section 9)                                          | writer                                                      |
| write-time first-visit lookups (8.5.2, opt-in)                                          | writer (**needs extra column-level SELECT**)                |
| every query behind `createHandler` (all of section 10), including read-time first-visit | reader                                                      |
| startup structure check (7.1 step 5)                                                    | reader if present (widest metadata visibility), else writer |
| startup `SELECT 1`, privilege inspection (7.5)                                          | each credential, separately                                 |

- Without a writer, `track()` resolves `rejected` with `no writer credential configured`. Without a reader, `createHandler` throws `DynaliticsConfigError`.
- The structure check is done with the reader when both exist, so an INSERT-only writer is never asked to see more than it should; the writer only gets connectivity and privilege checks, and its first real `INSERT` is the proof. If that fails with a permission error, `insert_failed` carries the hint `The writer credential needs INSERT on "<table>" (and USAGE on its identity sequence for PostgreSQL serial columns).` (7.6).
- If only a writer is configured, the structure check uses the writer. This works because INSERT privilege makes the table's columns visible in all three catalogs; if the catalog still returns nothing, the error says so (`The writer credential cannot see the table's columns, so the structure cannot be checked. Add a reader credential, or set validateOnStart: 'skip'.`).

**Single-user mode** (one `Credential`) stays supported for small deployments and prototypes. It logs this warning once per start through `logger.warn`, unless `acknowledgeSingleCredential: true`:

> dynalitics is using ONE database credential for both writing and reading. Anyone who can use the web process's credential can therefore read the personal data (ip, email, username, userId) it writes. Use separate writer and reader credentials: `npx dynalitics sql --grants-only --dialect postgres --table <table>` prints the GRANT statements.

With one credential the privilege inspection (7.5) expects `INSERT` + `SELECT`, and column-level SELECT for write-time first-visit is moot.

Cost of the split to be aware of: two pools, two connection strings to manage, and the reader process must repeat the table/column/`customFields`/`ip.mode` config (the handler needs them to build queries and to decide whether IP may serve as identity). Drift between the two configs is the host's risk; the startup structure check at least catches a column that no longer exists.

---

## 5. Adapter interface

Split in two so the part that holds security-critical logic is **pure and driver-free**, and the part that touches drivers is tiny.

### 5.1 `SqlDialect` (pure, in `src/dialect/*.ts`, used by generator, validator and queries)

```ts
export interface SqlDialect {
  readonly name: Dialect;
  readonly limits: { maxParams: number; maxRowsPerInsert: number; maxIdentifier: number };
  // PG: 65_535 params / unlimited rows;  MySQL: 65_535 / unlimited;  SQL Server: 2_100 params / 1_000 rows per VALUES
  quoteIdent(name: string): string; // asserts the identifier pattern first, then quotes ("x", `x`, [x])
  qualifiedTable(t: ColumnModel['table']): string;
  placeholder(index: number): string; // $1 | ? | @p1
  columnType(c: ColumnDef): string; // from the table in 3.4
  timestampParam(d: Date): string; // UTC string, see 3.4
  bucketExpr(col: string, interval: Interval): string; // text ISO UTC bucket start, DATEFIRST/session independent
  jsonKeyExpr(col: string, key: string): string; // key MUST pass the custom key pattern, then inlined as a literal
  limitClause(n: number): { prefix: string; suffix: string }; // TOP n | LIMIT n; n is a validated integer inlined
  introspectSql(table): CompiledQuery[]; // INFORMATION_SCHEMA / sys.* catalog SELECTs: columns, relation kind, defaults, identity, collation, indexes, triggers; parameterised
  privilegeSql(table, role): CompiledQuery[]; // catalog SELECTs only
  buildInsert(model, rows): CompiledQuery; // multi-row INSERT ... VALUES, parameterised
}
export interface CompiledQuery {
  sql: string;
  params: readonly SqlValue[];
}
export type SqlValue = string | number | boolean | null;
```

Rules enforced here and nowhere else:

- **Every value is a bound parameter.** The only things ever inlined in SQL text are (a) identifiers that passed the strict pattern and were quoted, (b) custom JSON keys that passed the key pattern, (c) integer `LIMIT`/`TOP` values that were validated and clamped. (c) is inlined because several drivers cannot reliably bind `LIMIT`/`TOP` (mysql2 prepared statements reject it on MySQL 8.0.22+).
- The request side of the read API can only select **names from allow-lists**; the text of a JSON key always comes from host config, never from a request (see 10.7).
- Unit tests assert (F-39) that every read statement contains no `;`, `--`, `\` or `/*`, and that after removing quoted identifiers, quoted literals (JSON paths, date formats) and parameter markers, only `[A-Za-z0-9_ (),.*=<>%+:/-]` remains. Request values only ever appear as bound parameters; the only inlined values are validated identifiers, JSON keys from host config, and validated integer limits.

### 5.2 `Driver` (runtime, one adapter package per database since v0.5)

```ts
// 'dynalitics/adapter'
export interface DriverAdapter {
  readonly apiVersion: typeof ADAPTER_API_VERSION; // 1; checked by validateConfig
  readonly dialect: Dialect; // which SqlDialect the core uses for every statement
  readonly packageName: string; // 'dynalitics-postgres', shown in errors
  createDriver(options: DriverOptions): Promise<Driver>; // called once per credential
}
export interface DriverOptions {
  readonly credential: Credential; // { connectionString } | { pool } (host pool, never closed by us)
  readonly max: number;
  readonly connectTimeoutMs: number;
  readonly redact: Redactor; // every message an adapter forwards goes through it (toDriverError does this)
  readonly requestTimeoutMs?: number;
}
export interface Driver {
  readonly dialect: SqlDialect;
  query(q: CompiledQuery, opts: { timeoutMs: number }): Promise<readonly Row[]>; // SELECT, and INSERT with no result
  isTransient(err: unknown): boolean; // connection reset, timeout, deadlock, pool exhausted, server restarting
  close(): Promise<void>; // no-op when the pool belongs to the host
}
export type Row = Readonly<Record<string, unknown>>;
```

Per driver:

|                | pg                                                                  | mysql2                                                          | mssql                                                        |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| execution      | `pool.query(text, values)` (extended protocol, server-side binding) | `pool.execute(sql, params)` (true prepared statements)          | `request.input(name, value)` per param, `request.query(sql)` |
| timeout        | `statement_timeout` in pool config; per-query `query_timeout`       | `MAX_EXECUTION_TIME(n)` hint on SELECTs; connect/query timeouts | `requestTimeout` (client side; cancels)                      |
| strings in/out | UTF-8                                                               | `timezone: 'Z'`, `dateStrings: true` for owned pools            | `useUTC: true`                                               |

No `SET`, `USE`, DDL or multi-statement strings are ever sent (`multipleStatements` is forced off for owned mysql2 pools). Owned pools default to `max: poolSize`, idle timeout 30 s, and TLS settings are whatever the connection string says (we document `sslmode=require`/`encrypt=true` for anything not on localhost).

**Deadlines and cancellation (F-05).** `timeoutMs` is enforced on the server, not only on the client, and the call settles only after the cancellation was attempted, so the read handler's concurrency slot is never freed while a statement is still running. PostgreSQL: the query runs on a dedicated pooled client; at the deadline `SELECT pg_cancel_backend(pid)` is sent (own role, guarded by 2 s) and the client is destroyed. MySQL: `SELECT` statements get a `/*+ MAX_EXECUTION_TIME(n) */` hint so the server stops them itself (note: MySQL ends `SLEEP()` by returning 1, not by raising an error), plus a client backstop 500 ms later that destroys the connection. SQL Server: `request.cancel()` at the deadline. **Host-supplied pools** get client-side enforcement and the same cancel attempts where the pool exposes `connect()` / `getConnection()` / `request()`, but no server-side limit: the host should set `statement_timeout` / `max_execution_time` on the reader role.

**Error messages (F-02).** Drivers throw only `DriverError`. Data/constraint classes (PostgreSQL SQLSTATE 22/23; MySQL errno 1048, 1062, 1264, 1292, 1366, 1406 and related; SQL Server 515, 547, 2601, 2627, 2628, 8152 and related) forward **no message text**, because databases print the offending value; permission errors forward a fixed sentence; connection, authentication, network and timeout classes forward their redacted message with quoted literals and parenthesised values scrubbed (300 characters at most); every other class forwards only `{ name, code }`.

MySQL prepared statements are cached per connection and counted by the server (`max_prepared_stmt_count`), so owned pools set `maxPreparedStatements: 64`.

A **fake in-memory `Driver`** (records `CompiledQuery`s, can inject failures) ships in `test/` for queue, retry and consent tests.

**Adapter rules (v0.5).** An adapter is the only code that imports a driver. It must build every error with `toDriverError` (so F-02 and redaction hold), must not send any statement of its own except the cancellation statements above, and must not close a host-supplied pool. Validation of `config.adapter`: an object with `apiVersion === 1`, a `dialect` in the allow-list and a `createDriver` function; otherwise `config.adapter: expected an adapter from dynalitics-postgres, dynalitics-mysql or dynalitics-mssql` (or, for a version mismatch, `config.adapter: <packageName> implements adapter API <n>, this dynalitics needs 1`).

An instance holds up to **two** drivers, one per credential (4.5): the writer driver serves only the queue/`INSERT` path (and write-time first-visit lookups when enabled), the reader driver serves every query behind the handler and the startup structure check. With a single credential both roles share one driver.

---

## 6. Schema generator and CLI

Two commands with opposite jobs:

- **`dynalitics sql`** proposes the recommended table. **It prints or writes SQL. It never connects to a database, never reads a connection string and never executes anything.** It has no code path that imports a driver (a test runs it with no driver installed and asserts that no socket is opened).
- **`dynalitics inspect`** looks at a table you already have. **It connects, read-only**, and prints a suggested config plus the problems it found. It never writes or alters anything (6.4).

### 6.1 Programmatic (`dynalitics/schema`, no driver, no network)

```ts
import { generateSql, generateGrants } from 'dynalitics/schema';

const sql = generateSql({
  dialect: 'postgres',
  schema: {
    table: 'public.dynalitics_events' /* same shape as SchemaConfig; recommended mode only */,
  },
  indexes: true, // default true
  grants: { writerRole: '<writer_role>', readerRole: '<reader_role>' }, // placeholders by default; omit to skip
});
// sql.createTable: string; sql.indexes: string[]; sql.grants: string[]; sql.full: string (all of it, ready to save)

// Grants only: works for ANY table, including an existing one. Table-level, so it needs no column mapping,
// except the identity columns when write-time first-visit is enabled.
const grants = generateGrants({
  dialect: 'mssql',
  table: 'dbo.page_views',
  writerRole: '[app_writer]',
  readerRole: '[app_reader]',
});
```

`generateSql` uses `buildColumnModel`, the same function the tracker and validator use, so generated DDL and runtime expectations cannot disagree. It rejects `tableMode: 'existing'`: `sql generates the recommended table. For a table you already have, use: dynalitics inspect`.

### 6.2 `sql` command

```
npx dynalitics sql --dialect postgres|mysql|mssql --table <name | schema.name | db.schema.name>
                   [--config <file.json>]         SchemaConfig subset as JSON (columns, customFields, page, firstVisit)
                   [--no-indexes]
                   [--grants]                     append least-privilege GRANTs with <writer_role>/<reader_role> placeholders
                   [--grants-only]                print ONLY the GRANTs (use this for an existing table)
                   [--writer <name>] [--reader <name>]   replace the placeholders
                   [--out <file>] [--force]       write to a file; refuses to overwrite without --force
                   [--help] [--version]
```

- Arguments are parsed with `node:util.parseArgs` (no dependency). Exit code 0 on success, 1 on usage/validation errors (messages to stderr, SQL to stdout only).
- `--config` accepts **JSON only**. The CLI never `import()`s or `require()`s a JS/TS config (that would be code execution from a file path) and never reads connection strings. The JSON may contain only schema fields; any other key is an error.
- Without `--out`, SQL goes to stdout so a **human** can pipe it into `psql`/`mysql`/`sqlcmd`.

### 6.3 Output: PostgreSQL (recommended table, defaults)

```sql
-- dynalitics schema for postgres. Generated, review before running. dynalitics itself never runs DDL.
CREATE TABLE "public"."dynalitics_events" (
  "id"             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "visited_at"     timestamptz  NOT NULL,
  "consent"        boolean      NOT NULL,
  "page_visited"   varchar(512) NOT NULL,
  "ip_address"     varchar(64),             -- PERSONAL DATA (stored per ip.mode)
  "user_id"        varchar(128),            -- PERSONAL DATA
  "username"       varchar(128),            -- PERSONAL DATA
  "email"          varchar(320),            -- PERSONAL DATA
  "custom"         jsonb                    -- declared custom fields; personal ones are NULL without consent
  -- "is_first_visit" boolean is added only when firstVisit.enabled is true (write-time detection)
);

-- Recommended indexes
CREATE INDEX "dynalitics_events_visited_at_idx" ON "public"."dynalitics_events" ("visited_at", "id");
-- The next two serve read-time new-vs-returning (one "any earlier row?" probe per identity). Without them that widget is slow.
CREATE INDEX "dynalitics_events_user_id_idx"    ON "public"."dynalitics_events" ("user_id", "visited_at") WHERE "user_id" IS NOT NULL;
CREATE INDEX "dynalitics_events_ip_idx"         ON "public"."dynalitics_events" ("ip_address", "visited_at") WHERE "ip_address" IS NOT NULL;

-- Least-privilege grants. Replace the placeholders. Neither role needs UPDATE, DELETE, TRUNCATE, DDL or ownership.
GRANT USAGE ON SCHEMA "public" TO <writer_role>, <reader_role>;
-- Application (writer): INSERT only. It cannot read anything back.
GRANT INSERT ON "public"."dynalitics_events" TO <writer_role>;
-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.
GRANT SELECT ON "public"."dynalitics_events" TO <reader_role>;
```

With `firstVisit.enabled: true` the table also gets `"is_first_visit" boolean` and the writer gets one more statement: `GRANT SELECT ("user_id", "ip_address") ON "public"."dynalitics_events" TO <writer_role>;` (printed with a comment saying this is the price of write-time detection).

MySQL: `` `visited_at` DATETIME(3) NOT NULL ``, `` `consent` TINYINT(1) NOT NULL ``, `` `custom` JSON NULL ``, `PRIMARY KEY (`id`)`, separate `CREATE INDEX` statements (not inline `KEY`) on `(visited_at, id)`, `(user_id, visited_at)`, `(ip_address, visited_at)` (no partial indexes in MySQL), `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`; grants `GRANT INSERT ON db.tbl TO ...` (writer) and `GRANT SELECT ON db.tbl TO ...` (reader).

SQL Server: `[visited_at] DATETIME2(3) NOT NULL`, `[consent] BIT NOT NULL`, `[page_visited] NVARCHAR(512) COLLATE Latin1_General_100_BIN2 NOT NULL`, `[custom] NVARCHAR(MAX) NULL CONSTRAINT [CK_dynalitics_events_custom_json] CHECK ([custom] IS NULL OR ISJSON([custom]) = 1)`, filtered indexes (`WHERE [user_id] IS NOT NULL`), grants `GRANT INSERT ON OBJECT::[dbo].[dynalitics_events] TO <writer_role>` and `GRANT SELECT ON OBJECT::[dbo].[dynalitics_events] TO <reader_role>`.

Index names are `<table>_<suffix>` truncated and hashed if longer than the dialect's identifier limit.

### 6.4 `inspect` command (read-only, connects)

Purpose: help someone with an **existing** table find the right `columns` mapping and see what would stop dynalitics from starting.

```
npx dynalitics inspect --dialect postgres|mysql|mssql --table <name | schema.name | db.schema.name>
                       [--url-env <ENV_VAR_NAME>]     name of the environment variable holding the connection string
                                                      (default: DYNALITICS_INSPECT_URL)
                       [--format text|json]           default text
                       [--help]
```

Credential handling (this is the part to get right):

- The connection string is taken **only from an environment variable**, never from argv. `--url-env` takes a variable **name** matching `^[A-Z_][A-Z0-9_]*$`. If any argument contains `://`, or looks like a connection string (`Server=`, `Password=`, `User Id=`), the CLI refuses with `Pass the NAME of an environment variable (--url-env), not a connection string.` Reason: argv is visible in process listings and shell history.
- The value is never printed, logged or echoed. All output, including error messages, passes through the same `redact()` as the library (T4). A missing variable is `exit 1` with `Environment variable X is not set.`
- Use a **read-only** user. `inspect` needs catalog visibility of the table, not data access; the reader credential is fine, an admin is unnecessary and discouraged.

What it does, in order: connectivity `SELECT 1`; one `INFORMATION_SCHEMA`/`sys.*` read for columns (name, type, length/precision, nullability, default, identity/generated, collation/charset), relation kind, indexes, triggers and partitioning; for MySQL the session time zone. **It does not read rows from the table.** It then runs the same comparison engine as startup (7.3) against a suggested mapping, so the problems it prints are the problems startup would throw.

Safety properties (each one is tested):

- Every statement it sends is a catalog `SELECT`/`WITH`, apart from, where the dialect supports it, opening the session read-only (PG `default_transaction_read_only`, MySQL `START TRANSACTION READ ONLY`). A test wraps the driver and asserts that each statement matches an allow-list; this, not the read-only session flag, is the primary guarantee.
- It has no `--out`: it writes only to stdout/stderr, so it cannot overwrite files. The human redirects if they want a file.
- It never writes, alters, creates or grants anything. The "suggested fix" SQL it prints (including GRANTs and `ALTER`s) is text for the human.
- Unlike `sql`, it does connect. It is therefore the only command with network access, and that is stated at the top of its `--help`.

Output (text format, abridged):

```
dynalitics inspect (read-only)   postgres 16.4   "public"."page_views"
  base table, 14 columns, 2 indexes, 1 trigger, not partitioned

Suggested mapping (REVIEW; this is a guess from names and types, never applied automatically)
  role          column         type            confidence
  timestamp     created_at     timestamptz     high     (name + type)
  consent       -              -               NONE     REQUIRED role has no candidate. Pick a boolean or 0/1 column, or add one.
  pageVisited   url            text            high
  ip            remote_addr    inet            medium
  userId        account_id     bigint          medium
  email         email          varchar(255)    high
  id            view_id        bigint          high     (identity)
  custom        -              -               -        no JSON column; promote custom fields instead

Problems (startup would fail)
  1. Role "consent" has no column.
  2. Column "created_by" is NOT NULL, has no default and is not mapped, so every INSERT would fail.
     -- ALTER TABLE "public"."page_views" ALTER COLUMN "created_by" DROP NOT NULL;      (or give it a default, or fill it via extraColumns)

Warnings
  - "created_at" is timestamptz: fine. "legacy_ts" (not mapped) is a naive timestamp, ignored.
  - Trigger "trg_pv_audit" fires on INSERT; dynalitics inserts in batches of up to 200 rows per statement.
  - "view_id" uses the sequence "public.page_views_view_id_seq": the writer needs  GRANT USAGE ON SEQUENCE "public"."page_views_view_id_seq" TO <writer_role>;
  - No index starts with ("account_id", "created_at"): read-time new-vs-returning will scan the table.

Suggested config (secrets omitted)
  {
    tableMode: 'existing',
    table: 'public.page_views',
    columns: { timestamp: 'created_at', consent: /* <-- choose */ undefined, pageVisited: 'url', ip: 'remote_addr',
               userId: 'account_id', email: 'email', id: 'view_id' },
  }
```

Exit codes: `0` mapping looks usable (no problems), `2` problems found (report still printed), `1` usage or connection error. `--format json` prints the same content as one JSON document (`{ table, mapping[], problems[], warnings[], suggestedConfig }`) for tooling.

Role suggestion is heuristic: name patterns (`created_at|ts|visited_at|time` for timestamp; `consent|accepted|gdpr` for consent; `url|path|page|uri`; `ip|remote_addr|client_ip`; `user_id|uid|account_id|customer_id`; `username|login`; `email|mail`; a single integer identity/auto-increment column for `id`; the first JSON-typed column for `custom`) combined with the compatibility table in 7.2. Confidence is `high` (name and type fit), `medium` (one of the two), `low`. It never auto-selects a `low` candidate.

---

## 7. Startup validation

### 7.1 Flow (`createDynalitics`)

1. Validate config synchronously (including all the mapping rules in 3.1 and the extra-column rules in 3.6). Throw `DynaliticsConfigError` listing **all** issues.
2. Build the `ColumnModel`.
3. Create the driver(s): one per credential present (4.5). From here on, any throw closes owned pools before propagating.
4. Connectivity check `SELECT 1` on each driver within `connectTimeoutMs`. Failure -> `DynaliticsConnectionError` (redacted).
5. Introspect with the reader if present, else the writer: columns (name, type, length, precision, nullability, default, identity/generated, collation/charset), relation kind (base table vs view), indexes, triggers, partitioning. For MySQL also the session time zone. Every statement is a parameterised catalog `SELECT`. PG default schema `current_schema()`, MySQL `DATABASE()`, SQL Server `SCHEMA_NAME()`.
6. Resolve and compare (7.2, 7.3). Any _problem_ throws `DynaliticsSchemaError`. _Warnings_ go to `logger.warn`. On success the `ResolvedModel` is built (encodings, effective lengths, capabilities).
7. Privilege inspection per credential (7.5): warnings only, never throws, skipped silently if the catalog queries are denied.
8. Startup info log (`logger.info`): resolved table name, table mode, unmapped roles and their consequences (3.2), effective column lengths that were clamped, and which new-vs-returning source the handler will use.
9. Start the writer loop and return the instance.

`validateOnStart: 'skip'` jumps from 4 to 9 and skips the structure check. It exists because serverless cold starts pay about two round trips for steps 4-5; it logs a warning every start. With `skip`, the `ResolvedModel` is built from the config alone (no clamped lengths, default encodings for the recommended table), which is only safe for recommended tables; `skip` with `tableMode: 'existing'` is a config error.

### 7.2 Type compatibility (explicit table)

The check is **type-tolerant by family**, not exact. "Written as" is what dynalitics binds. Anything not listed is a `type_mismatch` problem. `warn` means startup continues and logs the named warning.

| role / use                         | PostgreSQL                                                                                                                                                                          | MySQL (8.0+)                                                                                                                                           | SQL Server (2017+)                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp`                        | `timestamptz` ok. `timestamp` warn `naive_timestamp`. `date` no                                                                                                                     | `datetime(n)` ok (warn if n < 3: `low_precision_timestamp`, warn `naive_timestamp`). `timestamp(n)` ok only if session is UTC, else problem. `date` no | `datetime2(n)` ok (warn naive). `datetimeoffset` ok. `datetime`, `smalldatetime` warn `low_precision_timestamp`. `date`, `time` no |
| `consent`, `isFirstVisit`          | `boolean` ok (written as true/false). `smallint`, `integer`, `bigint` ok (written as 1/0)                                                                                           | `tinyint(1)`, `boolean`, `tinyint`, `smallint`, `int`, `bigint`, `bit(1)` ok (1/0)                                                                     | `bit` ok. `tinyint`, `smallint`, `int`, `bigint` ok (1/0)                                                                          |
| `pageVisited`, `username`, `email` | `varchar(n)`, `text` ok. `citext` warn `case_insensitive_identity` (identity roles only). `char(n)` no (padding)                                                                    | `varchar(n)`, `tinytext`, `text`, `mediumtext`, `longtext` ok. `char(n)` no                                                                            | `nvarchar(n \| max)` ok. `varchar(n \| max)` warn `non_unicode_column`. `char`, `nchar`, `text`, `ntext` no                        |
| `ip`                               | string types as above. `inet` ok unless `ip.mode` is `hash`                                                                                                                         | string types as above                                                                                                                                  | string types as above                                                                                                              |
| `userId`                           | string types as above. `smallint`, `integer`, `bigint` ok (value must be a decimal integer in range, else that field is NULL + `invalid_user_id`). `uuid` ok (value must be a UUID) | string types as above, integer types ok, `char(36)` ok (UUID text). `binary(16)` no                                                                    | string types as above, integer types ok, `uniqueidentifier` ok (value must be a UUID)                                              |
| `custom`                           | `jsonb` ok. `json` warn `json_unindexable`. Others no                                                                                                                               | `json` ok. Others no                                                                                                                                   | `nvarchar(max)` ok (info if no `ISJSON` check is detected). Others no                                                              |
| `id`                               | `smallint`, `integer`, `bigint`                                                                                                                                                     | integer family                                                                                                                                         | integer family                                                                                                                     |
| promoted `string` field            | string types as above                                                                                                                                                               | string types as above                                                                                                                                  | string types as above                                                                                                              |
| promoted `integer` field           | `smallint`, `integer`, `bigint` (value range-checked against the real width)                                                                                                        | integer family (range-checked)                                                                                                                         | integer family (range-checked)                                                                                                     |
| promoted `number` field            | `double precision`, `real`, `numeric` ok                                                                                                                                            | `double`, `float`, `decimal` ok                                                                                                                        | `float`, `real`, `decimal` ok                                                                                                      |
| promoted `boolean` field           | as `consent`                                                                                                                                                                        | as `consent`                                                                                                                                           | as `consent`                                                                                                                       |

String length: in **recommended** mode a real column shorter than the configured maximum is the problem `too_short`. In **existing** mode dynalitics instead **adopts the real length** (`effectiveMaxLength = min(configured, real)`), reports it in the startup info log, and applies the usual `oversize` policy (truncate or reject). Unlimited types (`text`, `max`) take the configured maximum.

### 7.3 Checks, problem codes and exact messages

Problems throw (together, in one report); warnings are logged. `<S>.<T>` stands for the quoted table name as configured. Messages are fixed templates, which is what the tests snapshot.

| code                                     | kind    | when                                                                                                                                             | message                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_table`                          | problem | catalog has no such object (or the user cannot see it)                                                                                           | `Table <S>.<T> was not found, or the database user cannot see it. dynalitics never creates tables. To get the recommended table, run: npx dynalitics sql --dialect <d> --table <T>`                                                                                                               |
| `not_a_table`                            | problem | object is a view, materialized view, synonym, foreign table                                                                                      | `<S>.<T> is a view (or other non-table object). dynalitics supports base tables only, because inserts into views are not predictable (see 7.6).`                                                                                                                                                  |
| `missing_column`                         | problem | a mapped column is absent                                                                                                                        | `Role "<role>" is mapped to column "<col>", but <S>.<T> has no such column. Columns found: <up to 30 names>.` (PostgreSQL adds: `Quoted names are case-sensitive in PostgreSQL.` if a case-insensitive match exists)                                                                              |
| `type_mismatch`                          | problem | real type not in the 7.2 table                                                                                                                   | `Role "<role>" (column "<col>"): type "<real type>" is not accepted on <dialect>. Accepted: <list from 7.2>.`                                                                                                                                                                                     |
| `too_short`                              | problem | recommended mode only                                                                                                                            | `Column "<col>" is varchar(<real>) but dynalitics may write up to <configured> characters. Widen the column or lower <setting>.`                                                                                                                                                                  |
| `not_nullable`                           | problem | mapped column is `NOT NULL` where we may write NULL: every role except `timestamp`, `consent`, `pageVisited`, `id`; promoted and computed fields | `Role "<role>" (column "<col>") is NOT NULL, but dynalitics writes NULL there when consent is not given. Make the column nullable, or stop storing this role (columns.<role> = false).`                                                                                                           |
| `extra_required_column`                  | problem | an **unmapped** column is `NOT NULL` with no default, identity, generated/computed expression or `rowversion`                                    | `Column "<col>" is NOT NULL, has no default and is not mapped, so every INSERT would fail. Give it a default, make it nullable, or fill it from config.extraColumns.`                                                                                                                             |
| `timestamp_session_timezone`             | problem | MySQL `TIMESTAMP` role column and session offset is not 00:00                                                                                    | `Role "timestamp" (column "<col>") is a MySQL TIMESTAMP, and this connection's time zone is "<offset>". dynalitics writes UTC. Use a DATETIME column, or make the connection run in UTC (for example SET time_zone = '+00:00' in your pool's init). dynalitics never changes the session itself.` |
| `identity_not_discoverable`              | problem | writer-only config and the catalog returns no columns for a table the writer can insert into                                                     | `The writer credential cannot see the columns of <S>.<T>, so the structure cannot be checked. Add a reader credential, or set validateOnStart: 'skip' (recommended tables only).`                                                                                                                 |
| `naive_timestamp`                        | warn    | `timestamp`/`datetime`/`datetime2` role column                                                                                                   | `Column "<col>" has no time zone. dynalitics writes and reads it as UTC. If other code writes local times into it, the dashboard will show shifted data.`                                                                                                                                         |
| `low_precision_timestamp`                | warn    | `datetime(0..2)`, SQL Server `datetime`/`smalldatetime`                                                                                          | `Column "<col>" has coarse precision (<what>); visit times will be rounded.`                                                                                                                                                                                                                      |
| `case_insensitive_identity`              | warn    | `userId`/`ip` column collation is case-insensitive (`_ci`, CI_AS, `citext`)                                                                      | `Column "<col>" compares case-insensitively, so ids differing only by case (for example "U_42" and "u_42") are treated as one visitor in new-vs-returning.`                                                                                                                                       |
| `lossy_charset`                          | warn    | MySQL string column charset is `latin1`/`utf8mb3`; SQL Server `varchar`                                                                          | `Column "<col>" cannot store every Unicode character (<charset>); values with emoji or other characters may fail to insert.`                                                                                                                                                                      |
| `nullable_consent`                       | warn    | `consent` column is nullable                                                                                                                     | `Column "<col>" (consent) allows NULL. Existing NULL values are treated as "no consent".`                                                                                                                                                                                                         |
| `json_unindexable`, `non_unicode_column` | warn    | see 7.2                                                                                                                                          | `Column "<col>" is <type>: <consequence>.`                                                                                                                                                                                                                                                        |
| `triggers_present`                       | warn    | the table has triggers that fire on INSERT                                                                                                       | `<S>.<T> has INSERT triggers (<names>). dynalitics inserts up to <batch> rows per statement; triggers must handle multi-row inserts and can slow or reject batches.`                                                                                                                              |
| `partitioned`                            | warn    | partitioned table                                                                                                                                | `<S>.<T> is partitioned. Inserts fail if no partition accepts a visit's timestamp (for example a missing future partition).`                                                                                                                                                                      |
| `sequence_grant`                         | warn    | PostgreSQL `serial`/`nextval` default on an unmapped or `id` column                                                                              | `Column "<col>" gets its value from sequence <seq>. The writer needs: GRANT USAGE ON SEQUENCE <seq> TO <writer_role>;`                                                                                                                                                                            |
| `missing_identity_index`                 | warn    | no index has the identity column as leading column                                                                                               | `No index starts with ("<col>", "<timestamp col>"). New-vs-returning does one lookup per visitor, which will scan the table. Suggested: CREATE INDEX ... ON <S>.<T> ("<col>", "<timestamp col>");`                                                                                                |

Detection of triggers, partitioning, collation and indexes is **best effort** (catalog visibility depends on the privileges of the inspecting credential). A warning that is missing does not prove the condition is absent.

Suggested fixes are printed with the report (7.4) and **never executed**. A fix that changes the user's existing table (`ALTER`, `CREATE INDEX`, `GRANT`) is always printed commented out in `existing` mode; only the additive, nullable `ADD COLUMN` for a _recommended_ table is printed live. In `existing` mode a missing mapped column gets no `ADD COLUMN` suggestion (a typo is more likely than a genuinely missing column); the message lists the columns found.

### 7.4 Error format

`DynaliticsSchemaError extends Error`, `code = 'DYNALITICS_SCHEMA'`, with `problems: readonly SchemaProblem[]`, `warnings`, and `fixSql: string`. The message is a printable report:

```
DynaliticsSchemaError: table "public"."page_views" does not match what dynalitics expects (postgres, tableMode "existing").

Problems:
  1. Role "email" (column "email"): type "integer" is not accepted on postgres. Accepted: varchar, text, citext.
  2. Role "ip" is mapped to column "remote_addr", but "public"."page_views" has no such column. Columns found: id, created_at, url, ip_addr, account_id.
  3. Column "created_by" is NOT NULL, has no default and is not mapped, so every INSERT would fail. Give it a default, make it nullable, or fill it from config.extraColumns.

dynalitics never changes your database. Review the suggestions below. Nothing here has been executed.

  -- Problem 1: existing data may not convert, review manually.
  -- ALTER TABLE "public"."page_views" ALTER COLUMN "email" TYPE varchar(320) USING "email"::varchar;
  -- Problem 2: probably a typo in columns.ip (did you mean "ip_addr"?). Fix the config, not the table.
  -- Problem 3: choose one.
  --   ALTER TABLE "public"."page_views" ALTER COLUMN "created_by" DROP NOT NULL;
  --   ALTER TABLE "public"."page_views" ALTER COLUMN "created_by" SET DEFAULT <value>;
  --   or add to config: extraColumns: { created_by: { type: 'string', constant: '<value>' } }

(The connection string is never included in this message. To see a suggested mapping for this table: npx dynalitics inspect --dialect postgres --table public.page_views)
```

For a missing table in recommended mode the report contains the whole `generateSql(...).full`.

### 7.5 Privilege warnings (best effort, per credential)

Catalog `SELECT`s only, no DDL, run once per credential:

- PG: `has_table_privilege(current_user, tbl, 'SELECT'|'UPDATE'|'DELETE'|'TRUNCATE'|'REFERENCES'|'TRIGGER')`, `has_schema_privilege(..., 'CREATE')`, `rolsuper`, table ownership.
- MySQL: `SHOW GRANTS FOR CURRENT_USER()` parsed for `ALL PRIVILEGES`, `SELECT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `SUPER`, `GRANT OPTION` at global/database/table scope. Roles make this heuristic.
- SQL Server: `fn_my_permissions` on the table and the database, `IS_SRVROLEMEMBER('sysadmin')`, `IS_MEMBER('db_owner')`.

Expectation per credential, and the warning text when it is exceeded:

| credential        | expected                                                                         | warning (logged once per start via `logger.warn`)                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| writer            | `INSERT` only (plus column `SELECT` on identity columns if `firstVisit.enabled`) | `The writer credential seems to have more privileges than dynalitics needs (<list>). It only needs INSERT on <S>.<T>. See: npx dynalitics sql --grants-only --dialect <d> --table <T>` |
| reader            | `SELECT` only                                                                    | `The reader credential seems to be able to change data or structure (<list>). It only needs SELECT on <S>.<T>. See: npx dynalitics sql --grants-only --dialect <d> --table <T>`        |
| single credential | `INSERT` + `SELECT`                                                              | the single-credential warning from 4.5, plus `The credential seems to have more privileges than dynalitics needs (<list>).` if applicable                                              |

The wording says "seems" on purpose. This check is **advisory**: it can miss privileges granted through roles or groups, can false-positive, and must never block startup. Do not describe it as a guarantee in docs.

### 7.6 Existing-table limits and caveats (be honest in docs)

- **Views: not supported in v1.** The type check can see a view's columns, but nothing else needed for safe writing: `INSERT` behaviour through a view depends on updatability rules, `WITH CHECK OPTION`, `INSTEAD OF` triggers and underlying `NOT NULL` columns, none of which can be verified through the catalog views we read; and the index that read-time new-vs-returning relies on lives on the base table. A view produces `not_a_table`. (Reader-only use of a view is a possible later relaxation; open question in 13.)
- **Triggers** on the table run on every batch insert, can reject a batch, can be slow, and may have external side effects. dynalitics detects them best-effort and warns; it cannot make them safe. After a non-transient batch failure dynalitics retries row by row (section 9), so a trigger with external side effects can fire again for rows of the failed statement that were rolled back.
- **Partitioned tables** work as long as every visit timestamp lands in an existing partition. A missing partition makes the whole batch fail, then row by row, then events are dropped (`insert_failed`). Reads work; partition elimination needs range filters on the timestamp column, which every query has.
- **Very wide tables** (hundreds of columns): dynalitics names only the mapped columns in `INSERT` and never issues `SELECT *`; unmapped columns fall back to their defaults. The catalog read returns every column once per start. No special handling is needed up to the engine limits, but `NOT NULL`-without-default columns are the usual blocker (`extra_required_column`).
- **Legacy rows**: reads run over every row in the table, including rows dynalitics did not write. Their consent semantics are unknown: `NULL` consent counts as denied, identity columns of legacy rows count as prior visits for new-vs-returning (8.5.1), and legacy personal data is masked like any other.
- **Shared tables**: use a scoping `constant` (3.6) so the dashboard only sees this site's rows. Without it the dashboard reads the whole table.
- **Names**: only identifiers matching the strict pattern (3.7) are supported; others need a rename or a view-free workaround.
- **PostgreSQL `serial` ids**: an `INSERT`-only writer still needs `USAGE` on the sequence behind a `nextval()` default. `inspect` and `sql --grants-only` print that grant.
- **Collation and charset** of existing columns are accepted but warned about (7.3); they change what "same visitor" means.

---

## 8. Tracking

### 8.1 Pipeline (all in `buildRow`, a pure function: `(model, config, visit, now) -> {row} | {rejected}`)

0. **Roles**: visit fields whose role is unmapped (3.2) are ignored from here on: not validated, not stored, never an error.
1. **Shape check**: `visit` is an object; `pageVisited` is a string that, after cleaning, is a path (see page hygiene below); optional mapped text fields have the right types. Wrong type -> `rejected`, `onError(invalid_visit)`. `userId` accepts strings and finite **safe integers**; anything else is stored as NULL, the visit is kept and `invalid_user_id` is reported (F-32).
2. **Resolve consent**: `visit.consent` if boolean -> else `config.consent.default(visit)` (sync; exception or non-boolean -> `false` + `onError(consent_resolver_failed)`) -> else `false` + `onError(consent_missing)` once per minute. A **non-boolean, non-null** `consent` (`'yes'`, `1`, `{}`) is never coerced and never trusted: the visit is stored as `consent = false` and reported as `invalid_visit` (F-31). **Fail closed.**
3. **If consent is false** (denied, absent, null or invalid): **only `pageVisited`, the timestamp and `consent = false` are stored, plus constants** (host configuration, not visitor data). Custom fields are skipped unless the field declares `keepWhenDenied: true` (F-03, strict). Personal inputs are ignored without being inspected, and host compute functions receive only the reduced `DeniedVisitView` (3.6).
4. Normalise: strip C0 control chars and `U+007F` (NULs break PG text and enable log injection), `toWellFormed()` (lone surrogates), apply `page.keepQuery`, apply limits (using the real column length in `existing` mode, 7.2).
5. Apply IP mode (8.3). Evaluate extra columns (3.6): constants are appended, computed functions run in host code (exceptions become `NULL` or a rejection, see 3.6).
6. Build the positional parameter row in `model.insertColumns` order, using each column's `ValueEncoding` (for example `1/0` for an integer consent column, a UUID string for a `uuid` user id).

`is_first_visit` is **not** computed here. By default it is not stored at all (8.5.1); with `firstVisit.enabled` the writer fills it (8.5.2).

### 8.2 Consent matrix

Defaults used: recommended table, `ip.mode = truncate`, `firstVisit.enabled = false`, `customFields = { plan: string personal:false, campaign: string personal:true(default) }`. Input for the first rows: `{ pageVisited: '/pricing?utm=x', ip: '203.0.113.77', userId: 'u_42', username: 'jane', email: 'jane@example.com', custom: { plan: 'pro', campaign: 'fall' } }`.

Columns shown: `visited_at`, `consent`, `page_visited`, `ip_address`, `user_id`, `username`, `email`, `custom`. (With `firstVisit.enabled: true` there is a ninth column, `is_first_visit`; see the note below the table.)

| #   | consent input                                                                      | resolver        | resolved                            | stored row                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `true`                                                                             | n/a             | true                                | `2026-10-30T12:01:44.120Z`, true, `/pricing`, `203.0.113.0`, `u_42`, `jane`, `jane@example.com`, `{"plan":"pro","campaign":"fall"}`                        |
| 2   | `false`                                                                            | n/a             | false                               | `2026-10-30T12:01:44.120Z`, false, `/pricing`, NULL, NULL, NULL, NULL, NULL (**strict**: `plan` is not kept; it would be only with `keepWhenDenied: true`) |
| 3   | absent                                                                             | returns `true`  | true                                | same as row 1                                                                                                                                              |
| 4   | absent                                                                             | none configured | false (+ `consent_missing` warning) | same as row 2                                                                                                                                              |
| 5   | absent                                                                             | throws          | false (+ `consent_resolver_failed`) | same as row 2                                                                                                                                              |
| 6   | `'yes'` (not boolean)                                                              | any             | false (+ `invalid_visit`)           | as row 2: **stored as "no consent"**, never coerced to true, never dropped (counts stay right)                                                             |
| 7   | `true`, no ip/userId                                                               | n/a             | true                                | `.., true, /pricing, NULL, NULL, NULL, NULL, NULL` (stored; the dashboard will classify it as "unknown" for new-vs-returning, 8.5.1)                       |
| 8   | `true`, `ip: 'not-an-ip'`                                                          | n/a             | true                                | row stored with `ip_address` NULL, `onError(invalid_ip)`                                                                                                   |
| 9   | `false`, no non-personal custom fields                                             | n/a             | false                               | `.., false, /pricing, NULL x4, custom NULL`                                                                                                                |
| 10  | `true`, `pageVisited` missing/empty                                                | n/a             | n/a                                 | **rejected**                                                                                                                                               |
| 11  | `true`, `columns.email` unmapped                                                   | n/a             | true                                | as row 1 but there is no `email` column in the statement at all; the email is dropped (startup info log said so, 3.2)                                      |
| 12  | `false`, `extraColumns.tenant_id` constant `7`, `session_hash` computed (personal) | n/a             | false                               | as row 2 plus `tenant_id = 7` (constants are always written) and `session_hash = NULL` (personal compute function **not called**)                          |
| 13  | `true`, user table has an integer `user_id`, `userId: 'abc'`                       | n/a             | true                                | row stored with `user_id` NULL, `onError(invalid_user_id)` (the visit is kept, the unusable field is not)                                                  |

Invariants (property-tested): with resolved consent `false`, every personal column is NULL and `custom` contains only keys declared `personal: false`; no personal computed function is invoked. `consent` and the timestamp are always written. Constants are always written.

With `firstVisit.enabled: true` the ninth column `is_first_visit` is: row 1 `true` (first time the identity is seen, otherwise `false`), rows 2-5 and 9, 12 NULL (no consent), row 7 NULL (no identity), row 8 `NULL` if no `userId` either.

### 8.3 IP modes

Input is normalised first: strip a port, a zone id (`%eth0`) and brackets; map `::ffff:a.b.c.d` to IPv4; lower-case; validate with `node:net.isIP`. Invalid -> NULL plus `invalid_ip` (the visit is still stored).

| mode                 | stored value                                          | notes                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw`                | normalised address                                    |                                                                                                                                                                                                                         |
| `hash`               | `HMAC-SHA256(salt, normalised)` as hex (64 chars)     | `ip.salt` is **required**, >= 16 chars, comes from a secret store. Plain unsalted hashes of IPv4 are reversible in minutes (2^32 space); the same applies if the salt leaks. Rotating the salt makes everyone look new. |
| `truncate` (default) | IPv4 zero host bits `/24` (`203.0.113.0`), IPv6 `/48` | configurable `ipv4Prefix` 8..32, `ipv6Prefix` 16..128; IPv6 computed with `BigInt`, written in canonical compressed form                                                                                                |

The package never reads `X-Forwarded-For`; the host passes the address it trusts.

### 8.4 Limits

Defaults: `pageVisited` <= `page.maxLength` (512); `userId`/`username` <= 128; `email` <= 320; `ip` input <= 64; custom: at most 20 keys, each string <= its `maxLength` (128), serialised JSON <= 4096 bytes. `oversize: 'truncate'` (default) cuts over-long **strings**; `'reject'` rejects the event. Wrong types, too many keys, or an oversized JSON payload always **reject**.

**Page hygiene (F-14).** `page.keepQuery` is false by default: the query string and fragment are removed because reset links, tokens and emails regularly end up in URLs. In addition: an absolute URL (`https://user:pw@host/x`) is reduced to its path (scheme, userinfo, host dropped); anything that is not a path starting with `/` is rejected; `;matrix=params` (for example `;jsessionid=...`) are removed; and the host may map paths to route templates with `page.normalize` (`/users/jane@example.com` -> `/users/:id`), which is the only protection against identifiers in the path itself. **Page + timestamp is therefore not anonymous by itself**: a path such as `/u/jane` re-identifies. Use `page.normalize`. Stored strings also lose C0 and C1 controls, U+2028/2029 and bidi controls/marks (F-33).

### 8.5 New vs returning visitors

Two strategies. **Read-time computation is the default and needs nothing at write time.** Write-time computation is an opt-in with sharp edges.

|                       | read-time (default)                                                              | write-time (opt-in `firstVisit.enabled`)                |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| where computed        | in the dashboard queries (10.5, 10.11)                                           | in the writer, stored in `is_first_visit`               |
| writer needs SELECT   | **no** (INSERT-only writer)                                                      | yes, column-level on the identity columns               |
| exact?                | yes, for the identity it uses                                                    | approximate (races across instances, cold caches)       |
| serverless-safe       | yes                                                                              | no (LRU is cold on every invocation)                    |
| survives data erasure | yes: deleted rows simply stop counting                                           | no: stored flags and running caches keep the old answer |
| cost                  | an index probe per distinct visitor in the requested range, **at every request** | one lookup per unseen identity, at write time           |

#### 8.5.1 Read-time computation (default)

Everything below is evaluated by SQL at request time, over the **whole table** (restricted only by scoping constants, 3.6), not just the requested range.

**Identity of a row** (exactly one of, in this order):

1. `("u", userId)` if the `userId` role is mapped and the value is not NULL.
2. else `("i", ip)` if the `ip` role is mapped, the value is not NULL, and **IP identity is allowed**.
3. else the row has **no identity**.

**IP identity is allowed** when `newVsReturning.ipIdentity` (a handler option, 10.1) is `'always'`, or `'auto'` (default) and the configured `ip.mode` is `raw` or `hash`. With `ip.mode = 'truncate'`, `'auto'` means **not allowed**: a /24 or /48 prefix identifies a network, not a visitor, and would label whole office buildings and ISP blocks as one returning person. `'never'` disables it. The handler reads `ip.mode` from its own config, so reader and writer processes must be configured alike (4.5).

**Classification of a row**:

- The row is **unknown** if its `consent` is not true (denied, or NULL in an existing table), or it has no identity. This is the "consent denied => unknown" rule: no personal fields were stored for such rows by dynalitics, so they cannot be classified.
- Otherwise it is **new** if it is the first row of its identity in the table, and **returning** if an earlier row exists. "First" is ordered by `(timestamp, id)` when `id` is mapped, by `timestamp` alone otherwise (then two rows with exactly equal timestamps are both "first").
- **What counts as an earlier row**: any row, regardless of its own consent, with the same identity column value and an earlier position. For `("u", x)` the match is on the `userId` column; for `("i", x)` on the `ip` column (including rows that also have a `userId`). Rows of an existing table written before dynalitics are therefore prior visits.

**Aggregate form used by `/api/new-vs-returning`** (equivalent, but far cheaper than classifying every row): for each bucket `b`,

- `total_b` = rows in the bucket,
- `identified_b` = rows in the bucket with consent true and an identity,
- `new_b` = number of distinct identities whose **earliest row inside the requested range falls in `b`** and which have **no row earlier than `from`**,
- `returning_b` = `identified_b - new_b`, `unknown_b` = `total_b - identified_b`.

So a visitor with five visits in the range counts as one `new` (in the bucket of their first visit) and four `returning`, and a visitor whose first-ever visit was before `from` counts only as `returning`. A visitor first seen 10 minutes before `from` is `returning` in the first bucket; this is correct, not an edge-case bug. The exact SQL shape is in 10.11. For `recent-visits`, the per-row form is used on the page's rows only.

**Index requirements** (the generator emits them, the startup check warns if they are missing, 7.3):

- `(user_id, visited_at)` and `(ip_address, visited_at)`: each "any earlier row?" probe is an index seek. Without them every probe scans the table and the widget will hit the query timeout (504).
- `(visited_at, id)`: the range scan.

**Cost, honestly.** One request costs a range scan plus `D` index seeks, where `D` is the number of distinct identities in the requested range. That is cheap for `D` in the thousands, noticeable at hundreds of thousands, and can exceed the 10 s query timeout at millions, because it is paid on **every** dashboard load (the result is not stored anywhere). Mitigations, in order of preference: keep the default 7-day range; `newVsReturning.maxRangeDays` (default 31) caps it; `cacheTtlMs` turns repeated loads into one query; `newVsReturning.enabled: false` removes the widget (it then reports `unavailable`/`disabled_by_host`); or switch to the write-time column with `newVsReturning.source: 'column'`. Rollup tables are out of scope.

**Behaviour summary**

| situation                                                        | result                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| consent denied (or NULL)                                         | `unknown`                                                                                                               |
| consent given, no `userId`/`ip` stored                           | `unknown`                                                                                                               |
| neither `userId` nor `ip` role mapped                            | widget `unavailable`, reason `no_identity_column`                                                                       |
| only `ip` mapped and `ip.mode = truncate` (`ipIdentity: 'auto'`) | widget `unavailable`, reason `identity_not_reliable`; with `ipIdentity: 'always'` it works and is flagged `approximate` |
| `ip` identity in use (`raw`/`hash`)                              | works, `approximate: true` (shared addresses merge people; `hash` salt rotation makes everyone new)                     |
| `userId` only                                                    | works, `approximate: false`                                                                                             |
| both mapped                                                      | `userId` first, `ip` for rows without a user id, `approximate: true`                                                    |

#### 8.5.2 Write-time computation (opt-in: `firstVisit.enabled: true`)

Adds the `is_first_visit` column (role `isFirstVisit`, required when enabled) and fills it in the writer, **not** in `track()` (so `track()` stays cheap). **Requires the writer to run SELECTs**, which is why the default writer is INSERT-only and this is off.

**Identity**: if consent is true and `userId` exists -> `u:<userId>`; else if `ip` (the _stored_ form: raw/hash/truncated) exists -> `i:<value>`; else no identity and `is_first_visit = NULL`. (This uses the stored, possibly truncated, IP, unlike read-time computation which refuses truncated IPs by default; the flag is approximate by design.)

**Algorithm** (per batch, in event order):

1. Key = `HMAC-SHA256(processRandomKey, identity)` truncated to 16 bytes, so the LRU never holds raw PII. LRU is a bounded `Map` (size `firstVisit.cacheSize`, default 50 000) with refresh-on-hit.
2. Hit in LRU -> `false`.
3. Repeat of an identity already seen earlier _in this batch_ -> `false`.
4. Remaining unique identities are looked up in **one query per identity kind** (chunked by `limits.maxParams`) through the **writer** credential:
   `SELECT DISTINCT user_id FROM t WHERE user_id IN (?, ?, ...)` and
   `SELECT DISTINCT ip_address FROM t WHERE ip_address IN (...) AND user_id IS NULL`.
   Found in the DB -> `false`, else `true`.
5. After a **successful insert**, add the batch's identities to the LRU. On permanent insert failure, nothing is added (so a lost first visit does not turn the next one into "returning").
6. If the lookup itself fails (including "permission denied" because the writer was not given the column-level SELECT) -> `is_first_visit = NULL` for the affected rows plus `lookup_failed` with the hint `write-time first-visit needs SELECT on the identity columns for the writer; see sql --grants`; we never guess.

Batches are written one at a time per instance, so steps 1-5 are race-free **within one process**.

**Caveats (these will appear in the README):**

- **Multiple instances / processes / serverless**: each has its own LRU and no shared state, so two instances can both mark the same person `true` when their first visits are close together (a window of about one flush interval plus insert time). In serverless, the LRU is cold on every invocation, so every identity costs one lookup and the same window applies. `is_first_visit` is therefore **approximate**: good for charts, not for billing or legal decisions.
- **Semantics** are "no row with this identity exists", not "first session". A visitor who consents later is `true` on their first _consented_ visit.
- **IP identity is weak**: shared NATs merge people, `truncate` merges neighbours, `hash` salt rotation resets everyone. Prefer `userId` when you have one.
- **Erasure**: when the host deletes a person's rows, a running process still remembers them (LRU) until restart or eviction, and stored flags of other rows are not recomputed.
- **Cost**: lookups need the indexes from 6.3; without them each new identity scans the table.
- The dashboard can show this column instead of computing at read time with `newVsReturning.source: 'column'`: cheaper per request, but it inherits all of the above. Rows written while the option was off have NULL and show as `unknown`.

---

## 9. Queue, batching, backpressure

- **Queue**: an in-memory array bounded by `queue.maxSize` (10 000). `track()` pushes the _built row_ (already consent-stripped and normalised) so a later config or consent change cannot affect queued data.
- **Triggers**: flush when length >= `batchSize` (200) or `flushIntervalMs` (1 s) elapses. The timer is `unref()`ed so it never keeps the process alive.
- **Writer**: exactly one batch in flight per instance. Batch size = `min(batchSize, floor(dialect.maxParams / insertColumns.length), dialect.maxRowsPerInsert)` (SQL Server: at most 1 000 rows and 2 100 parameters, so about 210 rows with 10 columns).
- **Insert**: one multi-row parameterised `INSERT ... VALUES (...),(...)`.
- **Retry**: for errors `driver.isTransient` flags: `retry.attempts` (3) with exponential backoff and full jitter (200 ms base, 5 s cap). Then the batch is dropped and `onError(insert_failed, dropped: n)` fires.
- **Poison rows**: on a _data or constraint_ error (SQLSTATE class 22/23, MySQL duplicate/truncation/null errors, SQL Server 515/547/2601/2627/...), the batch is retried **row by row once**, so one bad row loses one event, not 200. A permanent error that would fail **every** row (permission denied, missing table or column, read-only) is **not** retried row by row: the batch is failed once and a **circuit opens** (1 s, doubling to 60 s while it keeps failing); batches arriving while it is open are counted as failed without touching the database. The first successful insert closes the circuit. (QA F-04)
- **Backpressure when full**:
  - `drop` (default): the new event is dropped (`status: 'dropped', reason: 'queue_full'`). Drops are counted and reported through `onError(queue_full, count)` at most once per second.
  - `block`: `track()`'s promise stays pending until there is space, at most `maxBlockMs`; then it resolves `dropped/block_timeout`. Only callers that `await track()` are slowed; fire-and-forget callers are not. **At most `queue.maxSize` callers may wait** (F-16): beyond that `track()` resolves `dropped/queue_full` immediately, so pending calls (each retaining its visit) cannot grow with the request rate.
- **`flush()`**: waits until every event queued _at call time_ is written or permanently failed; honours `timeoutMs`; never rejects; returns counts. **Serverless**: call `await dyn.flush()` before the handler returns (or use the platform's `waitUntil`); a frozen process loses its queue.
- **`close()`**: marks closed (later `track()` -> `dropped/closed`), flushes with a default 5 s cap (events still queued after that are counted as failed), clears timers, closes an owned pool. The package installs **no process signal handlers**; the README shows `process.on('SIGTERM', () => dyn.close())`.
- **Loss and duplication model (be honest in docs)**: the queue is in-memory. A crash or `kill -9` loses up to `maxSize` events. Retries are **at-least-once**: if the database committed a batch but the acknowledgement was lost (connection reset after send), the retry inserts the rows again (F-30). There is no event id to deduplicate on. This is analytics, not a ledger.

---

## 10. Read handler contract (what the dashboard builds against)

### 10.1 Creating it

```ts
import { createHandler, toNodeListener, toFetchHandler } from 'dynalitics/handler';
import { dashboardHtml } from 'dynalitics-dashboard/html';

const handler = createHandler(dyn, {
  authorize: (req) => isAdmin(req.raw), // REQUIRED. createHandler throws if missing / not a function
  basePath: '/admin/analytics', // default '/'; prefix the host mounts it under
  dashboardHtml, // optional string; enables GET {basePath}/
  pii: { reveal: false, maskUserId: true }, // reveal: default false, ip/email/username/userId are always masked; maskUserId: default true
  scope: { column: 'tenant_id', value: 7 }, // or a list, or 'none'. Without it the handler warns that it reads every row (F-08)
  authorizeTimeoutMs: 5000, // a hung authorize() is a 500 (F-01)
  limits: {
    maxRangeDays: 92,
    maxBuckets: 800,
    topPagesMax: 100,
    recentMax: 100,
    timeoutMs: 10_000,
    concurrency: 4,
  },
  newVsReturning: {
    enabled: true, // false -> widget reports unavailable / disabled_by_host
    source: 'computed', // 'computed' (read-time, 8.5.1, default) | 'column' (write-time column, 8.5.2)
    ipIdentity: 'auto', // 'auto' | 'always' | 'never' (8.5.1)
    maxRangeDays: 31, // stricter cap for this widget only: 400 range_too_large beyond it
  },
  cacheTtlMs: 0, // optional micro-cache per (route, params, mask mode); default off
  onError: (e) => log(e), // ReadErrorInfo { route, status, code, message, cause? }: never the request (F-40)
});

// Express:      app.use('/admin/analytics', toNodeListener(handler));
// Next.js App Router (app/admin/analytics/[[...path]]/route.ts):
export const GET = toFetchHandler(handler);
```

`dyn` must have a **reader** credential (4.5); a tracking-only instance (`connection: { writer }`) makes `createHandler` throw.

### 10.2 Framework-agnostic types

```ts
export interface DynaliticsRequest {
  method: string; // upper-case
  path: string; // relative to basePath, starts with '/', no query string
  query: Readonly<Record<string, string | readonly string[]>>;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>; // lower-case names
  raw: unknown; // the original request object (Express req, Fetch Request...), for authorize()
}
export interface DynaliticsResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface DynaliticsHandler {
  handle(req: DynaliticsRequest): Promise<DynaliticsResponse>;
}

export type AuthResult = boolean | { allowed: boolean; revealPii?: boolean };
export type Authorize = (req: DynaliticsRequest) => AuthResult | Promise<AuthResult>;
```

Adapters build `DynaliticsRequest` from `IncomingMessage` (`req.url`, mount path already stripped by Express; otherwise `basePath` is stripped) or from a Fetch `Request` (`new URL(request.url).pathname` minus `basePath`). Request bodies are never read.

### 10.3 Common rules

- **Only `GET`** (other methods -> `405` with `Allow: GET`). No cookies are set. No CORS headers are emitted (cross-origin use is the host's decision and is out of scope).
- **Order**: `authorize` runs **first for every request**, including unknown paths, so an unauthenticated caller learns nothing about which routes exist. It must return the boolean `true` or a plain object with `allowed === true` to proceed; `false`/`{ allowed: false }` -> `403 forbidden`; **any other return value** (a string, a number, `{}`, `{ allowed: 'true' }`, `null`) -> `403` and `onError(authorize_invalid_result)` (F-01). `revealPii` counts only when it is exactly `true`. `authorize` throwing, rejecting or not settling within `authorizeTimeoutMs` (default 5000) -> `500 internal` (fail closed), and the error goes to `onError`. `authorize` is never skipped, cached or defaulted.
- **Routing (F-17)**: after `authorize` and the method check, the path must match `^(/|(/[A-Za-z0-9_-]+)+)$` exactly and be a known route; otherwise `404`. There is no percent-decoding, no case folding, no trailing-slash tolerance, no `..` or `//` handling: those characters simply never match. The base path is removed exactly once: by the Fetch adapter always, by the Node adapter unless the framework already did (Express sets `req.baseUrl`), so a request that repeats the prefix cannot be routed as `/api/meta`. A path that merely starts with the base (`/adminX/...` for base `/admin`) is not stripped. `HEAD` and `OPTIONS` are `405`.
- **Strict parameters**: unknown query parameter, duplicated parameter or a query string > 2 KB -> `400 invalid_parameter`. There is no way to pass SQL, a column name or a sort order. The only filter is the explorer's `q` (section 18), which names allow-listed fields and whose values are always bound. Every parameter is parsed with an anchored regex/enum before use.
- **Time**: all instants are UTC ISO-8601 strings. Query params `from`/`to` accept `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss(.sss)?Z`; the interval is half-open `[from, to)`. Defaults: `to` = now, `from` = `to` - 7 days. `to - from` must be > 0 and <= `maxRangeDays` (92), else `400 range_too_large`. `interval` is one of `hour | day | week | month`; `week` starts Monday 00:00 UTC; `month` on the 1st. If the range would produce more than `maxBuckets` (800) buckets -> `400 range_too_large`.
- **Zero filling**: time-series responses contain **every** bucket in the range, with 0 for empty ones (the server fills gaps), so the chart never has to.
- **Headers on every response**: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Content-Type: application/json; charset=utf-8` (HTML for the page).
- **Limits**: at most `concurrency` (4) database queries run at once for the handler (a semaphore; extra requests wait up to the timeout, then `503`); each query has `timeoutMs` (10 s, enforced by the driver) -> `504 timeout`. No pagination on aggregates, hard caps instead.
- **Rate limiting is the host's job** (put it in front of the route, or inside `authorize`).

### 10.4 Envelope and errors

```ts
export type ApiResponse<T> =
  | { success: true; data: T; unavailable: null; error: null; meta: ResponseMeta }
  | { success: true; data: null; unavailable: Unavailable; error: null; meta: ResponseMeta } // HTTP 200
  | {
      success: false;
      data: null;
      unavailable: null;
      error: { code: ErrorCode; message: string; param?: string };
    };

export interface Unavailable {
  reason: UnavailableReason;
  message: string; // fixed English sentence, safe to show; still escape it
}
export type UnavailableReason =
  | 'no_identity_column' // neither userId nor ip is mapped to a column
  | 'identity_not_reliable' // only ip is mapped, and ip.mode is truncate
  | 'disabled_by_host' // newVsReturning.enabled === false
  | 'column_not_mapped'; // newVsReturning.source is 'column' but the isFirstVisit column is not enabled/mapped

export interface ResponseMeta {
  generatedAt: string;
  from?: string;
  to?: string;
  interval?: Interval;
  piiMasked: boolean;
  cached: boolean;
}
export type Interval = 'hour' | 'day' | 'week' | 'month';
export type ErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_parameter'
  | 'range_too_large'
  | 'timeout'
  | 'unavailable'
  | 'internal';
```

**`unavailable` is not an error.** A widget that cannot be computed because of how the table is mapped or configured answers `200` with `success: true`, `data: null` and an `unavailable` object, so the UI can show "not available: <message>" in the widget's slot instead of an error banner. The error code `unavailable` (HTTP 503) in the table below is unrelated: it means the database could not be reached. The two names are unfortunate and kept because the user-facing term was requested; clients must discriminate on the envelope (`error !== null` vs `unavailable !== null`).

Example:

```json
{
  "success": true,
  "data": null,
  "unavailable": {
    "reason": "no_identity_column",
    "message": "New vs returning needs a user id or IP address column, and neither is configured."
  },
  "error": null,
  "meta": { "generatedAt": "2026-10-30T12:05:00.000Z", "piiMasked": true, "cached": false }
}
```

| code                 | HTTP | when                                               |
| -------------------- | ---- | -------------------------------------------------- |
| `forbidden`          | 403  | `authorize` said no                                |
| `not_found`          | 404  | unknown route (after authorize)                    |
| `method_not_allowed` | 405  | not GET                                            |
| `invalid_parameter`  | 400  | bad/unknown/duplicate parameter (`param` names it) |
| `range_too_large`    | 400  | range or bucket count over the limit               |
| `timeout`            | 504  | query exceeded `timeoutMs`                         |
| `unavailable`        | 503  | database error or no free query slot               |
| `internal`           | 500  | anything else (including `authorize` failures)     |

`message` is a fixed, generic English sentence per code (plus the parameter name). **Never** SQL, driver text, table names, or connection details.

### 10.5 Routes (all `GET`, relative to `basePath`)

#### `GET /` (only if `dashboardHtml` was supplied; else `404`)

Returns the HTML page, `Content-Type: text/html; charset=utf-8`, plus
`Content-Security-Policy: default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` and `X-Frame-Options: DENY`.

#### `GET /api/meta`

Bootstrap for the UI. No parameters. **Drive the UI from this response**: which widgets exist, which fields are real, which limits apply.

```json
{
  "success": true,
  "error": null,
  "unavailable": null,
  "data": {
    "version": 2,
    "now": "2026-10-30T12:05:00.000Z",
    "intervals": ["hour", "day", "week", "month"],
    "limits": {
      "maxRangeDays": 92,
      "maxBuckets": 800,
      "topPagesMax": 100,
      "recentMax": 100,
      "newVsReturningMaxRangeDays": 31
    },
    "defaults": { "rangeDays": 7, "interval": "day", "topPagesLimit": 10, "recentLimit": 25 },
    "breakdowns": [
      { "key": "consent", "label": "consent" },
      { "key": "plan", "label": "plan" }
    ],
    "widgets": {
      "visitsOverTime": { "available": true },
      "topPages": { "available": true },
      "consentRate": { "available": true },
      "newVsReturning": {
        "available": true,
        "source": "computed",
        "basis": "user_id_then_ip",
        "approximate": true
      },
      "recentVisits": { "available": true }
    },
    "fields": {
      "id": true,
      "ipAddress": true,
      "userId": true,
      "username": true,
      "email": false,
      "isFirstVisit": true
    },
    "features": { "recentVisitsCursor": true, "piiRevealable": false }
  },
  "meta": { "generatedAt": "2026-10-30T12:05:00.000Z", "piiMasked": true, "cached": false }
}
```

An unavailable widget looks like `"newVsReturning": { "available": false, "reason": "identity_not_reliable", "message": "..." }` (same `reason` and `message` the route itself returns, so the UI can decide before calling it).

- `breakdowns` = `consent`, every declared custom field (or promoted column) with `breakdown: true`, and `isFirstVisit` **only** when `firstVisit.enabled` and the column is mapped (write-time column, 8.5.2). Table and column names are never exposed.
- `widgets.newVsReturning.source` is `computed` or `column`. `basis` is `user_id`, `ip` or `user_id_then_ip`. `approximate` is `true` whenever IP is part of the identity.
- `fields.<name>` is `false` when the role is unmapped (3.2); `recent-visits` then returns `null` for it on every row, and the UI should drop the column. `fields.isFirstVisit` is `true` when the new-vs-returning widget is available (the per-row flag is computed from the same rules). `fields.id` false means no `nextCursor`.
- `features.recentVisitsCursor` is `fields.id`. `features.piiRevealable` is true only when `pii.reveal` is configured **and** this request's `authorize` allowed it.

#### `GET /api/visits-over-time?from&to&interval&breakdown`

`breakdown` (optional) is a `key` from `meta.breakdowns`. Anything else -> `400`.

```json
{
  "success": true,
  "error": null,
  "unavailable": null,
  "data": {
    "interval": "day",
    "points": [
      { "bucket": "2026-10-24T00:00:00.000Z", "visits": 0 },
      { "bucket": "2026-10-25T00:00:00.000Z", "visits": 412 },
      { "bucket": "2026-10-26T00:00:00.000Z", "visits": 389 }
    ],
    "total": 801,
    "breakdown": {
      "key": "plan",
      "series": [
        {
          "value": "pro",
          "isOther": false,
          "points": [{ "bucket": "2026-10-25T00:00:00.000Z", "visits": 120 }]
        },
        {
          "value": "free",
          "isOther": false,
          "points": [{ "bucket": "2026-10-25T00:00:00.000Z", "visits": 200 }]
        },
        {
          "value": null,
          "isOther": false,
          "points": [{ "bucket": "2026-10-25T00:00:00.000Z", "visits": 92 }]
        },
        {
          "value": null,
          "isOther": true,
          "points": [{ "bucket": "2026-10-25T00:00:00.000Z", "visits": 0 }]
        }
      ]
    }
  },
  "meta": {
    "generatedAt": "...",
    "from": "2026-10-24T00:00:00.000Z",
    "to": "2026-10-31T00:00:00.000Z",
    "interval": "day",
    "piiMasked": true,
    "cached": false
  }
}
```

`breakdown` is absent without the parameter. Series values are strings (`isFirstVisit`/`consent` as `"true"`/`"false"`); `value: null` with `isOther: false` means **"rows without a value for this field"** (F-37): a row has none when the field was not supplied, or when its consent was denied (denied rows store no custom data unless the field has `keepWhenDenied`). `isOther: true` aggregates everything beyond the **top 10** values by volume. Every series has a point for every bucket (zero filled).

#### `GET /api/top-pages?from&to&limit`

`limit` integer 1..`topPagesMax`, default 10.

```json
{
  "data": {
    "totalVisits": 801,
    "pages": [
      { "page": "/pricing", "visits": 310, "share": 0.387 },
      { "page": "/", "visits": 280, "share": 0.35 }
    ],
    "otherVisits": 211
  },
  "...": "envelope as above"
}
```

`share` = visits / `totalVisits` (0..1, 3 decimals). `otherVisits` = visits on pages outside the returned list. `page` is visitor-influenced text: **the dashboard must escape it** (10.9).

#### `GET /api/new-vs-returning?from&to&interval`

Computed at read time (definition: 8.5.1, SQL: 10.11). The range may not exceed `limits.newVsReturningMaxRangeDays` (default 31): `400 range_too_large` beyond it. May answer `unavailable` (see 10.4) or time out (`504`) on very large tables.

```json
{
  "success": true,
  "error": null,
  "unavailable": null,
  "data": {
    "interval": "day",
    "source": "computed",
    "basis": "user_id_then_ip",
    "approximate": true,
    "points": [
      { "bucket": "2026-10-25T00:00:00.000Z", "new": 90, "returning": 250, "unknown": 72 }
    ],
    "totals": { "new": 90, "returning": 250, "unknown": 72 }
  },
  "meta": {
    "generatedAt": "...",
    "from": "...",
    "to": "...",
    "interval": "day",
    "piiMasked": true,
    "cached": false
  }
}
```

- `new` in a bucket = identities whose first-ever row (anywhere in the table, not only in the range) falls in that bucket. `returning` = identified visits in the bucket that are not a first-ever row. `unknown` = visits with no consent, or with consent but no usable identity. `new + returning + unknown` equals the bucket's total visits, and equals `visits-over-time` for the same range. Zero-filled.
- `source`: `"computed"` (default) or `"column"` (opt-in write-time column; then `unknown` also contains rows written before the option was enabled).
- `basis` says which identity was used, `approximate` whether IP was involved. **The UI should show a caveat when `approximate` is true** (shared addresses merge people; hashed IPs reset when the salt rotates).
- A visitor first seen shortly before `from` is `returning` in this range. That is the intended meaning.

#### `GET /api/consent-rate?from&to&interval`

```json
{
  "data": {
    "interval": "day",
    "points": [
      { "bucket": "2026-10-25T00:00:00.000Z", "granted": 340, "denied": 72, "rate": 0.825 }
    ],
    "totals": { "granted": 340, "denied": 72, "rate": 0.825 }
  }
}
```

`rate` = granted / (granted + denied), `null` when both are 0. A `NULL` consent value (possible in an existing table) counts as `denied`.

#### `GET /api/recent-visits?from&to&limit&cursor&pii`

`limit` 1..`recentMax`, default 25. `cursor`: opaque string from a previous `nextCursor` (the server parses it with a strict anchored pattern into `(timestamp, id)` and binds both as parameters; anything else -> `400`). `pii`: only `reveal` is accepted (see 10.6). Ordered newest first, ties by `id` descending. `from`/`to` default to the last 7 days and obey the range limit.

```json
{
  "success": true,
  "error": null,
  "unavailable": null,
  "data": {
    "visits": [
      {
        "id": "18231",
        "timestamp": "2026-10-30T12:01:44.120Z",
        "pageVisited": "/pricing",
        "consent": true,
        "isFirstVisit": false,
        "ipAddress": "203.0.x.x",
        "userId": "u_***42",
        "username": "j***",
        "email": "j***@example.com",
        "custom": { "plan": "pro", "campaign": "***" }
      },
      {
        "id": "18230",
        "timestamp": "2026-10-30T12:01:02.004Z",
        "pageVisited": "/",
        "consent": false,
        "isFirstVisit": null,
        "ipAddress": null,
        "userId": null,
        "username": null,
        "email": null,
        "custom": null
      }
    ],
    "nextCursor": "MjAyNi0xMC0zMFQxMjowMTowMi4wMDRafDE4MjMw"
  },
  "meta": { "generatedAt": "...", "from": "...", "to": "...", "piiMasked": true, "cached": false }
}
```

`id` is a **string** (64-bit safe) and is `null` when the `id` role is unmapped (then `nextCursor` is always `null`). `nextCursor` is `null` on the last page. Only declared custom fields are returned. A field whose role is unmapped (3.2) comes back as `null` on every row, so the shape of a visit is constant; `GET /api/meta` `fields` says which ones are real. `isFirstVisit` is computed per row at read time (8.5.1, 10.11) by default, is `null` for rows without consent or identity, and is `null` on every row when the new-vs-returning widget is unavailable.

### 10.6 PII masking

Masking applies to `recent-visits` and `search` (18.3), which return rows; the other routes are aggregates and contain no personal fields. Default = masked.

| field                               | masked form             | rule                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ipAddress`                         | `203.0.x.x`             | IPv4: keep first two octets. IPv6: first two groups then `::x`. Hashed values: first 8 hex chars plus `…`. NULL stays NULL.                                                                                                                                                                   |
| `email`                             | `j***@example.com`      | first character of the local part + `***` + domain                                                                                                                                                                                                                                            |
| `username`                          | `j***`                  | first character + `***` (`***` if empty)                                                                                                                                                                                                                                                      |
| `userId`                            | `u_***42`               | **masked by default** (`pii.maskUserId`, default true; F-06): first two and last two characters of ids of at least 6 characters, `***` for shorter ones (so at most 4 characters are ever shown); an id containing `@` is masked as an email. Revealed only under the triple condition below. |
| custom fields with `personal: true` | `"***"` (when non-null) | non-personal ones are returned as stored                                                                                                                                                                                                                                                      |

**Unmasking requires three things at once**: (1) `pii: { reveal: true }` in `createHandler`; (2) `authorize` returned `{ allowed: true, revealPii: true }` for this request; (3) the request has `?pii=reveal`. Anything less -> masked, and `meta.piiMasked` tells the UI which it got. If the query asks for `reveal` but (1) or (2) is not satisfied, the response is **masked**, not an error (so the UI can simply ask and display what it gets).

**Masking is total and fails closed (F-12).** Every masking function accepts any string. IPv4 must be exactly four dotted numbers, IPv6 colon-hex groups, a hash exactly 64 hex characters, an e-mail exactly one `local@domain` without whitespace; anything else (lists like `1.2.3.4, 5.6.7.8`, ports, zone ids, words such as `unknown`) becomes the fixed `***`. Property tests feed thousands of random strings and check that the output is `null`, a fixed shape or `***`. The reader credential can still read the full columns (see 14, objection on F-13); masking happens in the handler.

### 10.7 Breakdown safety

- Allowed dimensions: `consent`, `isFirstVisit` (**only** when the write-time column is enabled and mapped, 8.5.2), and custom fields declared `personal: false, breakdown: true` (JSON key or promoted column). Extra columns (3.6) are never dimensions.
- The request supplies only the **name** `breakdown=plan`; the server looks it up in a `Map` built at startup from the config. The JSON path text (`'$.plan'`, `->> 'plan'`) is built from the **config's** key, which already passed `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, and is checked again where the SQL is composed.
- PII columns (`ip`, `email`, `username`, `userId`) can never be a dimension. There is no code path that accepts an arbitrary key.
- SQL shape for a JSON key: PG `("custom" ->> 'plan')`, MySQL `JSON_UNQUOTE(JSON_EXTRACT(` + "`custom`" + `, '$.plan'))`, SQL Server `JSON_VALUE([custom], '$.plan')`.
- Cardinality is bounded: query 1 finds the top 10 values in the range (`LIMIT 10`), query 2 returns bucket x value only for those (bound parameters) plus NULL, and "other" = bucket total - listed values.

### 10.8 Serving the HTML dashboard

`dynalitics-dashboard` exports `dashboardHtml: string` (from `dynalitics-dashboard/html`), a complete single-file page. The host passes it to `createHandler`. For each `GET /`, the handler replaces two placeholders in the string and sends it with the CSP above:

- `%%DYNALITICS_NONCE%%` -> a fresh per-request nonce (16 random bytes, base64url). The page must put it on every inline `<script>` and `<style>`.
- `%%DYNALITICS_BASE%%` -> the **normalised** base path (F-07): `basePath` is `/` or `/seg/seg` (segments `[A-Za-z0-9_-]+`, at most one trailing slash, which is dropped); the root is substituted as the **empty string**, and the value always matches `^(/[A-Za-z0-9_-]+)*$`. Used as `<meta name="dynalitics-base" content="%%DYNALITICS_BASE%%">`. The script derives its API URL as `base + '/api/...'` with `fetch(..., { credentials: 'same-origin' })`, so the root yields `/api/meta` and never `//api/meta`.

### 10.9 Rules for the dashboard author

1. Treat **every string from the API as hostile**: `pageVisited`, `username`, `email`, `userId`, `ipAddress`, custom values, breakdown `value`s. Use `textContent` / `setAttribute` of text nodes, or React's default escaping. No `innerHTML`, no `dangerouslySetInnerHTML`, no `eval`, no `new Function`, no string-built `href`s from data.
2. The CSP forbids inline `style="..."` attributes and inline event handlers. Use classes, `<style nonce>`, SVG presentation attributes, or `element.style.prop = ...` (CSSOM is allowed).
3. Never call anything but `{base}/api/*` on the same origin. No third-party scripts, fonts or images (CSP would block them anyway).
4. Handle `success:false` envelopes and HTTP 4xx/5xx (`403` -> "not authorised", `504` -> "query timed out, narrow the range"). Do not retry in a tight loop.
5. Use `meta.piiMasked` to label masked values; do not try to unmask on the client.
6. Wire types live in `packages/dynalitics/src/protocol.ts` (`dynalitics/protocol`, types only). The dashboard keeps a vendored copy and CI diffs the two (decision in section 14).
7. **Render `unavailable`** (`success: true`, `data: null`, `unavailable: { reason, message }`) as a normal, calm state in the widget's slot: show the `message` (escaped) and keep the rest of the dashboard working. It is not an error and must not trigger error styling or retries.
8. **Show the `approximate` caveat** on the new-vs-returning widget when `approximate` is true, and say what `unknown` means (no consent, or no usable identity). Do not present the three numbers as a complete census of people.
9. **Drive the UI from `/api/meta`**: render only widgets with `available: true`, drop `recent-visits` columns whose `fields.<name>` is `false`, offer only the listed `breakdowns`, and respect `limits` when building date pickers (the new-vs-returning range cap is smaller than the general one). Do not hard-code field names or assume `isFirstVisit` can be a breakdown.
10. **The base path may be the empty string** (F-07): use it as a prefix, never test it for truthiness, never default it to `/`.
11. **`userId` arrives masked** (`u_***42`) unless revealed; render it as received, label it like the other masked values (F-06).

### 10.10 Example SQL (PostgreSQL) for `visits-over-time`

```sql
SELECT to_char(date_trunc('day', "visited_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
       COUNT(*) AS visits
FROM "public"."dynalitics_events"
WHERE "visited_at" >= $1 AND "visited_at" < $2
GROUP BY 1 ORDER BY 1
```

`$1`/`$2` are UTC instants bound as parameters. Other dialects use `DATE_FORMAT(...)` / `CONVERT(varchar(30), DATEADD(day, DATEDIFF(day, 0, [visited_at]), 0), 127)`. SQL Server weeks use `DATEADD(day, (DATEDIFF(day, '19000101', ts) / 7) * 7, '19000101')` (1900-01-01 is a Monday) so results do not depend on `DATEFIRST`.

### 10.11 Example SQL (PostgreSQL) for read-time `new-vs-returning`

Definition and semantics: 8.5.1. `$1` = `from`, `$2` = `to` (bound UTC instants). Any scoping constants (3.6) add `AND "tenant_id" = $n` (bound) to **every** query below, including the probes. Boolean columns use `"consent"`; integer-encoded ones use `"consent" = 1`. Three queries, all `SELECT`, issued through the reader.

```sql
-- Q1: totals and identified visits per bucket (identified = consent AND has an allowed identity)
SELECT to_char(date_trunc('day', "visited_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE "consent" AND ("user_id" IS NOT NULL OR "ip_address" IS NOT NULL)) AS identified
FROM "public"."dynalitics_events"
WHERE "visited_at" >= $1 AND "visited_at" < $2
GROUP BY 1 ORDER BY 1;
-- (when IP identity is not allowed, the identified filter is just  "consent" AND "user_id" IS NOT NULL)

-- Q2: new user identities per bucket = first row in range, and no earlier row anywhere
SELECT to_char(date_trunc('day', m.first_ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
       COUNT(*) AS new_count
FROM (
  SELECT "user_id", MIN("visited_at") AS first_ts
  FROM "public"."dynalitics_events"
  WHERE "visited_at" >= $1 AND "visited_at" < $2 AND "consent" AND "user_id" IS NOT NULL
  GROUP BY "user_id"
) m
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."dynalitics_events" p
  WHERE p."user_id" = m."user_id" AND p."visited_at" < $1          -- index (user_id, visited_at): one seek per identity
)
GROUP BY 1 ORDER BY 1;

-- Q3: same for IP identities, only rows WITHOUT a user_id, only when IP identity is allowed
SELECT to_char(date_trunc('day', m.first_ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS bucket,
       COUNT(*) AS new_count
FROM (
  SELECT "ip_address", MIN("visited_at") AS first_ts
  FROM "public"."dynalitics_events"
  WHERE "visited_at" >= $1 AND "visited_at" < $2 AND "consent" AND "user_id" IS NULL AND "ip_address" IS NOT NULL
  GROUP BY "ip_address"
) m
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."dynalitics_events" p
  WHERE p."ip_address" = m."ip_address" AND p."visited_at" < $1    -- any earlier row with this address, even one with a user_id
)
GROUP BY 1 ORDER BY 1;
```

The JS side then computes per bucket: `new = Q2 + Q3`, `returning = max(0, identified - new)`, `unknown = total - identified`, and zero-fills. When no `userId` role is mapped, the `"user_id" IS NULL` condition and Q2 are dropped and Q3 stands alone; when IP identity is not allowed Q3 is skipped. Equivalent forms for MySQL (`consent = 1`, `NOT EXISTS` is supported, buckets via `DATE_FORMAT`) and SQL Server (`consent = 1`, bucket via the `DATEDIFF`/`DATEADD` expression in 10.10) use the same structure.

Per-row form for `recent-visits` (applied to the page's rows only, at most `recentMax`): `isFirstVisit` = `NULL` if consent is not true or there is no identity; otherwise `NOT EXISTS (SELECT 1 FROM t p WHERE p.<identity col> = r.<identity col> AND (p."visited_at" < r."visited_at" OR (p."visited_at" = r."visited_at" AND p."id" < r."id")))`, or the timestamp-only comparison when `id` is unmapped. MySQL and SQL Server wrap it as `CASE WHEN NOT EXISTS (...) THEN 1 ELSE 0 END`.

---

## 11. Threat model and mitigations

Assets: the DB credential; personal data in the table; the host application's availability; the integrity of the stats.
Trust boundaries: (a) host code -> `track()` inputs (often visitor-controlled), (b) browser -> read endpoint, (c) package -> database, (d) npm supply chain.

| #   | Threat                                                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | SQL injection through visit values                                                                    | All values bound as parameters (section 5.1); unit tests with an injection corpus on every field; SQL text asserted free of user characters                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T2  | SQL injection through identifiers (table, column, schema)                                             | Strict pattern `^[A-Za-z_][A-Za-z0-9_]{0,62}$` + per-dialect quoting with escape-doubling; config-time only, never from requests                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T3  | Injection via JSON keys (breakdowns) or the paging cursor                                             | Keys come from validated host config, requests pick names from a `Map` allow-list; cursor parsed by anchored regex into typed values, then bound                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T4  | Connection string / password leaks in errors, logs, stats                                             | `redact()` removes the exact string, `user:pass@` URLs and `password=`/`pwd=` pairs from every message; driver errors are never attached as `cause`, a sanitised copy is; startup test greps all thrown errors and log output for a canary password                                                                                                                                                                                                                                                                                                                                            |
| T5  | PII exposure from the dashboard                                                                       | `authorize` mandatory (handler refuses to be created without it, runs first on every request), masking by default, triple condition to reveal, no PII breakdowns, `no-store`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T6  | XSS via stored visitor strings                                                                        | Output escaping rules (10.9), strict CSP with nonce, `nosniff`; `pageVisited` query stripped and control characters removed at write time; QA injects `<img onerror>` payloads end to end                                                                                                                                                                                                                                                                                                                                                                                                      |
| T7  | Clickjacking / CSRF on the dashboard                                                                  | `frame-ancestors 'none'`, GET only and read-only, no CORS headers, no state change anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T8  | DoS by flooding `track()`                                                                             | Bounded queue, drop policy, per-event size limits, coalesced error reporting. The host must still rate-limit any public endpoint that calls `track()`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T9  | DoS through expensive reads                                                                           | Fixed queries, range cap (92 d), bucket cap (800), page-size caps, per-query timeout, concurrency semaphore, optional micro-cache                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T10 | Over-privileged DB user                                                                               | Two credentials by default: writer INSERT only, reader SELECT only (4.5); generated GRANTs per role (6.1, 6.3); advisory "seems to have more privileges" warning per credential (7.5); single-credential mode logs a warning                                                                                                                                                                                                                                                                                                                                                                   |
| T11 | Forged analytics (a public beacon endpoint)                                                           | Out of scope: no ingestion endpoint is shipped. If the host builds one, it owns authentication, rate limiting and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T12 | IP spoofing through `X-Forwarded-For`                                                                 | The package never parses forwarded headers; the host supplies the trusted address                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T13 | Prototype pollution via custom keys                                                                   | Key pattern + denylist (`__proto__`, `constructor`, `prototype`), `Object.create(null)`/`Map`, `Object.hasOwn`, no deep merge anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T14 | Log injection                                                                                         | Control characters stripped from stored strings; log messages built from codes and counts, not raw visitor strings                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T15 | Supply chain                                                                                          | Zero runtime deps in `dynalitics`; each driver lives in its own adapter package and is only installed by hosts that pick it (v0.5); `.npmrc` `ignore-scripts=true`, exact pins, lockfile committed, `npm ci` in CI, no `postinstall`, publish with provenance via trusted publishing (Dan's task), `files` allow-list, `npm audit` and `npm pack --dry-run` in CI. Residual risk: the drivers themselves (`mssql` pulls `tedious` and a large tree; only `dynalitics-mssql` users get it) and the exact driver pin in each adapter, which means a driver security fix needs an adapter release |
| T16 | Code execution                                                                                        | No `eval`, `new Function`, dynamic `require`, or variable-specifier `import()` (lint rules enforce); the CLI reads JSON only                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| T17 | Plaintext DB traffic                                                                                  | Documented: use `sslmode=require` / `encrypt=true` for non-local databases; startup logs a warning if a non-local host is configured without TLS where the connection string makes that detectable (best effort)                                                                                                                                                                                                                                                                                                                                                                               |
| T18 | Re-identification of "anonymous" data                                                                 | Documented limits: hashed and truncated IPs are still personal data under GDPR; `userId`, `email`, `username` are plain; legal basis, retention and erasure are the host's job (README section, not code)                                                                                                                                                                                                                                                                                                                                                                                      |
| T19 | Credential exposure through the CLI                                                                   | `inspect` takes the connection string only from a named environment variable, refuses anything that looks like a connection string on argv, and never prints it; all output is redacted. `sql` never reads or opens one. Tests grep stdout, stderr and the error for a canary password and for the process argv                                                                                                                                                                                                                                                                                |
| T20 | `inspect` used to modify data                                                                         | Only catalog `SELECT`/`WITH` statements are issued (driver wrapper allow-list asserted in tests), read-only session where available, no `--out`, fix SQL is printed text. It still reads schema metadata, so use a read-only user                                                                                                                                                                                                                                                                                                                                                              |
| T21 | Host-computed column functions (`extraColumns.compute`)                                               | They run in the host process with host privileges: dynalitics treats them as trusted code but never as trusted output (result type/length validated, bound as a parameter, exceptions contained). Documented: keep them pure and fast, they run inside `track()` and are not time-limited                                                                                                                                                                                                                                                                                                      |
| T22 | Dashboard reads rows of other tenants in a shared table                                               | Scoping constants (3.6) are appended to every read query including first-visit probes; configured by the host, never by the request. Without a constant there is no scoping, which `inspect` and the README call out                                                                                                                                                                                                                                                                                                                                                                           |
| T23 | Expensive read-time new-vs-returning used as a DoS lever                                              | Behind `authorize`; range cap 31 d for that widget; query timeout; concurrency semaphore shared with all routes; optional micro-cache; `newVsReturning.enabled: false`; no client-controlled shape (T9)                                                                                                                                                                                                                                                                                                                                                                                        |
| T24 | Hostile or surprising existing tables (triggers with side effects, partitions, views, odd collations) | Detect and warn best-effort (7.3), refuse views, strict identifier pattern, row-by-row fallback documented as able to re-fire external trigger effects. Not fully mitigable: writing into a table you do not control carries its risks                                                                                                                                                                                                                                                                                                                                                         |
| T25 | Writer compromise reading back personal data                                                          | The default writer has INSERT only, no SELECT (4.5). With `firstVisit.enabled` the writer gets column-level SELECT on identity columns; that trade-off is documented and the setting is off by default                                                                                                                                                                                                                                                                                                                                                                                         |
| T26 | Cross-tenant reads in a shared table (reader config drifts from the writer's)                         | `scope` on `createHandler` adds a bound predicate to every read statement, probes included; creation logs a warning when no scope is configured; a statement-capture test checks that every table reference in every statement of every route (3 dialects) carries every scope predicate, and a real-database test shows another tenant's rows neither count nor make a visitor "returning"                                                                                                                                                                                                    |
| T27 | A timed-out read keeps running and bypasses the concurrency cap (F-05)                                | The slot is held until the driver settles; drivers cancel on the server at the deadline (pg_cancel_backend, MAX_EXECUTION_TIME, request.cancel) and destroy the connection; contract test per database: a 30 s sleep with a 1 s deadline leaves no server session within 2 s                                                                                                                                                                                                                                                                                                                   |
| T28 | Visitor values in error reports (F-02)                                                                | Data/constraint driver errors carry no message text; other messages are scrubbed of quoted values and capped; the handler's own `onError` payload never includes the request. Canary tests push an e-mail and a number through every data-error class on the real databases and grep `onError`, logger output and `stats()`                                                                                                                                                                                                                                                                    |
| T29 | Path-normalisation confusion (F-17)                                                                   | Exact match on canonical paths only; no decoding; the base path is removed once (Express `baseUrl` honoured); everything else is 404 after `authorize`                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 12. Testing strategy

Tooling: Vitest (already wired in `vitest.config.ts`), v8 coverage with an 80% threshold on lines/branches/functions/statements, enforced in CI where integration tests also run.

Layers:

1. **Unit** (no Docker, fast): config validator (every field, unknown keys, error paths), `buildColumnModel` (rename, disable, promote, collisions, reserved names), `buildRow` (full consent matrix from 8.2 plus a property test: _consent false => no personal data_), IP normalisation and modes (IPv4/IPv6/mapped/ports/zones/garbage), limits and control-character stripping, the opt-in write-time first-visit logic (LRU, batch lookup) with the fake driver, extra-column constants/computed values, role mapping and unmapped-role behaviour, queue (batching, timers with fake clocks, backpressure `drop`/`block`, retry/backoff, poison-row isolation, `flush`/`close` semantics, `maxParams` splitting), masking functions, redaction, cursor parsing, handler routing/auth order/parameter strictness (fake driver), **golden-file tests for generated SQL** per dialect (DDL, indexes, grants).
2. **Contract tests**: one shared suite run against each real adapter (`describe.each(['postgres','mysql','mssql'])`): introspection, every mismatch type, `fixSql` correctness, insert round-trip (unicode, emoji, max length, NULLs, JSON), time handling in a non-UTC session, bucket functions, JSON key extraction, timeouts, parameter-limit batching, privilege inspection.
3. **Integration / end to end** with **two real database roles**: the test setup creates writer and reader roles by executing the **generated GRANT statements** (test code may run DDL), then runs `createDynalitics` -> `track` -> `flush` -> real table -> `createHandler` -> HTTP response on the 3 DBs. Asserts: the writer **cannot SELECT** (permission denied) and the reader **cannot INSERT**; single-credential mode logs the 4.5 warning and `acknowledgeSingleCredential` silences it; the 7.5 warnings fire for a deliberately over-privileged user and not for the generated roles; with `firstVisit.enabled`, an INSERT-only writer yields `lookup_failed` with the documented hint until the column-level grant is applied. Multi-instance write-time first-visit duplicates are demonstrated, not hidden.
4. **The strong schema test**: generate SQL, run it (test code only) on an empty DB, validation passes; drop/alter each column in turn, expect the specific problem, **execute the printed live `fixSql`**, validation passes.
5. **Security tests**: injection corpus on values, identifiers, custom keys, breakdown names, cursor and query params; handler refuses to start without `authorize`, returns 403 on `false`, 500 on throw, authorize runs before 404; masking on by default and the three-way reveal; secret canary never appears in errors/logs/`stats()`/JSON/CLI output; XSS payload rendering in the dashboard (Playwright, Olivia); prototype-pollution keys; oversized payloads; scoping constants present in every read statement (statement capture).
6. **Lint as a test**: `no-eval`, `no-implied-eval`, `no-new-func`, `no-require-imports`, `no-floating-promises` are errors.
7. **Read-time new-vs-returning** (the riskiest new logic): a brute-force JavaScript oracle implements 8.5.1 row by row; property tests generate random datasets (users, IPs, ties on timestamp, denied consent, NULL consent, rows before/inside/after the range, legacy rows, multi-tenant constants) and require the SQL aggregates (10.11) and the per-row form to match the oracle on all 3 databases, for every `ipIdentity`/`ip.mode` combination. Plus: `unknown` rules, range cap, widget `unavailable` reasons, `approximate` flag, `source: 'column'`, and a timing guard that fails if the identity indexes are present but the plan scans the table (PG `EXPLAIN`, MySQL `EXPLAIN`, SQL Server showplan; best effort, documented as non-deterministic).
8. **Existing tables**: per dialect a set of legacy fixture tables created by test code: wide (60+ columns), integer `consent`, naive timestamps, MySQL `TIMESTAMP` with a non-UTC session, `uuid`/`int` user ids, `serial` id with and without sequence grant, NOT NULL unmapped column, nullable-vs-NOT NULL optional roles, a view, an INSERT trigger, a partitioned table (PG), case-insensitive collation, `utf8mb3`, 3-part names, names outside the identifier pattern. Each problem and warning in 7.3 is **snapshot-tested verbatim**; each printed live fix, when executed, makes validation pass; `extraColumns` constants/computed (including "not called without consent", "exception becomes NULL / rejection", "scope applied to reads"); length clamping; `skip` + existing is a config error; round-trip of timestamps for every column type in 3.9 under a non-UTC session.
9. **CLI**: `sql` runs with no driver installed and opens no socket (spy on `net.connect`/`tls.connect`); `inspect` against the legacy fixtures: mapping suggestions snapshot, problems equal the ones startup throws, exit codes, **every statement sent matches the allow-list** (`SELECT`/`WITH` or the read-only session statement), refuses connection strings on argv, missing env var, output free of the canary password, never writes a file.
10. **Error reporting canaries (F-02)**: a canary e-mail and number are pushed through type, unique, too-long, NOT NULL and out-of-range errors on the real databases (SQL Server for unique, too-long and NOT NULL in CI); the `onError` payload, logger output and `stats()` must not contain them.
11. **Cancellation contract (F-05)**: `pg_sleep(30)` / `SLEEP(30)` / `WAITFOR DELAY` with a 1 s deadline must leave **zero** matching sessions within 2 s (`pg_stat_activity`, `information_schema.processlist`, `sys.dm_exec_requests`), the error is a timeout where the database raises one, and the pool stays usable. A MySQL heavy-scan variant proves `MAX_EXECUTION_TIME` raises the timeout error. Mutation-checked: without the cancel call the PostgreSQL test fails.
12. **Scope (F-08)**: statement capture over every route and dialect, plus a two-tenant table on the real databases (aggregates, read-time new-vs-returning with a visitor seen only in the other tenant, per-row flag, pagination).
13. **Strict denied rows (F-03)**: the consent matrix, a property test of `deniedView()` (never an `ip`, `userId`, `username` or `email` key, whatever the input), `keepWhenDenied` per field, and the real-database rows.
14. **Routing and masking properties (F-12, F-17)**: random-string masking tests, canonical-path tests across the handler and both adapters, a real HTTP server for the Node adapter including Express's `baseUrl` behaviour.

Docker (`docker/compose.yml`, ports bound to `127.0.0.1`, health checks, throw-away test-only credentials in the compose file, never reused anywhere):

| DB         | image                                        |
| ---------- | -------------------------------------------- |
| PostgreSQL | `postgres:17-alpine` (smoke on `16`)         |
| MySQL      | `mysql:8.4`                                  |
| SQL Server | `mcr.microsoft.com/mssql/server:2022-latest` |

Integration tests are skipped unless `DYNALITICS_INTEGRATION=1`; connection strings come from `DYNALITICS_TEST_PG_URL`, `..._MYSQL_URL`, `..._MSSQL_URL`. Each test file creates a uniquely named table and drops it afterwards (test code is allowed DDL; the library is not). No Testcontainers (large dev dependency tree); plain compose plus a wait script. **Platform note:** the SQL Server image is amd64 only. Docker 29 on this Apple-silicon (arm64) machine runs it under emulation (slow, occasionally flaky); GitHub Actions `ubuntu-latest` (amd64) is the reliable place for the MSSQL suite.

---

## 13. Risks and open questions

Risks (see 14 for the ones I consider serious):

- R1 **Read-time new-vs-returning costs a range scan plus one index probe per distinct visitor on every request** (8.5.1). Fine for small and medium tables with the generated indexes; can hit the 10 s timeout at millions of distinct visitors per range; without the `(user_id, visited_at)` / `(ip_address, visited_at)` indexes it is unusable. Mitigations exist (range cap, cache, switch off, write-time column) but none removes the cost, and rollups are out of scope.
- R2 Write-time first-visit (opt-in) keeps all its old weaknesses: approximate, racy across instances, useless on serverless, stale after erasure (8.5.2). It also forces SELECT onto the writer.
- R3 Unbounded table growth and no erasure support: a retention policy and erasure are the host's job, but nothing in the package helps. At least a documented `DELETE` recipe belongs in the README.
- R4 Privilege, trigger, partition, index and collation detection is heuristic (MySQL roles, catalog visibility). A missing warning proves nothing.
- R5 Drivers move: `mssql` 12.x, `mysql2` 3.x, `pg` 8.x are the supported ranges today; each major needs a CI row.
- R6 The queue is in-memory; crashes and serverless freezes lose events.
- R7 The SQL Server image on arm64 for local development.
- R8 `GROUP BY` over a date range is fine with the `visited_at` index up to tens of millions of rows; beyond that the host needs rollups (out of scope).
- R9 MariaDB is not supported (its `JSON` is an alias for text with different functions). Say so in the README.
- R10 **Type tolerance trades safety for convenience.** Writing `1/0` into an integer `consent` column, UTC wall-clock values into naive timestamp columns, or truncating to a shorter real column works, but silently depends on conventions dynalitics cannot verify (for example that a legacy naive column really holds UTC). The warnings say so; they cannot fix wrong assumptions.
- R11 **Writing into a table we do not own**: triggers, partitions, foreign keys and replication behave in ways the catalog queries only partly reveal. Two real PostgreSQL traps are on record: a `serial` id needs `USAGE` on its sequence even for an INSERT-only writer, and an INSERT-only writer on a catalog that hides columns cannot validate the structure by itself (4.5).
- R12 `extraColumns.compute` runs host code inside `track()` with no time limit; a slow function slows the host request path, a throwing one loses a value (or an event for NOT NULL columns).
- R13 The strict identifier pattern excludes some legitimate legacy names (spaces, hyphens, `$`, leading digits, over 63 characters). Deliberate (it is what keeps identifiers injection-proof), but it will bite existing-table users.
- R14 The reader process must repeat the writer's table/column/`ip.mode` config; the two can drift. The structure check catches missing columns, not a changed `ip.mode`.

Open questions for Alex / the user:

1. **Browser tracking beacon**: is a client-side snippet or an ingestion endpoint wanted? Not in the brief; today the host calls `track()` from its own server code.
2. **Retention/erasure helpers**: purely out of scope, or should the generator also print example `DELETE` recipes (printed, never run)?
3. **No-PII reader mode** (answered in v0.3, F-13): not built. Masking in SQL would need per-dialect string functions (SQL Server has no regular expressions), cannot produce shapes such as `j***@example.com` for every input safely, and the reader credential must be able to read everything anyway when `pii.reveal` is on. The risk it addresses (a handler bug or memory dump holding unmasked data) is mitigated instead by masking being total and fail-closed in one small module, and by the reader credential being SELECT-only. Revisit if a use case needs a reader that must never see personal columns.
4. **Multi-site** is now solvable with a scoping `constant` per deployment (3.6) or a promoted `site` field; there is still no per-site filter chosen by the dashboard user (filters were ruled out). Acceptable?
5. **Micro-cache** default off; should it default to a few seconds, in particular for new-vs-returning?
6. **Where the wire types live** (10.9 item 6): recommendation is a vendored copy plus a CI diff.
7. **Epoch-integer timestamp columns** (`bigint` seconds/millis) are common in legacy tables and are rejected in v1 (3.9). Support them with an explicit `columns.timestamp: { column, epoch: 'seconds' | 'millis' }`?
8. **Reader-only views**: allow a view when only a reader credential is configured (no inserts involved)? The first-visit index requirement cannot be verified for a view.
9. **Looser identifiers for existing tables** (say `$` and up to 128 characters on SQL Server) with extra quoting tests, or keep one strict pattern?
10. **Default `newVsReturning.maxRangeDays` of 31** and the choice that `truncate` makes IP identity "not reliable" (widget unavailable by default): are those the right defaults, or should `truncate` still compute with the `approximate` flag?
11. Should `inspect` also offer a `--sample` that reads a handful of rows to check timestamp zone assumptions? Today it reads **no rows** by design.

---

## 14. Decisions I made, and objections to the brief

### QA-REVIEW-1: decision log (v0.3)

Alex accepted all ten HIGH findings. For MEDIUM and LOW, the ones that belong to the server package and spec were fixed unless listed as rejected or deferred here with the reason.

| Finding                    | Outcome                                               | Notes                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01                       | **Fixed**                                             | strict `authorize` result, `authorizeTimeoutMs`, `authorize_invalid_result`                                                                                                                                                                                      |
| F-02                       | **Fixed**, tested on PostgreSQL 17 and MySQL 8.4      | message policy by error class; SQL Server cases are written for CI                                                                                                                                                                                               |
| F-03                       | **Fixed** (strict), compute wiring pending            | denied rows store only page, time, `consent = false`; `keepWhenDenied`; `deniedView()` and its property test exist; `extraColumns` (the only caller) is not built yet                                                                                            |
| F-04                       | **Fixed**                                             | batch-wide errors fail once and open a circuit breaker; row-by-row only for data/constraint errors                                                                                                                                                               |
| F-05                       | **Fixed** for owned pools; best effort for host pools | real cancellation per driver; contract tests on PostgreSQL and MySQL; SQL Server only in CI                                                                                                                                                                      |
| F-06                       | **Fixed**                                             | `pii.maskUserId` (default true), shape `u_***42`, ids under 6 characters `***`                                                                                                                                                                                   |
| F-07                       | **Fixed**                                             | normalised base path, root is the empty string; the dashboard client must adapt (W1)                                                                                                                                                                             |
| F-08                       | **Fixed**                                             | `scope` option and creation warning; the writer-side constant (`extraColumns`) is Phase 2                                                                                                                                                                        |
| F-09, F-10                 | Not mine                                              | Bella/Dan (F-09), Olivia (F-10, CI)                                                                                                                                                                                                                              |
| F-11                       | **Fixed**                                             | status line and changelog describe what is and is not implemented                                                                                                                                                                                                |
| F-12                       | **Fixed**                                             | total, fail-closed masking with property tests                                                                                                                                                                                                                   |
| F-13                       | **Rejected for now**                                  | see open question 3: masking in SQL is per-dialect, cannot cover every shape, and the reader must read everything anyway                                                                                                                                         |
| F-14                       | **Fixed**                                             | absolute URLs reduced to paths, leading `/` required, `;params` stripped, `page.normalize` hook; the "anonymous" claim is softened                                                                                                                               |
| F-15                       | **Fixed**                                             | 200-entry LRU; default requests are keyed by the raw query string so they hit within the TTL                                                                                                                                                                     |
| F-16                       | **Fixed**                                             | waiting callers capped at `queue.maxSize`                                                                                                                                                                                                                        |
| F-17                       | **Fixed**                                             | canonical exact routing, base path stripped once, Express `baseUrl` honoured; no Next.js CI build                                                                                                                                                                |
| F-18, F-19, F-20, F-45     | **Deferred to Phase 2**                               | they concern `existing` mode column types, naive timestamps, collations and the MySQL `TIMESTAMP` session check; nothing to fix before that mode exists. The recommended table uses `NVARCHAR`, `timestamptz`/`DATETIME(3)`/`DATETIME2(3)` and binary collations |
| F-21                       | **Deferred to Phase 2**                               | `inspect` is not built; its statement allow-list will be an exact-statement allow-list, not a prefix test                                                                                                                                                        |
| F-22                       | **Already satisfied**                                 | role names pass the identifier check and are quoted (`renderRole`), covered by CLI and generator tests                                                                                                                                                           |
| F-23 to F-28, F-42 to F-44 | Not mine                                              | DESIGN / plan / dashboard                                                                                                                                                                                                                                        |
| F-29                       | Plan                                                  | Olivia                                                                                                                                                                                                                                                           |
| F-30                       | **Documented**                                        | at-least-once writes can duplicate rows after a lost acknowledgement; not prevented                                                                                                                                                                              |
| F-31                       | **Fixed** (follows F-03)                              | non-boolean consent is stored as denied and reported                                                                                                                                                                                                             |
| F-32                       | **Fixed**                                             | safe integers and strings only, otherwise NULL plus `invalid_user_id`                                                                                                                                                                                            |
| F-33                       | **Fixed**                                             | C1, U+2028/2029 and bidi controls stripped                                                                                                                                                                                                                       |
| F-34                       | **Partly**                                            | `COUNT_BIG` on SQL Server and explicit `Number()`/`String()` conversion of counts and ids (bigint, string or number from any driver, unit-tested); a contract test that changes `pg.types.setTypeParser` globally is not written                                 |
| F-35                       | **Fixed**                                             | owned MySQL pools bound the prepared-statement cache. Not changed to client-side `query()` for inserts: with `NO_BACKSLASH_ESCAPES` the driver's client-side escaping is a known injection risk, server-side binding is not                                      |
| F-36                       | **Fixed**                                             | the resolved schema is used for every later statement                                                                                                                                                                                                            |
| F-37                       | **Fixed**                                             | wording in 10.5 ("rows without a value for this field"); Bella/Dan for DESIGN                                                                                                                                                                                    |
| F-38                       | **Fixed**                                             | the clamp stays (so the response is consistent) but a violation is reported to `onError`, and the integration oracle runs without relying on it                                                                                                                  |
| F-39                       | **Fixed**                                             | exact statement-hygiene rule in 5.1 and a test over all routes and dialects                                                                                                                                                                                      |
| F-40                       | **Fixed**                                             | `ReadErrorInfo`                                                                                                                                                                                                                                                  |
| F-41                       | **Partly**                                            | the example exports `dynamic = 'force-dynamic'` and `runtime = 'nodejs'`; there is no CI job that builds a Next.js sample                                                                                                                                        |

### Decisions delegated by the user (locked in v0.2)

1. **New vs returning is computed at read time by default**; `is_first_visit` is optional; write-time computation is opt-in (`firstVisit.enabled`, default false). (8.5)
2. **Two credentials are the documented default**: writer INSERT-only, reader SELECT-only; single-user mode supported with a warning. (4.5)
3. **Existing tables are supported as first-class**, with `dynalitics inspect` as the read-only helper, and `sql` still never connecting. (3, 6, 7)

### Decisions I made (change them if you disagree)

1. Default IP mode is `truncate` (privacy-friendly, needs no secret). `hash` requires a salt. Consequence under decision 1: with `truncate` the read-time widget does **not** use IP as identity by default (8.5.1).
2. Missing consent (no per-call value, no resolver) is treated as **denied**; a non-boolean consent is **rejected**. A `NULL` consent value in an existing table is read as denied.
3. Query strings and fragments are stripped from `pageVisited` by default.
4. A DB-generated `id` column is in the recommended schema (stable cursor paging, tie-breaks). Optional; unmapped means one page and timestamp-only tie-breaks.
5. Default physical names are snake_case with `visited_at` for the timestamp; roles stay as in the brief (the role `ipAddress` is now `ip`; wire fields keep their names).
6. `createDynalitics` is `async`; `track()` returns a never-rejecting `Promise<TrackResult>` (needed to express `block` backpressure).
7. Custom fields must be **declared** (type, length, `personal`, `breakdown`); the default for `personal` is true.
8. Hand-written config validator instead of Zod, zero runtime dependencies.
9. The CLI accepts JSON config only; `sql` reads no connection strings; `inspect` takes a connection string only from a named environment variable.
10. The `role` option is gone: capabilities come from which credentials are present.
11. Timestamps are exchanged as UTC text, independent of driver time-zone settings; MySQL `TIMESTAMP` columns require a UTC session and are a startup problem otherwise (3.9).
12. In `existing` mode string lengths are **clamped to the real column** instead of failing; `recommended` mode fails with `too_short`.
13. Views are not supported in v1 (7.6). Reader-only views are an open question.
14. Constants in `extraColumns` also **scope all reads** by default. This is stricter than the brief asked for, and I think it is the safe behaviour for shared tables.
15. `unavailable` is a 200 with `data: null`, not an error status, so widgets degrade without error banners (10.4). The naming overlaps with the 503 `unavailable` error code; I kept both because the term was requested, and say so in the contract.
16. The packages are marked `"private": true` for now so nothing can be published by accident; the release task removes it.
17. TypeScript resolved to 6.0.3 (the newest version typescript-eslint 8.72 accepts), Vitest 5.0.5, ESLint 10.14.0, all pinned exactly.

### Objections and worries

1. **Read-time first-visit is exact but not free.** It moves the cost from writes to reads: a range scan plus one index probe per distinct visitor, on every dashboard load, with no stored result. On a big table it can be the slowest widget and may hit the query timeout; on a table without the identity indexes it is unusable. I accept the user's decision, but we should say this in the README and consider a rollup/snapshot option later (out of scope). The 31-day cap and `newVsReturning.enabled: false` are the safety valves.
2. **The INSERT-only writer is a real constraint, not a free win.** It cannot validate structure on its own when a catalog hides columns, cannot use `RETURNING`-style features (we do not need them), and needs `USAGE` on sequences for PostgreSQL `serial` ids. All handled with messages and printed grants, but the first-run experience for existing tables will hit these.
3. **Existing-table support widens the blast radius.** Writing into tables we did not create, with triggers, partitions, odd collations and legacy data of unknown consent semantics, is where the surprising bugs will live. The checks are best effort. I would ship `inspect` and the compatibility table first and treat "works with any legacy table" as a goal, not a promise, in the README.
4. **`extraColumns.compute` is arbitrary host code on the hot path.** It is the most flexible escape hatch in the config and the least controllable. I kept it because it was requested, but with no sandbox or timeout; documented as trusted code.
5. **`inspect` is a new trust surface**: the only command that connects, and it reads schema metadata of a production database with a credential supplied through the environment. I built it so it cannot write (allow-listed statements, no `--out`, redacted output), but "cannot write" is a property we must test, not assume.
6. **"Hash" and "truncate" do not make an IP anonymous.** Both remain personal data under GDPR; unsalted hashing of IPv4 is trivially reversible. The docs must not call them "anonymisation". Consent-denied rows are minimal (page, timestamp, `consent = false`), but **not anonymous by themselves**: a path such as `/u/jane` or `/reset/<token>` re-identifies (F-14). `page.normalize` and the default stripping of query strings and `;params` reduce that; they do not remove it.
7. **Privilege and structure detection will be wrong sometimes** (roles, groups, MySQL grant text, hidden catalog rows). Advisory only; do not market it as a guarantee.
8. **`mssql` is a heavy peer** (pulls `tedious` and a large transitive tree), which sits oddly with "supply chain is the main concern". I kept it because the brief asks for it.
9. **Real-time guarantees are weak by design** (in-memory queue). That is the right trade for analytics, but the README has to say it plainly. Serverless works with `await flush()` and is better served now that read-time first-visit needs no warm cache.
10. **No retention or deletion story** at all. Out of scope as agreed, but an analytics table with email addresses and no deletion path is a compliance trap; the README should say so on its first screen.
11. **Scope creep.** v0.2 roughly doubles the surface of the validation and CLI work. If the schedule is tight, the order I would build in is: recommended table + writer/reader + read-time first-visit first, then `existing` mode (mapping, compatibility table, clamping), then `extraColumns`, then `inspect`.

## 15. Module interfaces and ownership (v0.4)

The read side is one file today (`src/read/handler.ts`) that mixes two jobs. This section names the seams, who owns each side, and what is promised across them. **Owners:** Tom = database side; Dan = lock layer (after the user approves section 16); Olivia = `SECURITY.md`, built from 15.4.

### 15.1 Seam 1: database side <-> lock layer

The lock layer decides **whether and how** a request may run. The database side decides **what** it returns. They meet at one function.

```ts
/** Built by the lock layer after authorize() has said yes. Everything the database side may know about the caller. */
interface Grant {
  readonly reveal: boolean; // true only if: pii.reveal option AND authorize revealPii === true AND ?pii=reveal
}

/** Database side. Never sees authorize(), headers, cookies, the raw request, or basePath. */
interface ReadService {
  /** route is canonical and already routed ('/api/meta', '/api/top-pages', ...). query is untouched. */
  run(route: string, query: DynaliticsRequest['query'], grant: Grant): Promise<ReadOutcome>;
}
type ReadOutcome =
  | { readonly kind: 'ok'; readonly body: ApiResponse<unknown> }
  | { readonly kind: 'error'; readonly code: ErrorCode }; // never carries text from the driver
```

| Rule                                                                    | Owner         |
| ----------------------------------------------------------------------- | ------------- |
| `run` is only called after a strict `authorize` success                 | lock layer    |
| `reveal` is computed once, by the lock layer, from three inputs         | lock layer    |
| masking is total and fail-closed, driven only by `grant.reveal`         | database side |
| `scope` is applied to every table reference, probes included            | database side |
| deadlines, semaphore, cancellation, cache (cache key includes `reveal`) | database side |
| `ReadErrorInfo` (no request data) goes to `onError`                     | database side |
| unknown route => `not_found`; bad parameter => `invalid_param`          | database side |

Failure behaviour: `run` never throws to the lock layer; unexpected exceptions become `{kind:'error', code:'internal'}` plus an `onError` report. The lock layer maps `error` to the HTTP status via `ERROR_STATUS`.

### 15.2 Seam 2: wire protocol <-> dashboard consumers

The handler's output is `ApiResponse<T>` from `src/protocol.ts`. Two consumers exist: the **HTML dashboard** (Dan, plain TypeScript, `src/ui/dashboard.ts`, which calls `fetch` through an injectable `fetchFn`) and the **React components** (Bella). Both import the same types; `packages/dynalitics-dashboard/src/protocol.ts` must stay byte-identical to the server copy (`npm run check:protocol -w dynalitics-dashboard`).

```ts
/** What a consumer gets to decide. The server never reads these. */
interface ConsumerOptions {
  endpoint: string; // absolute or root-relative URL of the mounted handler; the only thing the browser knows
  fetchFn?: typeof fetch; // HTML dashboard: already supported
  getRequestInit?: () => RequestInit | Promise<RequestInit>; // React: built, packages/dynalitics-dashboard/src/react (request-init.ts, provider.tsx)
}
```

Contract: consumers send only `GET` with documented query parameters; they never send a body. Credentials are the host's business: the HTML page is same-origin and rides the host's cookie; the React components supply headers or `credentials` through `getRequestInit`. The server emits no CORS headers, so a cross-origin deployment needs the host's own CORS layer in front of the handler. `unavailable` responses are HTTP 200 with `data: null` and must be rendered as a state, not an error.

The React components accept `getRequestInit` (`src/react/request-init.ts`, wired in `provider.tsx`; test: `test/react/behaviour.test.tsx` in the dashboard package). It cannot change the method, add a body or follow redirects, and a throwing callback becomes a 401 "not authorised". The HTML dashboard has no such option: it only has the injectable `fetchFn` and otherwise relies on ambient same-origin credentials. I have not audited the React package beyond this.

### 15.3 Seam 3: lock layer <-> host application

`authorize(req)` is the only door. Its result is read strictly: `true` or `{ allowed: true }` grants; `revealPii === true` reveals; anything else (including `1`, `'yes'`, `undefined`, `{}`) is refused with 403 and reported as `authorize_invalid_result`. A throw or a timeout (`authorizeTimeoutMs`, default 5000) is 500, never 200. It runs first for every request, including unknown paths and wrong methods.

### 15.4 Guarantees and explicit non-guarantees (input for SECURITY.md)

"Backing" is the test that fails if the guarantee breaks. Paths are under `packages/dynalitics/test/`.

| #   | Guarantee                                                                                                                                                                         | Backing                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | No data and no route is reachable without a strict `authorize` success; it runs before routing                                                                                    | `unit/read-handler.test.ts` (F-01), `integration/handler-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                    |
| G2  | A throwing or hanging `authorize` yields 500, never 200                                                                                                                           | `integration/handler-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| G3  | A non-boolean / malformed `authorize` result is refused and reported                                                                                                              | `unit/read-handler.test.ts` (F-01)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G4  | Only canonical paths route; `//`, `..`, `%`, `;`, trailing slash do not                                                                                                           | `unit/read-decisions.test.ts` and `unit/read-adapters.test.ts` (F-17)                                                                                                                                                                                                                                                                                                                                                                                                         |
| G5  | basePath is normalised; root mount never produces `//api/meta`                                                                                                                    | `unit/read-decisions.test.ts` (F-07), `unit/read-real-dashboard.test.ts`, integration                                                                                                                                                                                                                                                                                                                                                                                         |
| G6  | PII is masked unless all three reveal conditions hold; masks never leak the raw value                                                                                             | `unit/read-mask.test.ts` (properties), `integration/handler-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                 |
| G7  | Consent-denied rows contain no personal data, masked or revealed                                                                                                                  | `integration/handler-security.test.ts`, `integration/privacy-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                |
| G8  | `scope` is bound on every table reference, probes included, on all three dialects                                                                                                 | `unit/read-decisions.test.ts` (statement capture), `integration/scope.test.ts` (PG, MySQL). SQL Server: statement text only, no real server                                                                                                                                                                                                                                                                                                                                   |
| G9  | Query parameters are strict and bound; hostile identifiers are refused before any connection                                                                                      | `integration/handler-security.test.ts`, `integration/privacy-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                |
| G10 | Error bodies never contain SQL, table names, driver text or the connection string. Writer-side `onError` reports carry no visitor value or driver text for data/constraint errors | `integration/handler-security.test.ts` ("errors never contain SQL, table names, driver text or the connection string"); `integration/errors-and-cancel.test.ts` (canaries, writer side); `unit/redact.test.ts`. The content of the read side `onError` report (`ReadErrorInfo`) is **untested**                                                                                                                                                                               |
| G11 | A timed-out read is cancelled in the database (PG, MySQL); the concurrency limit answers 503 when no slot frees                                                                   | `integration/errors-and-cancel.test.ts` ("a 30 s sleep with a 1 s deadline is cancelled on the SERVER within 2 s, and the pool stays usable"), `unit/driver-cancel.test.ts`, `unit/read-handler.test.ts` ("concurrency is limited"). That a slot stays held until the driver settles after a timeout is **untested**                                                                                                                                                          |
| G12 | Responses are `no-store`, `nosniff`, `no-referrer`; HTML carries a per-request nonce and strict CSP                                                                               | `integration/handler-security.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| G13 | Read-time new/returning matches a brute-force oracle                                                                                                                              | `integration/read.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| G14 | The generated writer cannot read and the generated reader cannot write                                                                                                            | `integration/db.test.ts` "the generated writer cannot read and the generated reader cannot write": the writer's `SELECT`, the reader's `DELETE` and the reader's `INSERT` are each rejected with a permission error. It runs on every dialect in `ENABLED` (default PostgreSQL and MySQL; last run 2026-10-31 on PostgreSQL 17.9 and MySQL 8.4.10). **Not run on SQL Server.** The startup privilege warnings are a separate, best-effort feature (`unit/privileges.test.ts`) |

Explicit **non-guarantees** (say these in SECURITY.md):

| #   | Non-guarantee                                                                                                                                                               | Status                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| N1  | Nothing is guaranteed on SQL Server: it has never run on a real server. `.github/workflows/ci.yml` has an `integration (mssql)` job, but no workflow has ever run on GitHub | untested                                                               |
| N2  | Cancellation on a host-supplied pool is best effort                                                                                                                         | mocks only                                                             |
| N3  | Real Express and Next.js are simulated, not run                                                                                                                             | untested                                                               |
| N4  | No CORS and no CSRF code exists. Posture by omission: `GET` only, no cookies set, no CORS headers                                                                           | `integration/handler-security.test.ts` (no CORS headers); no CSRF test |
| N5  | Masking happens in Node after the query, so the reader credential and the process memory hold the real values (F-13)                                                        | by design; SQL masking not built                                       |
| N6  | The authorize implementation is the host's; a weak one is not our bug but is our users' problem                                                                             | documentation only                                                     |
| N7  | Delivery is at-least-once; the queue is in memory and is lost on a crash                                                                                                    | `unit/pipeline.test.ts` covers behaviour                               |
| N8  | The reader credential can see personal data columns; protecting it is the host's job                                                                                        | documentation only                                                     |
| N9  | No retention, deletion or export tooling                                                                                                                                    | out of scope                                                           |
| N10 | `extraColumns` constants and computed values, `existing` mode and `inspect` are not built and carry no guarantee                                                            | untested                                                               |

## 16. Extraction plan for the lock layer (v0.4)

Goal: Dan can own the lock layer without touching SQL, and Tom can change queries without touching the gate. **Do not start until the user approves this plan.**

### 16.1 New module boundaries

```text
src/read/
  lock/                 <- Dan
    authorize.ts        normalizeAuth, deadline race, invalid-result report
    gate.ts             method check, CANONICAL_PATH, reveal computation -> Grant
    serve-html.ts       csp, nonce, htmlResponse, %%DYNALITICS_BASE%%
    base-path.ts        isValidBasePath, normalizeBasePath
    index.ts            createLock({authorize, basePath, reveal, ...}) -> (req, next) => response
  service/              <- Tom
    handler.ts          ReadService (route table, params, cache, semaphore, scope, masking)
    routes.ts queries.ts params.ts mask.ts buckets.ts semaphore.ts scope.ts capabilities.ts
  adapters.ts types.ts  shared (Node and Fetch adapters stay as they are)
  handler.ts            createHandler = thin composition: lock(req, grant => service.run(...))
```

`createHandler` keeps its exact public signature and behaviour; the split is internal.

### 16.2 What leaves `handler.ts`

`normalizeAuth`, the `authorize` + deadline `Promise.race`, the invalid-result report, the method check, the `CANONICAL_PATH` test, the `/` HTML branch, and the `reveal` flag computation. What stays: `ReadError`, `execFor`, `metaData`, route table, `paramContext`, `serve`, `remember` (cache), `report`, option validation for `limits`, `scope`, `newVsReturning`, `cacheTtlMs`, `onError`.

### 16.3 Test impact

Unit tests that import `createHandler` keep working unchanged. Tests that reach into internals (`read-decisions`, `read-handler` F-01 block) are re-pointed at the lock module; the lock gets its own unit file that runs without a database. Integration tests do not change.

### 16.4 Must not regress

| Finding | What must still be true after the move                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| F-01    | strict `authorize` result, 403 plus `authorize_invalid_result` for malformed results, 500 on throw/timeout |
| F-07    | root mount yields base `''`; `//api/meta` is never requested; `basePath: '/admin/'` is normalised          |
| F-08    | `scope` is applied on every table reference (the service owns it; the lock must not bypass it)             |
| F-17    | only canonical paths route; the check still happens after authorize and before any query                   |

Order of work: (1) move files with no logic change, tests green; (2) introduce `Grant` and `ReadService.run`; (3) re-point tests; (4) only then change behaviour, one finding at a time.

## 17. Existing tables: feasibility verdict (v0.4)

**Verdict.** Reading and writing a user's existing table is feasible for tables that are plain base tables with a handful of nullable columns we can map, and I would call that the solid core. It is risky for anything else (triggers, partitions, views, legacy names, naive timestamps, columns that are NOT NULL without a default), and those cases can only be detected on a best-effort basis, so we must say so in the docs. `extraColumns` with computed values and `dynalitics inspect` are the least safe parts and should be deferred.

### 17.1 Classification

| Item                                                        | Verdict            | Why                                                                                                            |
| ----------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Role mapping to existing columns (timestamp, consent, page) | **Solid**          | Same code paths as the recommended table; the dialect and driver layers already take a column model            |
| Type-tolerance table (7.2)                                  | **Solid, unbuilt** | Pure function plus a test matrix; but needs real-database tests per dialect                                    |
| Startup refusal when a NOT NULL column has no default       | **Solid, unbuilt** | Introspection already exists; the message prints the fix                                                       |
| Read-time first-visit on a large existing table             | **Risky**          | One index probe per distinct visitor; without a suitable index it is a full scan. We can only warn (F-18/F-19) |
| Triggers, partitions, generated columns                     | **Best effort**    | Detection is incomplete and differs per dialect                                                                |
| Views                                                       | **Cut**            | Not insertable in general, and `scope`/probes assume a base table                                              |
| Legacy identifiers (spaces, dashes, mixed case)             | **Cut for now**    | The strict identifier pattern is a security control (G9); loosening it needs its own review                    |
| Naive timestamps and MySQL `TIMESTAMP`                      | **Risky**          | We assume UTC; a wrong session time zone silently shifts data (F-45 only checks one connection)                |
| SQL Server `varchar` vs `NVARCHAR` parameters               | **Risky**          | Implicit conversion can disable index use (F-18)                                                               |
| `extraColumns` constants                                    | **Solid, unbuilt** | Bound parameters; but the read side must apply the same constant or `scope` breaks (F-08)                      |
| `extraColumns` computed values                              | **Deferred**       | Runs host code in the write path; needs the denied view (F-03) wired and a sandbox story                       |
| `dynalitics inspect`                                        | **Deferred**       | Read-only safety needs an exact-statement allow-list (F-21)                                                    |

### 17.2 Build order and rough effort

Efforts are my estimate for one engineer including tests against real PostgreSQL and MySQL, excluding SQL Server.

1. **`existing` mode core** (mapping, 7.2 type table, NOT NULL check, UTC check, startup messages): 4 to 6 days. **Done in v0.4.2 for PostgreSQL and MySQL; see 17.5 for what is left.**
2. **`extraColumns` constants**, writer and reader together (so F-08 holds): 2 days.
3. **SQL Server CI job** (needed before any claim about that dialect): 1 to 2 days, mostly CI work.
4. **`dynalitics inspect`** with exact-statement allow-list: 3 days.
5. **`extraColumns` computed**: 3 to 4 days, plus a security review.

### 17.3 Is any requirement wrong?

Two parts of the brief do not hold up as written. First, "support any existing table" cannot be promised: the claim has to be limited to base tables with mappable columns, because the cases above cannot be detected reliably. Second, `inspect` is described as safe because it is read-only, but read-only is a property of the credential, not of our statements; it is only safe with the allow-list in F-21, so it should not be started before that.

### 17.4 Decisions needed from the user

1. Approve sections 15 and 16 as the base for the lock-layer extraction (Dan starts after this).
2. Confirm that views and legacy identifiers are cut from `existing` mode.
3. Confirm the build order in 17.2, in particular that `extraColumns` computed values and `inspect` stay deferred.
4. (Closed in v0.4.1: `getRequestInit` already exists in the React package, so no decision is needed.)

### 17.5 Status after step 1 (v0.4.2)

| Item                                                                               | State                                                                                                                                | Backing                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Role mapping, required roles, duplicate and identifier checks, first-visit rules   | built                                                                                                                                | `unit/existing-model.test.ts`                                                                                              |
| Type-tolerant comparison, exact messages, naive-timestamp and precision warnings   | built                                                                                                                                | `unit/existing-compare.test.ts`, `unit/compare.test.ts`                                                                    |
| NOT NULL without default: startup error, fixes printed as comments, never executed | built                                                                                                                                | `unit/existing-fix-sql.test.ts`, `unit/create-existing.test.ts`, `integration/existing-table.test.ts` (PG, MySQL)          |
| Schema-qualified names, strict identifier pattern                                  | built                                                                                                                                | `unit/existing-model.test.ts`; real non-default schema (PG schema, MySQL database) in `integration/existing-table.test.ts` |
| Real column types on write (integer consent as 1/0, adopted lengths)               | built                                                                                                                                | `unit/existing-physical.test.ts`, `unit/create-existing.test.ts`, `integration/existing-table.test.ts`                     |
| Read side on legacy types (naive timestamp, integer consent, `datetimeoffset`)     | built; PostgreSQL naive timestamp and integer consent verified on the real database, `datetimeoffset` is statement text only         | `unit/existing-read.test.ts`, `integration/existing-table.test.ts`                                                         |
| MySQL `TIMESTAMP` and the session time zone                                        | built; checks one pooled connection per driver (QA F-45)                                                                             | `unit/existing-compare.test.ts`, `integration/existing-table.test.ts` (MySQL, `SET GLOBAL time_zone` and restored)         |
| Unavailable widgets and fields for unmapped roles                                  | built (derived from the model by the existing `/api/meta` code)                                                                      | `integration/existing-table.test.ts` (`widgets`, `fields`, `recentVisitsCursor`)                                           |
| Anything on SQL Server                                                             | **written, never run** (`integration (mssql)` in CI)                                                                                 | untested                                                                                                                   |
| A non-UTC database session with a naive PostgreSQL timestamp                       | **untested**: the test containers run in UTC, so a wrong conversion would not show. The expression is covered by statement text only | `unit/existing-read.test.ts`                                                                                               |
| Deferred items listed in the v0.4.2 changelog                                      | not built                                                                                                                            | -                                                                                                                          |

---

## 18. Log explorer (v0.6)

A view for digging into individual visits: type a query, see how many visits match over time, which values the matching visits have, and the matching rows themselves, optionally refreshing every few seconds. Built on the same read handler, credential, scope, masking, semaphore, deadlines and micro-cache as section 10.

### 18.1 Fields

The explorer's allow-list is built once at handler creation from the column model. A request can only name a key from this list.

| key            | source                                         | type      | bare terms match it | filter | facet + split               |
| -------------- | ---------------------------------------------- | --------- | ------------------- | ------ | --------------------------- |
| `page`         | `pageVisited` column                           | `text`    | yes                 | yes    | yes                         |
| `consent`      | `consent` column (NULL counts as `false`, 3.2) | `boolean` | no                  | yes    | yes                         |
| `isFirstVisit` | write-time column, only when enabled (8.5.2)   | `boolean` | no                  | yes    | yes                         |
| custom `k`     | `customFields.k` with `personal: false`        | by type   | `string` only       | yes    | only with `breakdown: true` |

Custom field types map to `text` (`string`), `number` (`integer`, `number`) and `boolean`. Never in the list, in any form: `ip`, `userId`, `username`, `email`, `id`, the raw `custom` column, and custom fields with `personal: true`. Facets and splits are restricted to `breakdown: true` because grouping is what that flag already authorises (10.7).

### 18.2 Query language (`q`)

```
q        := clause ( WS clause )*            implicit AND; empty q matches every row in the range
clause   := [ "-" ] ( key ":" value | term )  "-" negates
term     := word | quoted                      case-insensitive "contains" over every field whose "bare terms" column is yes
value    := word | quoted
quoted   := '"' any char except '"' '"'       no escapes
word     := 1+ chars, none of them whitespace or '"'
key      := [A-Za-z_][A-Za-z0-9_]{0,63}        must be in the allow-list (18.1)
```

Values by field type:

| type      | value forms                                                                                                     | SQL shape (values bound)                                                |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `text`    | `abc` exact, `abc*` prefix, `*abc` suffix, `*abc*` contains, `*` alone = has a value. `*` elsewhere is an error | `LOWER(expr) = ?` / `LOWER(expr) LIKE ? ESCAPE '!'`, `expr IS NOT NULL` |
| `boolean` | `true` or `false` (any case)                                                                                    | the dialect's `isTrue` / `isFalse` on the column                        |
| `number`  | `n`, `>n`, `>=n`, `<n`, `<=n`; `n` matches `^-?[0-9]{1,15}([.][0-9]{1,6})?$`                                    | numeric comparison; JSON values are cast first                          |

- Inside quotes `*` is a literal character: `plan:"a*b"` matches exactly `a*b`.
- A word whose part before the first `:` matches the `key` pattern is a field clause, so `https://x` is an unknown field: quote it (`"https://x"`) to search for it. A word whose prefix does not match the pattern (`/blog:2`) is a term.
- Case-insensitivity uses the database's `LOWER()` on the column and JavaScript `toLowerCase()` on the value. That is exact for ASCII; for other scripts it depends on the database collation (**untested** beyond ASCII and Latin-1 accents).
- `LIKE` metacharacters (`%`, `_`) and the escape character `!` in values are escaped with `!`. The escape is `!`, not `\`, because F-39 forbids `\` in statements.
- Negation is NULL-safe: `-x` becomes `CASE WHEN <x> THEN 1 ELSE 0 END = 0`, so rows where the field is missing match `-plan:pro`.
- No `OR`, no parentheses, no comparisons on text in v1.

Limits (also in `/api/meta`): `q` at most 512 characters, at most 12 clauses, each value or term 1 to 128 characters. Violations are `invalid_query`, never truncation.

### 18.3 Routes

All `GET`, behind `authorize`, with strict parameters as in 10.3. `q` defaults to empty. `from`/`to` as in 10.3, but capped at `explorer.maxRangeDays` (default 31) because contains-searches cannot use an index beyond the timestamp range. The routes exist only when `explorer.enabled` (default true); otherwise they are `404` and `widgets.explorer` is `{ available: false, reason: 'disabled_by_host', ... }`.

**`GET /api/search?q&from&to&limit&cursor&pii`**: the matching visits, newest first, in exactly the `RecentVisit` shape and with the same cursor rules as `recent-visits` (10.5), plus `matched`, the number of matching rows in the range.

```json
{ "data": { "visits": [/* RecentVisit */], "nextCursor": "…", "matched": 1843 } }
```

**`GET /api/search/histogram?q&from&to&interval&split`**: matching visits per bucket, shape `VisitsOverTimeData` (10.5). `split` names a facet field; the series are built exactly like a breakdown (10.7: top 10 values, a `null` series, an `other` series). `page` can be a split here although it is not a `breakdown` of `visits-over-time`.

**`GET /api/search/fields?q&from&to`**: the field sidebar. For each facet field, the top 5 values among matching visits.

```json
{
  "data": {
    "matched": 1843,
    "fields": [
      {
        "key": "page",
        "values": [{ "value": "/pricing", "count": 512 }],
        "nullCount": 0,
        "otherCount": 901
      },
      {
        "key": "consent",
        "values": [
          { "value": "true", "count": 1500 },
          { "value": "false", "count": 343 }
        ],
        "nullCount": 0,
        "otherCount": 0
      }
    ]
  }
}
```

Values are strings (booleans as `"true"`/`"false"`, numbers in the database's text form). `otherCount = matched - sum(values) - nullCount`, clamped at 0.

### 18.4 Errors

`400 invalid_query`: `{ code: 'invalid_query', message, reason, position }`. `position` is the 0-based character offset in `q` where the problem starts. `reason` and its fixed message:

| reason             | message                                            |
| ------------------ | -------------------------------------------------- |
| `too_long`         | The query is longer than 512 characters.           |
| `too_many_clauses` | The query has more than 12 parts.                  |
| `unbalanced_quote` | A quote is not closed.                             |
| `empty_value`      | A field or term has no value.                      |
| `value_too_long`   | A value is longer than 128 characters.             |
| `unknown_field`    | Unknown field, or a field that cannot be searched. |
| `bad_value`        | The value does not fit the field's type.           |

`unknown_field` deliberately does not say whether the field is personal or non-existent. `split` naming a non-facet field is `400 invalid_parameter (split)`.

### 18.5 Privacy and cost notes

- A search can only tell the caller something the non-personal columns already say. Personal columns are never in a `WHERE` clause, so a query cannot be used as an oracle for an e-mail address or IP (the user chose this on 2026-10-31).
- Denied-consent rows store only page, timestamp and `consent=false` (8.2); they are searchable by those fields and by custom fields kept with `keepWhenDenied`, which is no more than `recent-visits` already shows.
- Each `fields` request runs `1 + (number of facet fields)` statements (at most 9: facet fields are capped at 8, in allow-list order), each through the semaphore and deadline of 10.1. Contains-searches scan every row of the range; the range cap and `timeoutMs` bound the cost, and the micro-cache applies.

### 18.6 Dashboard (summary; layout in DESIGN.md)

An **Explorer** view next to the overview: query bar (with field and value chips that edit the query text), match histogram (click a bar to zoom to its bucket), split-by selector, field sidebar (click a value to add `key:value`, alt-click to add `-key:value`), and the result list using the recent-visits row. Live tail polls `/api/search` and the histogram every 5, 15 or 30 seconds (never below `tailMinIntervalMs`), pauses while the page is hidden or a request is in flight, and marks rows that are new since the previous poll. The query and range live in the URL hash so a view can be shared.

---

## 19. Consent banner (`dynalitics-consent`, v0.7)

An optional package for hosts that want dynalitics to ask for consent. Zero runtime dependencies; `react` is an optional peer. It never imports `dynalitics` and `dynalitics` never imports it: the only link between them is the boolean the host passes to `track()`.

### 19.1 Entry points

| Import                          | Contents                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `dynalitics-consent`            | `mountConsentBanner(options)`, `readConsent()`, `writeConsent(choice)`, `clearConsent()` (plain DOM) |
| `dynalitics-consent/react`      | `<ConsentBanner>`, `useConsent()`                                                                    |
| `dynalitics-consent/server`     | `consentFromRequest(req, options?)`, `parseConsentCookie(header, name?)` (no DOM)                    |
| `dynalitics-consent/styles.css` | the banner's stylesheet (classes only, no inline `style` attributes)                                 |

### 19.2 Banner options (both forms)

| Option        | Default                | Rule                                                                                                                                           |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | `true`                 | `false`: nothing is rendered, the cookie is neither read nor written                                                                           |
| `message`     | **required**           | plain text, rendered with `textContent`; never parsed as HTML                                                                                  |
| `title`       | none                   | plain text heading                                                                                                                             |
| `acceptLabel` | `'Allow'`              | plain text                                                                                                                                     |
| `rejectLabel` | `'Reject'`             | plain text. Accept and reject are the same element type with the same class: equally prominent by construction                                 |
| `policyUrl`   | none                   | rendered as a link only if it is a relative path (`/…`, no `//`) or an `http:`/`https:` URL; anything else (`javascript:`, `data:`) is dropped |
| `policyLabel` | `'Privacy policy'`     | plain text                                                                                                                                     |
| `cookieName`  | `'dynalitics_consent'` | must match `^[A-Za-z0-9_-]{1,64}$`; must equal the server helper's                                                                             |
| `maxAgeDays`  | `180`                  | 1..395 (about 13 months, the usual upper bound for consent records)                                                                            |
| `onChange`    | none                   | `(choice: 'granted' \| 'denied') => void`                                                                                                      |

### 19.3 Behaviour

- The banner appears only when there is no valid stored choice. It is a non-modal `role="dialog"` (`aria-modal="false"`, labelled by the title or the message): it does not trap focus or block the page.
- Choosing writes `dynalitics_consent=granted|denied; Path=/; Max-Age=<days*86400>; SameSite=Lax`, plus `Secure` on `https:` pages, then removes the banner and calls `onChange`. It also dispatches a `dynalitics:consent` `CustomEvent` on `window` with `detail: { choice }`.
- **Withdrawal:** `mountConsentBanner(...).open()` and `useConsent().reopen()` show the banner again whatever was stored, so a "Cookie settings" link can change the choice. `clearConsent()` deletes the cookie.
- **Before a choice, nothing is granted.** `readConsent()` returns `null` (no choice), the server helper returns `false`.
- The package makes no network requests and stores nothing but the one cookie.

### 19.4 Server helper

`consentFromRequest(req, { cookieName? })` accepts a Node `IncomingMessage`, a Fetch `Request`, or anything with `headers.cookie` / `headers.get('cookie')`, or a raw `Cookie` header string. It returns `true` **only** when the cookie is present exactly with the value `granted`. Missing cookie, any other value, a malformed header, or the cookie appearing twice with different values all return `false` (fails closed, like the consent gate of 8.2). It never throws for any request; only an invalid `cookieName` option (host configuration) is a `TypeError`.

## 20. HTTP status and errors (v0.8)

dynalitics is still one row per visit. Two optional columns describe how the host answered that request; nothing is captured automatically, the host passes both to `track()` once the response is known.

### 20.1 Columns

| Role          | Default column | Type                                                  | Personal | On denied rows |
| ------------- | -------------- | ----------------------------------------------------- | -------- | -------------- |
| `status`      | `status_code`  | integer (`bigint` from the generator)                 | no       | kept           |
| `errorReason` | `error_reason` | string, max 64 (`varchar` / `nvarchar` on SQL Server) | no       | kept           |

Both are opt-in in recommended mode: `columns: { status: true, errorReason: true }` (or a name). In existing mode they are mapped like any other role (`true` = default name). `dynalitics sql` emits them only when asked for. No index is generated: every read filters on the timestamp range first.

### 20.2 Values

- `status`: an integer 100..599. Anything else (a string, a fraction, `true`, out of range) is stored as `NULL` with an `invalid_visit` report; the visit is kept.
- `errorReason`: a **code**, `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`. The charset has no space, `@`, `/` or `?`, so an error message, an email address or a URL cannot be stored. Anything else becomes `NULL`, reported without the value. `''` and `null` are "no reason".
- `errorReasonOf(err)` returns `err.code` if code-shaped (`ECONNREFUSED`, `P2002`, `payment.declined`), else `err.name` if code-shaped (`TypeError`), else `null`. It never reads `err.message`.
- Not validated together: a reason on a 200 is stored as given.

### 20.3 Breakdowns and explorer fields

When `status` is mapped: `statusClass` (text, derived in SQL: `NULL` stays `NULL`, `>= 500` → `5xx`, `>= 400` → `4xx`, `>= 300` → `3xx`, `>= 200` → `2xx`, else `1xx`) and `status` (number). When `errorReason` is mapped: `errorReason` (text, bare terms search it). All three are facets and breakdowns, listed before custom fields (so they are inside `MAX_FACETS`), and a custom field with the same key is ignored. Query examples: `status:>=500`, `statusClass:4xx`, `-statusClass:2xx` (NULL-safe: rows without a status match), `errorReason:ECONN*`.

### 20.4 `GET /api/errors`

Parameters: `from`, `to`, `interval` (strict, as 10.2; bucket cap applies). When `status` is not mapped the answer is HTTP 200 with `unavailable: { reason: 'column_not_mapped', ... }` and no query runs.

```ts
interface ErrorCounts {
  total: number;
  clientErrors: number;
  serverErrors: number;
  rate: number | null;
}
interface ErrorsData {
  interval: Interval;
  points: (ErrorCounts & { bucket: string })[]; // zero-filled like 10.5
  totals: ErrorCounts;
  pages: { page: string; errors: number; serverErrors: number }[]; // top 10 by 4xx + 5xx
  reasons: { reason: string | null; status: number; count: number }[]; // top 10 (reason, status) among 4xx + 5xx
  reasonsStored: boolean; // false when errorReason is not mapped (every reason is then null)
}
```

`total` counts rows **with a status** only; older rows without one are left out so the rate is not diluted. `rate = (4xx + 5xx) / total`, three decimals, `null` when `total` is 0. Three statements, each bound, scoped and limited to the range like every other route.

### 20.5 Testing

`unit/errors.test.ts` (model, generator, validation, denied rows, `errorReasonOf`, route shape, SQL binding on all three dialects); `integration/outcome.test.ts` (written by the real writer and read back through `/api/errors`, the explorer and the facets on PostgreSQL and MySQL. **Not yet run on SQL Server**: `mssql.yml` picks the file up on the next push). Dashboard: `test/ui/errors.test.ts` and the React parity scenarios `errors`.

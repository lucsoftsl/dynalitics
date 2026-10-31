# QA review 1: SPEC.md (v0.2) and DESIGN.md (v1.0)

Reviewer: Olivia (QA). Date: 2026-10-30. Scope: review only. No spec, design or code file was edited; no git commit.
Inputs read in full: `docs/SPEC.md` (1737 lines), `docs/DESIGN.md` (865 lines). Checked against the repo where the repo already has the code.

**How to read the evidence.** Each finding says what I _read_ (spec/design text), what I _ran_ (reproduced on this machine) and what is _my knowledge_ (cross-database behaviour I could not run here). Things I could not run are labelled.

Commands/results I actually ran for this review:

- `docker version`, `docker info`, `colima list`, `docker stats`, `/proc/meminfo` inside the VM (environment, section 5).
- Contrast and colour-blind simulation script over every token in DESIGN.md section 2 (WCAG 2.x relative luminance; Machado 2009 matrices).
- Node script against the running Postgres 17 and MySQL 8.4 test containers: bound parameters with an email address into an integer/uuid column (finding F-02). No table was created except a session-only `TEMPORARY TABLE` in MySQL.
- Reading `packages/dynalitics/src/{redact.ts,queue/pipeline.ts}`, `packages/dynalitics-dashboard/src/ui/{api.ts,main.ts}`, `package.json`, built `dist/dashboard.html` (size).
- Earlier today (separate task): unit suite 399/399 green, integration 100 tests green on Postgres+MySQL.

---

## 1. Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 0     |
| HIGH     | 10    |
| MEDIUM   | 18    |
| LOW      | 17    |
| Total    | 45    |

**Why no CRITICAL:** the read handler does not exist in `src` yet (no `createHandler`/`authorize` anywhere in `packages/dynalitics/src`), so nothing is exploitable today. Three HIGH items (F-01, F-03, F-06) would be CRITICAL the moment the handler ships as the current text reads. Fixing them is cheap now and expensive after release.

**Top five** (ranked by "could leak personal data or defeat the consent/auth gate", with evidence):

1. **F-02 PII leaks into `onError`/logs through `cause.message`.** Reproduced: Postgres and MySQL both echo the bound value in their error text (`invalid input syntax for type integer: "jane@example.com"`). `sanitizeError` only redacts connection secrets.
2. **F-01 `authorize` result handling is only specified for `false`.** A truthy non-boolean (`'attacker'`, a user object) is undefined behaviour at the only gate in front of the PII.
3. **F-03 `extraColumns.compute` with `personal: false` is called with the full `Visit` (email, ip, userId) even when consent is denied.** The consent gate can be bypassed by configuration, by design.
4. **F-05 Query timeouts are not enforceable as written** (SQL Server has none per query, host pools have none server-side, PG/MySQL client timeouts do not cancel) and the concurrency semaphore is released while the database is still working. The DoS mitigations T9/T23 are weaker than the text says.
5. **F-06 `userId` is returned unmasked**, and hosts routinely use email or username as the user id, so the masking is bypassed in the default configuration.

Also blocking, not security: **F-07** (default `basePath` `/` makes the dashboard call `//api/meta`), **F-09** (the 90-day view always errors the new-vs-returning panel), **F-10** (SQL Server, one of three products, has never run and no CI job exists to run it).

---

## 2. Findings

Format: **ID · severity · tag · title**, then section, why it matters, failing scenario, fix. Tags: SPEC, DESIGN, PLAN.

### HIGH

#### F-01 · HIGH · SPEC · `authorize` result is only defined for `false`, `{allowed:false}`, throw/reject

- **Where:** 10.2 `AuthResult`, 10.3 "Order", 11 T5.
- **Why:** `authorize` is the single gate in front of every personal field. The text says `false`/`{allowed:false}` give 403 and throw gives 500, and says nothing about every other value. Two engineers will write `if (!result)` and `if (result !== true)` respectively.
- **Scenario:** host writes `authorize: (req) => req.headers['x-user']` (string), `(req) => req.session?.user` (object) or `(req) => ({ allowed: 'false' })`. With a truthiness check all three are allowed. `revealPii: 'no'` is truthy and unmasks. Separately, an `authorize` that never settles (session store hung) holds the socket of an unauthenticated client forever; there is no deadline.
- **Fix:** specify strictly: allowed only if `result === true` or (`result` is a plain object and `result.allowed === true`); reveal only if `revealPii === true`; any other value is 403 and reports `onError(authorize_invalid_result)`. Add `authorizeTimeoutMs` (default 5000) that resolves to 500 fail-closed. Test names in section 6.

#### F-02 · HIGH · SPEC (+ code) · Visitor values leak into `onError` through `cause.message`

- **Where:** 4.3 `ErrorInfo.cause`, 11 T4 and T14. Code: `src/redact.ts` `sanitizeError` (lines 55-66), `src/queue/pipeline.ts` `causeOf`/`failureReport` (lines 40, 137-147), `lookup_failed` report, `src/create.ts:264`.
- **Why:** T14 says "log messages built from codes and counts, not raw visitor strings", but `cause.message` is the driver's message, redacted only against connection-string secrets (`redact` removes the exact connection string, `user:pass@`, `password=`). Database error text routinely contains the offending value. `onError` is normally wired to a log aggregator, i.e. a third party that the visitor never consented to.
- **Evidence (ran, bound parameters, throw-away containers):**
  - PG: `invalid input syntax for type integer: "jane@example.com"` and `invalid input syntax for type uuid: "jane@example.com"`
  - MySQL: `Incorrect integer value: 'jane@example.com' for column 'uid' at row 1`
  - From my knowledge, not run here: MySQL `Duplicate entry 'jane@example.com' for key ...`; SQL Server `Violation of UNIQUE KEY constraint ... The duplicate key value is (jane@example.com)` and, on 2019+, error 2628 `Truncated value: '...'`; PG unique violations put the value in `DETAIL` (not copied today, because only `message` is copied; keep it that way).
- **Scenario:** existing table (first-class in v0.2) with a unique index on `email` or a `uuid` user id column. A returning visitor with consent triggers a data/constraint error; `onError({code:'insert_failed', cause:{message:'... jane@example.com ...'}})` goes to the host's log pipeline.
- **Fix:** never forward `message` for data/constraint classes. Allow-list by error class (PG SQLSTATE `22***`/`23***`, MySQL errno 1048/1062/1264/1292/1366/1406, MSSQL 515/547/2601/2627/2628/8152): emit `{name, code}` only, plus a fixed sentence. Forward the (redacted) message only for connection/auth/network classes. Add a canary test (section 6) that pushes a canary email through every data-error class on all three databases and greps the `onError` payload, `logger` output and `stats()`.

#### F-03 · HIGH · SPEC · `compute` with `personal: false` receives the whole `Visit` when consent is denied

- **Where:** 3.6 (computed columns), 8.1 step 3, 8.2 row 12, 11 T21.
- **Why:** 3.6 says a `personal: false` compute function "is always called", and its signature is `compute(visit: Readonly<Visit>)`. `Visit` contains `ip`, `userId`, `username`, `email`. Step 3 says personal inputs are "ignored without being inspected" for _stored_ fields, which does not constrain what host code does with the object it is handed. The product rule is "consent denied => only pageVisited + timestamp + consent=false stored".
- **Scenario:** `extraColumns: { session_hash: { type:'string', compute: v => sha256(v.email ?? v.ip), personal: false } }`. Consent is denied; the row is stored with a stable per-person hash. Same for a `personal: false` custom field the host fills from `userId`. It is a host decision, but the spec makes the unsafe path the easy one and tests only the safe path (row 12 uses a personal compute).
- **Fix:** when consent is denied, call non-personal compute functions with a reduced view (`{ pageVisited, consent:false, custom: <non-personal declared fields only> }`), and in the type, make the argument of a `personal:false` function that reduced type at compile time (`Pick<Visit,'pageVisited'|'consent'> & { custom }`). Add the invariant to the property test in 12.1: the argument object seen by any compute function under `consent=false` has no `ip/userId/username/email` key.
- **Related ambiguity (same section):** requirement text given to QA says denied consent stores _only_ pageVisited, timestamp and consent=false. Spec stores in addition non-personal custom fields, constants and non-personal computed values (8.2 row 2). That is defensible, but it is a deviation from the one-line product rule; Alex/the user should confirm, because the dashboard copy in DESIGN 6.6 ("Declined visits store only the page and the time") is then false for hosts that use non-personal custom fields.

#### F-04 · HIGH · SPEC (+ code) · Permanent errors trigger row-by-row retries with no circuit breaker

- **Where:** 9 "Poison rows"; code `src/queue/pipeline.ts` (lines ~174-190).
- **Why:** any non-transient error on a batch of more than one row is retried row by row, including errors that fail _every_ row identically (permission denied, missing table/column, closed schema, read-only replica). The code even detects `denied` (line 138) but only to add a hint.
- **Scenario:** writer loses INSERT (grant revoked, failover to a read replica). Each 200-row batch becomes 1 + 200 failing statements, serially; the queue refills at request rate and every batch repeats it. That is the database being hammered with failing statements and its error log flooded, from a package whose principle 5 is "analytics must never hurt the host". Same shape on a missing partition.
- **Fix:** classify errors: _row-specific_ (data/constraint) vs _batch-wide_ (permission, object missing, read-only, syntax). Batch-wide: no row-by-row, fail the batch once, and open a circuit (exponential cool-down, max e.g. 60 s, during which batches are dropped and counted without touching the DB). Test with the fake driver: 1000 events, driver throws `permission denied` => at most `batches` statements, not `1000 + batches`.

#### F-05 · HIGH · SPEC · Read-query timeouts are not enforceable as written; the semaphore frees the slot while the query keeps running

- **Where:** 10.3 "Limits", 5.2 driver table, changelog deviation 7, 11 T9/T23.
- **Why (contradiction inside the spec):** 10.3 says "each query has `timeoutMs` (10 s, enforced by the driver) -> `504`". Deviation 7 says SQL Server does not apply a per-query timeout (pool `requestTimeout` 30 s, owned pools only). 5.2 sets PG `statement_timeout` and MySQL hints for **owned pools only**; for a host-supplied `{ pool }` there is no server-side limit. Also (my knowledge): `pg`'s `query_timeout` and `mysql2`'s `timeout` reject the client promise but do **not** cancel the statement on the server.
- **Scenario:** an authorized user (or a script holding a stolen session) repeatedly loads `new-vs-returning` for 31 days on a large table. Each request times out client-side at 10 s, the semaphore slot is released, the next request starts a new heavy query while the earlier ones keep running on the server. The "concurrency 4" cap is bypassed and the database saturates. On SQL Server the limit is 30 s, not 10 s, regardless of config.
- **Fix:** release the semaphore slot only when the query is confirmed finished or its connection destroyed. Per driver, define the enforcement that actually cancels: PG destroy the connection on timeout (or `pg_cancel_backend` from a side connection); MySQL `MAX_EXECUTION_TIME` hint (SELECT only) plus destroy the connection; MSSQL `request.cancel()` on a timer. State plainly that host-supplied pools get client-side-only enforcement and that the host must set `statement_timeout`/`max_execution_time` on the reader role (`ALTER ROLE reader SET statement_timeout`, MySQL `max_execution_time` per user via resource control is not available, so say so). Add a contract test: a `pg_sleep(30)` / `SLEEP(30)` / `WAITFOR DELAY` query with `timeoutMs: 1000` must leave **zero** active server sessions for that query within 2 s (`pg_stat_activity`, `information_schema.processlist`, `sys.dm_exec_requests`).

#### F-06 · HIGH · SPEC · `userId` is unmasked, but `userId` is often an email address or username

- **Where:** 10.6 masking table row `userId`; also the `recent-visits` example (`"userId": "u_42"`).
- **Why:** the table states `userId` is "an opaque pseudonymous ID" and "hosts who disagree should not store it". 4.2 says only `string | number`. In practice many apps use the login (email) or username as the key. With default settings (reveal off) the dashboard then shows full emails in the one column that is exempt from masking.
- **Scenario:** `userId: session.user.email`. Masked `email` column shows `j***@example.com`; the adjacent User cell (DESIGN 6.7 second line) shows `jane@example.com`.
- **Fix:** mask `userId` too by default (keep the first 2 and last 2 characters or a short HMAC prefix; reveal under the same triple condition), or at minimum apply the email rule when the value contains `@` and add `pii.maskUserId` (default `true`). Support still works, because the id is still shown in `reveal` mode.

#### F-07 · HIGH · SPEC (+ code) · Default `basePath: '/'` makes the dashboard request `//api/meta` (protocol-relative URL)

- **Where:** 10.1 (`basePath` default `/`), 10.8 (placeholder = "validated basePath ... or `/`", client builds `base + '/api/...'`). Code: `dashboard/src/ui/main.ts:4` reads the meta content as-is; `dashboard/src/ui/api.ts:100` builds `` `${base}/api/${path}` `` without normalising.
- **Why:** with `base = '/'` the URL is `//api/meta`, which a browser resolves as `https://api/meta` (host `api`). CSP `connect-src 'self'` blocks it, so every panel shows UNREACHABLE. The default configuration is broken. Related: the 10.8 regex `^/[A-Za-z0-9/_-]*$` also accepts `//evil.example` (becomes a cross-origin base; CSP blocks it, but it is still wrong) and trailing slashes (`/admin/` gives `/admin//api/meta`).
- **Fix:** normalise server-side: `'/'` becomes `''`, strip one trailing slash, tighten to `^(/[A-Za-z0-9_-]+)*$`; client uses the normalised value only. Tests: handler default config + served HTML => meta content is empty string; Playwright against the default config loads all five panels; `basePath` of `'//x'`, `'/a//b'`, `'/a/'` are rejected or normalised.

#### F-08 · HIGH · SPEC · Tenant scoping fails open when the reader process is configured differently from the writer

- **Where:** 3.6 (constant + `scope`), 11 T22, 13 R14, 4.3 example (reader repeats config).
- **Why:** scoping exists only if the process that serves the dashboard has the same `extraColumns` constant in its config. The spec itself says writer and reader are usually _different processes with separately maintained config_ and that drift is "the host's risk". A reader without the constant silently reads every tenant's rows (including personal data, with `pii.reveal` possible). Nothing at startup or in the handler warns.
- **Scenario:** shared table, writer app A sets `tenant_id: 7`; admin app forgets `extraColumns`. The dashboard shows all tenants' pages, emails, IPs.
- **Fix:** (a) the handler logs a `warn` at creation when no scope is configured ("reading the entire table; no scoping constant") unless `scope: 'none'` is acknowledged explicitly; (b) `inspect` reports "table has a column named like `tenant_*`/`site_*`/`org_*` and no scope configured"; (c) document one shared config module as the supported pattern. Test: statement capture proves every read statement (aggregates, probes, recent-visits, cursor pages) contains the bound scope predicate; and a handler without scope emits the warning.

#### F-09 · HIGH · DESIGN vs SPEC · The 90-day view always errors the new-vs-returning panel

- **Where:** DESIGN 7.4 (90d => `from = now - 90d`, week buckets, applied to every panel), DESIGN 8.3 (400 => "BAD REQUEST"), DESIGN 11. SPEC 10.5 `new-vs-returning`: range capped at `newVsReturningMaxRangeDays` (default 31), `400 range_too_large` beyond it; SPEC 10.9 rule 9.
- **Why:** the shipped range selector has a 90d option that the contract forbids for that endpoint. DESIGN predates the v0.2 cap and was not updated.
- **Scenario:** user clicks `90d`: four panels load, the new-vs-returning panel shows a red-stamp `BAD REQUEST` "That range isn't allowed". Also `30d` with `hour` is not used, so only 90d is affected today, but any host that lowers the cap (e.g. 14) breaks 30d too.
- **Fix:** DESIGN must say what that panel does when `range > meta.limits.newVsReturningMaxRangeDays`: clamp to the cap and label it ("Last 31 days") or show a calm unavailable state. Needs Bella's decision and Dan's implementation; test: Playwright with range 90d and a mocked meta cap of 31 => no error stamp, label states the clamped window.

#### F-10 · HIGH · PLAN · SQL Server has never run; there is no CI job that will run it; local run is impossible on this machine

- **Where:** SPEC 12 (Docker table, platform note), changelog deviation 9, risk R7; board task `ff6ce1f1` (release workflow only).
- **Why:** one of three products has zero real-database evidence: dialect SQL, `mssql` driver wrapper, T-SQL buckets, `JSON_VALUE`, filtered indexes, grants. Spec 12 says "enforced in CI where integration tests also run" and "`ubuntu-latest` CI is the first real run", but no task on the board creates a test workflow (ff6ce1f1 is docs/packaging/release). First contact with SQL Server would be at release.
- **Evidence (ran):** see section 5: the Docker VM is arm64 with 2 GiB RAM and no Rosetta; SQL Server needs amd64 and at least 2 GB.
- **Fix:** add an owned task now: GitHub Actions workflow with a matrix `{postgres, mysql, mssql}` as service containers running `DYNALITICS_INTEGRATION=1`, before anyone writes more MSSQL code. Until it is green, label MSSQL "unverified" in the README. Locally, see the options in section 5.

### MEDIUM

#### F-11 · MEDIUM · SPEC · Spec status contradicts itself and the repository

- **Where:** line 3 ("design only, nothing is implemented") vs lines 35-46 ("the server package is now implemented up to the read handler"); 2 and 10.9 item 6; `package.json` exports.
- **Why:** an engineer cannot tell what is real. Verified: `packages/dynalitics/src` has no `read/`, no handler, no `protocol.ts`; `package.json` exports only `.` and `./schema` (spec lists `./handler`, `./protocol`); board has the handler as TODO. The "vendored copy plus CI diff" rule (10.9 item 6) compares against `packages/dynalitics/src/protocol.ts`, which does not exist, so the dashboard's `protocol.ts` is currently the only copy.
- **Fix:** one status line per section (designed / implemented / tested), and create `src/protocol.ts` first because both sides build against it.

#### F-12 · MEDIUM · SPEC · Masking is specified only for well-formed values; unparseable values are not defined to fail closed

- **Where:** 10.6, 6.7 in DESIGN, 7.6 (legacy tables first-class).
- **Why:** "IPv4: keep first two octets" says nothing about values that are not a clean IPv4: legacy `X-Forwarded-For` lists (`1.2.3.4, 5.6.7.8`), ports, `unknown`, uppercase IPv6, zone ids. Email rule "first char + `***` + domain" says nothing about no `@`, several `@`, empty local part. Also the hash rule ("first 8 hex chars") is applied by the reader's configured `ip.mode`; if reader and writer drift (R14), a raw address could be passed through the hash rule or the reverse.
- **Scenario:** `ip_address = '203.0.113.9, 10.0.0.1'` in an existing table; a naive `split('.').slice(0,2)` yields `203.0.x.x`-looking output but a `slice` on the whole string can leak the list tail.
- **Fix:** masking functions must be total and fail closed: if the value does not match the expected shape for the configured mode, output a fixed `***`. Add property tests: random strings in, output never contains more than N characters of input and never contains a full octet beyond the second.

#### F-13 · MEDIUM · SPEC · Masking happens after the full personal columns are read; answer to open question 3

- **Where:** 10.6, 13 open question 3, 11 T5/T25.
- **Why:** the reader always `SELECT`s ip/email/username/userId and masks in JS. A handler bug, a debug log or a memory dump has unmasked data; the reader credential has to be able to read everything even when `pii.reveal` is false.
- **Recommendation (question 3: yes):** when `pii.reveal` is false, mask in SQL (`SUBSTRING`/`LEFT`/`CONCAT` per dialect, or select `CASE WHEN col IS NULL THEN 0 ELSE 1 END` for presence only), so full values never leave the database. Put it behind the same triple condition for reveal. Test: statement capture asserts that with reveal disabled no read statement selects the bare email/username/ip columns.

#### F-14 · MEDIUM · SPEC · "Page + timestamp" is not anonymous, and `pageVisited` is not validated as a path

- **Where:** 8.4, 14 objection 6 ("consent-denied rows (page + timestamp) are the only genuinely anonymous rows"), 4.2 ("path").
- **Why:** the path is exactly what consent-denied rows keep. Real paths carry identifiers: `/users/42/orders`, `/u/jane`, `/reset/<token>`, `/invite/<code>`, `/verify?...` (query stripped, but path tokens are not), matrix parameters `;jsessionid=...`. A timestamp plus such a path re-identifies. Also nothing requires a leading `/`: an absolute URL with userinfo (`https://user:pw@host/x`) is stored.
- **Fix:** (a) soften the "genuinely anonymous" claim; (b) add `page.normalize?: (path) => string` (host hook for route templates, e.g. `/users/:id`) and document it on the first README screen; (c) strip `;param` segments by default; (d) require a leading `/` (reject or take the path of an absolute URL and drop userinfo). Tests: absolute URL with credentials, `;jsessionid`, a path equal to a canary email.

#### F-15 · MEDIUM · SPEC · Micro-cache: unbounded key space, and defaults to `to = now` defeat it

- **Where:** 10.1 `cacheTtlMs`, 10.3 (defaults `to` = now), 13 open question 5.
- **Why:** "per (route, params, mask mode)" with `from`/`to` accepted to millisecond precision gives an unbounded number of keys, and an authorized client can fill memory. Conversely, a request without `to` has a different `to` every millisecond so the cache never hits, contradicting 8.5.1 ("`cacheTtlMs` turns repeated loads into one query").
- **Fix:** snap `to` (and default `from`) to the interval bucket boundary or to the cache TTL grid before building the key; cap the cache (LRU, e.g. 200 entries); keep the principal-independence argument written down (the key must contain mask mode, and `authorize` still runs per request). Test: 10 000 distinct `to` values keep the cache under its cap; two default requests within the TTL hit.

#### F-16 · MEDIUM · SPEC · `block` backpressure has no bound on waiting callers

- **Where:** 9 (`block`), 8 principle 5.
- **Why:** blocked `track()` calls are held up to `maxBlockMs` (2 s) with no cap. Fire-and-forget callers (`void dyn.track(...)`) are the documented usage, and each pending call retains its visit object. Under a request flood in `block` mode memory grows with `rate x maxBlockMs` while the queue is full, in the host process.
- **Fix:** cap waiters (e.g. `maxSize`), beyond which `track()` resolves `dropped/queue_full` immediately. Test: 100 000 calls against a stalled driver in `block` mode keep retained heap under a stated bound.

#### F-17 · MEDIUM · SPEC · Routing/path rules are unspecified; adapters can disagree on the mount path

- **Where:** 10.2 (adapters), 10.3.
- **Why:** not stated: trailing slash (`/api/meta/`), double slashes, case, percent-encoded separators (`%2F`, `%2e%2e`), NUL, `HEAD`/`OPTIONS`, query-string size when the URL has none. "`req.url`, mount path already stripped by Express; otherwise `basePath` is stripped" does not say how the adapter decides which case it is in, so `app.use('/admin/analytics', ...)` vs `app.get('/admin/analytics/*', ...)` vs Next catch-all behave differently, including a request to `/admin/analytics/admin/analytics/api/meta` being stripped twice. Because `authorize` runs first for every path this is not a direct bypass, but a host that guards only `/api/*` with its own middleware can be fooled by path-normalisation differences.
- **Fix:** write the rules: exact-match routes after one pass of percent-decoding of unreserved characters only; `//`, `..`, encoded `/` and NUL are 404 (after authorize); trailing slash allowed or not (pick one); `HEAD` is 405; basePath boundary check (`/admin/analyticsX` must not match `/admin/analytics`). Tests in section 6 (`routing-normalisation`).

#### F-18 · MEDIUM · SPEC · SQL Server `varchar` columns plus NVARCHAR parameters turn the identity index seek into a scan

- **Where:** 7.2 (`varchar(n)` allowed with only `non_unicode_column` warn), 5.2 (mssql binds with `request.input(name, value)`), 8.5.1 cost model.
- **Why (my knowledge, not run):** `node-mssql` binds JS strings as `NVarChar`; comparing a `varchar` column with an `nvarchar` parameter makes SQL Server convert the _column_ (data-type precedence), which prevents an index seek. The read-time new-vs-returning cost model ("one index seek per identity") then does not hold for existing tables with `varchar` identity columns and the widget times out.
- **Fix:** when introspection finds a `varchar` column, bind as `VarChar` with the column length (`request.input(name, sql.VarChar(len), v)`); raise the warning text to say "slower on this column". Fixture test on SQL Server: showplan has an Index Seek for the probe with a `varchar(128)` identity column.

#### F-19 · MEDIUM · SPEC · Naive timestamp columns: the dialect interface cannot express the right SQL, and Postgres `AT TIME ZONE` on a naive column depends on the session time zone

- **Where:** 5.1 (`bucketExpr(col, interval)`, `timestampParam(d)` take no encoding), 3.4 (`ValueEncoding` has `ts-utc-instant` vs `ts-utc-wall`), 10.10, 3.9.
- **Why:** 10.10 shows `date_trunc('day', "visited_at" AT TIME ZONE 'UTC')`, correct only for `timestamptz`. For a naive PG `timestamp` (accepted with a warning) `col AT TIME ZONE 'UTC'` returns a `timestamptz`, and `date_trunc` / `to_char` on that then use the **session** time zone, so buckets shift for any non-UTC session. The two interface methods above have no way to know which encoding applies.
- **Fix:** add the encoding to `bucketExpr`, `timestampParam` and the range-filter builder; document the PG naive-column expression (no `AT TIME ZONE`). Contract test (spec 12 item 2 already asks for a non-UTC session): same data, `SET TIME ZONE 'America/Los_Angeles'` on the reader session, naive and tz-aware columns => identical buckets.

#### F-20 · MEDIUM · SPEC · "Identity is case-sensitive" and name matching claims are wrong in places

- **Where:** 3.7 ("MySQL ... match case-insensitively"), 3.8 (collation), 8.5.1.
- **Why (my knowledge):** (a) MySQL _table_ and database names are case-sensitive on Linux (`lower_case_table_names=0`) and insensitive on macOS/Windows, so a config that works on a developer Mac fails in production or the reverse; column names are case-insensitive. (b) `utf8mb4_bin` is a PAD SPACE collation: `'u_42'` equals `'u_42 '`; `utf8mb4_0900_bin` (8.0.17+) is NO PAD. SQL Server also ignores trailing spaces in `=` comparisons. The spec claims byte-exact identity.
- **Fix:** state the table-name rule per platform, generate `utf8mb4_0900_bin` for MySQL 8.0.17+, trim identity values at write (`userId`, `ip`) so trailing-space duplicates cannot exist, and add a fixture test on each database: `'u_42'` vs `'u_42 '` and `'U_42'` vs `'u_42'`.

#### F-21 · MEDIUM · SPEC · `inspect` safety rests on a prefix allow-list that does not prove read-only; and 6.4 contradicts 5.2

- **Where:** 6.4 "Safety properties", 11 T20, 5.2 ("No `SET`, `USE`, DDL ... are ever sent").
- **Why:** "matches an allow-list (`SELECT`/`WITH`)" is a prefix test. A data-modifying CTE (`WITH x AS (INSERT ...)`), `SELECT ... INTO` (SQL Server), `SELECT pg_terminate_backend(...)`, `SELECT ... INTO OUTFILE` all start with those words. Also 6.4 opens the session read-only with PG `default_transaction_read_only` (a `SET`, or a connection option) which 5.2 says is never sent.
- **Fix:** the allow-list must be the exact statement texts generated by the dialect module (set membership on normalised text), not a regex; define the read-only session as a connection option rather than a statement, and reword 5.2 accordingly. Test: wrap the driver; assert every statement text is a member of the dialect's introspection set; assert a hostile table name never reaches statement text.

#### F-22 · MEDIUM · SPEC · `sql --writer/--reader` role names are pasted into SQL and are not validated

- **Where:** 6.1 (`generateGrants({ writerRole: '[app_writer]' })`), 6.2 ("replace the placeholders", output "piped into psql").
- **Why:** table names have a strict pattern; role names have none. The example passes a pre-bracketed string, i.e. raw text. The CLI's output is meant to be piped into `psql`/`mysql`/`sqlcmd`, so an injected role name (from a CI variable, a ticket) becomes executed DDL: `--writer "app; DROP TABLE users; --"`.
- **Fix:** validate role names per dialect (PG identifier or quoted identifier produced by us; MySQL `user`@`host` pieces; SQL Server `[name]` produced by us), accept the bare name only and quote it ourselves; reject anything else. Tests: injection corpus on `--writer`/`--reader`/`--table`.

#### F-23 · MEDIUM · DESIGN · DESIGN.md has no design for the v0.2 contract changes

- **Where:** DESIGN section 8 (states: loading/empty/error only), 6.4, 6.7, 11 (boot uses `defaults`, `limits`, `breakdowns`, `features` only) vs SPEC 10.9 rules 7-9 and changes C2-C5.
- **Why:** SPEC now requires: a calm `unavailable` state per widget (with `reason`/`message`), the `approximate` caveat on new-vs-returning, and driving columns/widgets from `meta.widgets` and `meta.fields` (a table column for an unmapped role must disappear, not show "—"). DESIGN 6.7(c) says a null value means "not provided", which is false for an unmapped role ("not collected by configuration"). Dan's `api.ts` already handles `unavailable`, so the code is ahead of the design: copy, visual treatment and the column-hiding rule are missing.
- **Fix:** Bella adds the three states and copy; table columns derived from `meta.fields`. Test: Playwright with a mocked meta where `email: false` and `newVsReturning.available:false` => no email column, calm unavailable block without error styling and without retry.

#### F-24 · MEDIUM · DESIGN · Hero numeral collision rule only covers the first 40% of the plot

- **Where:** DESIGN 4.4 item 2, 7.6.
- **Why:** the rule checks whether any of the first 40% of points is in the top 35% of the plot. A 104 px numeral is ~50 px per digit, so "1,234,567" is about 480 px wide, wider than 40% of an ~830 px plot; it overlaps points outside the checked window. The line is `--ink` and the numeral is `--ink`, so wherever they cross the contrast is 1:1 (WCAG 1.4.3 for large text over a complex background).
- **Fix:** derive the check from the measured numeral width (`getBoundingClientRect`) and test all points under it; keep the stacked fallback. Test: Playwright, totals of 7, 80, 801, 12,345, 1,234,567 at 1024/1440; assert the numeral's box does not intersect the path bbox in the overlay case (or that the stacked class is applied).

#### F-25 · MEDIUM · DESIGN · Contrast: the headline claims hold against `--bg`, but there are counter-cases (recomputed)

- **Where:** DESIGN 2.1/2.2, 4.6, 6.5, 9.4 ("all text >= 4.5:1 and all non-text marks >= 3:1 in both themes").
- **Verified OK (recomputed, matches the document within 0.05):** ink, ink-2, accent, returning, granted, declined, unknown, danger, categorical colours, rule-strong against `--bg` in both themes.
- **Counter-cases (recomputed):**
  - `--rule-strong` (control and input borders, "3.2:1") on `--surface` in **dark** is **2.96:1**, below the 3:1 of WCAG 1.4.11. The hero panel and the recent-visits sheet are `--surface`, so the Chart/Table toggle, Split-by select and "Show full values" button inside them fall under it. (Light: 3.47, fine.)
  - Top-pages `Share`/rank text is `--ink-2` over the row bar. At the 38% hover state: **4.24:1 light, 3.74:1 dark**, below 4.5:1 for 13 px text. At rest (22%) it is 5.4 in both. The document says "ink 11:1 or better"; actual ink on the 38% bar is 8.6 (light) and 7.1 (dark): passing, but the stated number is wrong.
  - Focus ring comment "ratio is higher still on `--surface`": in dark, accent on `--surface` is 7.40 vs 7.93 on `--bg` (lower, still passes).
- **Fix:** raise dark `--rule-strong` to about `#7a7360` (>= 3:1 on `--surface`), make hover text `--ink` or cap the hover mix at 30%, correct the stated numbers. Keep the token script in CI (13.2 last bullet) and add `--surface` and hover-mix pairs to it.

#### F-26 · MEDIUM · DESIGN · `<html lang>` from `navigator.language` on an English-only UI

- **Where:** DESIGN 9.1.
- **Why:** all UI copy is fixed English. With `lang="de"` a German user's screen reader pronounces English with German rules (WCAG 3.1.1 Language of Page). Number/date formatting following the browser locale (section 11) is a separate matter and is fine.
- **Fix:** `lang="en"` (or the language of the shipped copy). Wrap formatted dates in nothing special. Test: axe `html-has-lang` and `valid-lang` plus an assertion that `lang` equals the copy language.

#### F-27 · MEDIUM · DESIGN/PLAN · The 45 KB page budget is already exceeded by 37%

- **Where:** DESIGN 0 item 6 (<= 45 KB total: CSS <= 11, JS <= 28, markup <= 6), 12.1.
- **Measured (ran):** built `packages/dynalitics-dashboard/dist/dashboard.html` is **61,853 bytes** (CSS 21,349; JS 38,468; other 2,036); 20,409 bytes gzipped. CSS is nearly twice its budget, JS is 37% over.
- **Why it matters:** either the budget is wrong for this design (patterns, two themes, forced-colors, keyboard chart navigation, eight states, table twins) or the build is bloated. The number is also used as an acceptance criterion by Bella.
- **Fix:** decide which. If the budget stays, split the CSS (the token block and print/forced-colors are the usual savings) and minify; if it moves, restate it as gzipped (<= 25 KB is realistic) and have CI fail on regression. The CSP and `nonce` approach itself does not limit size.

#### F-28 · MEDIUM · DESIGN · Categorical series colours are not distinguishable under red-green colour blindness, contrary to the claim

- **Where:** DESIGN 2.2 ("survive colour-blindness"), 6.3 (split-by stacked areas), 7.5.
- **Evidence (ran, Machado 2009 simulation, CIE76 delta E):** light theme `--cat-2` vermilion vs `--cat-4` ochre: **dE 4.6 (deuteranopia), 4.5 (protanopia)**, i.e. effectively the same colour; dark theme `--cat-2` vs `--cat-4`: 9.1 (deutan). `--cat-1` blue vs `--cat-5` plum: 8.6 (light protan). A delta E under about 10-15 is hard to tell apart in an area chart. New vs returning (accent vs blue) and granted vs declined are fine (dE 80-105 and 13-25, and declined is hatched).
- **Why:** with "Split by" a custom field with >= 4 values, series 2 and 4 are indistinguishable for about 6% of men; the legend maps by swatch colour. The table twin exists, so conformance is arguable, but the claim in the document is false.
- **Fix:** give series 2 and 4 different patterns or reorder (blue, vermilion, plum, ochre, green fails too; test the candidate set with the same script), and direct-label the largest series.

### LOW

#### F-29 · LOW · PLAN · Support matrix is wider than what will be tested

- **Where:** 3.8 ("MySQL 8.0+", "SQL Server 2017+"), 12 Docker table, R5.
- **Why:** CI lists `postgres:17` (smoke on 16), `mysql:8.4`, `mssql 2022` only; claims cover MySQL 8.0, SQL Server 2017/2019. The compose file uses `postgres:17-alpine` (musl; collation and locale behaviour differ from the Debian image most hosts run), while 12 says `postgres:17`. Peer ranges (`pg ^8.0.0`, `mysql2 ^3.0.0`, `mssql ^12.0.0`) are tested only at the latest versions.
- **Fix:** either narrow the claims ("tested on ...") or add a CI row per claimed floor (MySQL 8.0 image is already pulled locally; MSSQL 2019). Use the Debian PG image in CI.

#### F-30 · LOW · SPEC · At-least-once writes can duplicate rows

- **Where:** 9 (retry on transient errors).
- **Why:** a timeout or connection reset after the server committed the INSERT leads to a retry of the same batch. No event id, so duplicates inflate visit counts. The loss model is documented; duplication is not.
- **Fix:** document it; optionally stop retrying `ECONNRESET`-after-send for multi-row batches unless the driver can say the statement was not received.

#### F-31 · LOW · SPEC · Consent handling: text inconsistencies, and rejecting skews the consent rate

- **Where:** 8.1 step 1 ("consent (if present) is a boolean") vs changelog deviation 8 (`null` treated as absent), 4.2 (`consent?: boolean`), 8.2 row 6.
- **Why:** `consent: null` is accepted (fail closed) per the deviation but the normative text still says non-boolean is rejected. Also, a rejected non-boolean consent (`'yes'`, `1`) drops the entire event, so it is counted in neither granted nor denied and the dashboard's consent rate and visit counts are biased by a host bug that is only visible in `onError`.
- **Fix:** update 8.1; consider storing `consent=false` with no personal data for non-boolean values (counts stay right, privacy still holds) and reporting `invalid_visit`. Product decision for Alex. Current behaviour is covered by existing tests.

#### F-32 · LOW · SPEC · `userId` number edge cases undefined

- **Where:** 4.2, 8.1 step 1 ("Numbers are converted to strings"), 7.2.
- **Why:** `0`, `NaN`, `Infinity`, `-0`, `1.5`, `2**53`, `BigInt` have no defined outcome (`if (userId)` would drop `0`, `String(NaN)` is `'NaN'`).
- **Fix:** accept finite safe integers and strings; everything else is `invalid_user_id`. Table-driven test.

#### F-33 · LOW · SPEC · Control-character stripping covers C0 only

- **Where:** 8.1 step 4, T14.
- **Why:** C1 controls (U+0080-U+009F), U+2028/2029 and bidi controls (U+202A-202E, U+2066-2069) survive. Log injection through U+2028 in JSON-lines pipelines and bidi spoofing of `pageVisited` (`/admin‮nigol`) remain. DESIGN 10.2 contains rendering (`unicode-bidi: isolate` does terminate overrides at the isolate boundary, so the dashboard is fine), but other consumers of the table are not covered.
- **Fix:** strip C1, U+2028/9 and bidi controls too (or document why not).

#### F-34 · LOW · SPEC · Numeric types from the drivers do not match the JSON examples

- **Where:** 10.5 JSON examples (counts as numbers, `id` as string), 5.2.
- **Why (my knowledge):** `pg` returns `bigint`/`count(*)` as strings unless a type parser is installed, and a host may have changed the global parser; `mysql2` returns `BIGINT` as number unless `supportBigNumbers`; SQL Server `COUNT(*)` is `int` and overflows at 2^31 (`COUNT_BIG` needed). For host-supplied pools the package cannot set driver options.
- **Fix:** cast in SQL (`COUNT(*)::int` / `CAST(id AS CHAR)`, `COUNT_BIG`) and convert explicitly; contract test with `pg.types.setTypeParser` altered globally.

#### F-35 · LOW · SPEC · `mysql2.execute` prepared-statement cache grows with every distinct batch size

- **Where:** 5.2 (MySQL uses true prepared statements), 9 (batch sizes vary 1..200).
- **Why:** each distinct `INSERT ... VALUES (...)x n` text is a separate prepared statement per connection; `max_prepared_stmt_count` is global (default 16382).
- **Fix:** use `query` (client-side escaping with the same bound values) for multi-row inserts, or pad batches to a few fixed sizes. Test: 200 distinct batch sizes do not exceed N prepared statements on the server (`Prepared_stmt_count` status).

#### F-36 · LOW · SPEC · PostgreSQL schema resolution can diverge between introspection and INSERT

- **Where:** 3.7 (omitted schema: `current_schema()`), 7.1 step 5.
- **Why:** `current_schema()` is the first schema in `search_path` that exists, not the schema where an unqualified table name resolves. Introspection and the INSERT can then look at different tables; a role that can create objects in an earlier schema could shadow the table.
- **Fix:** resolve once at startup and emit fully qualified names everywhere afterwards (the spec says the resolved name is logged; say that it is also used).

#### F-37 · LOW · SPEC/DESIGN · "No value" in breakdowns is described as "denied consent" but non-personal fields are kept

- **Where:** 10.5 visits-over-time (`value: null ... denied consent rows have null custom data`), 8.2 row 2 (`{"plan":"pro"}` kept when consent is false), DESIGN 6.3 ("No value").
- **Fix:** reword to "rows without a value for this field" in both documents, or the dashboard will mislabel segments.

#### F-38 · LOW · SPEC · New-vs-returning: aggregate and per-row forms disagree without `id`, and `max(0, ...)` hides defects

- **Where:** 8.5.1 (ties), 10.11 (`returning = max(0, identified - new)`).
- **Why:** without `id`, two rows of one identity with the same earliest timestamp are both "first" per row but one `new` in the aggregate. The clamp makes any over-count of `new` invisible.
- **Fix:** keep the clamp out of the oracle comparison: the test asserts `identified - new >= 0` as an invariant rather than relying on the clamp.

#### F-39 · LOW · SPEC · 5.1 test invariant contradicts the inline exceptions

- **Where:** 5.1 last bullet ("no user-controlled characters") vs rules (b) JSON key literal and (c) integer LIMIT/TOP.
- **Fix:** define the oracle precisely: after removing quoted identifiers and parameter markers, only `[A-Za-z0-9_ (),.*=<>$@?'-]` plus the allow-listed JSON-key literals and digits may remain. Otherwise the unit test cannot be written.

#### F-40 · LOW · SPEC · Handler `onError` payload is undefined

- **Where:** 10.1 (`onError: (e) => log(e)`), 4.3 (`ErrorInfo` is for the tracker).
- **Why:** if the payload carries the request (`req.raw`, headers) a host that logs it writes cookies and bearer tokens to its logs.
- **Fix:** define a handler error type with route, status, error code and a redacted cause; no request object.

#### F-41 · LOW · SPEC · Next.js example may be statically cached and may run on the edge runtime

- **Where:** 10.1 (`export const GET = toFetchHandler(handler)`).
- **Why (my knowledge, version dependent, not run):** route handler caching defaults differ by Next version, and `pg`/`mysql2`/`mssql` do not run on the Edge runtime. An authorized JSON response cached at build or served from a shared cache would bypass `authorize`.
- **Fix:** the example should export `dynamic = 'force-dynamic'` and `runtime = 'nodejs'`; add a CI test that builds a Next sample and asserts two requests reach `authorize` twice.

#### F-42 · LOW · DESIGN/SPEC · The HTML dashboard only works with ambient credentials

- **Where:** 10.8 (`credentials: 'same-origin'`), DESIGN 8.3.
- **Why:** hosts that authorize by `Authorization: Bearer` cannot use the served page (no way to attach it); an SSO redirect to another origin is a network error and is shown as "UNREACHABLE ... nothing was lost", which is the wrong diagnosis.
- **Fix:** document it, and treat an opaque redirect / CORS failure on first load as the "UNEXPECTED REPLY" state.

#### F-43 · LOW · DESIGN · Small accessibility defects

- **Where:** DESIGN 6.1 (theme button: label flips "Dark"/"Light" and `aria-pressed` flips), 6.7 (`aria-description` "masked"), 9.3/7.7 (chart is `role=group` with arrow keys, no instructions).
- **Why:** a toggle should keep one label and use `aria-pressed` (a flipping label plus a flipping state reads as a contradiction); `aria-description` is not reliably exposed by assistive technology, use visually-hidden text; keyboard users are never told that arrows work in the chart.
- **Fix:** constant label "Dark theme" + `aria-pressed`; visually-hidden "(masked)" text in the column header; `aria-describedby` hint "Use left and right arrow keys to explore". axe-core covers part of this (section 6, `a11y`).

#### F-44 · LOW · PLAN · Supply-chain residue

- **Where:** 11 T15.
- **Why:** `.npmrc ignore-scripts=true` protects this repo's own installs, not consumers. The `mssql` peer pulls `tedious` and a large tree (acknowledged). The dashboard HTML is a build artefact embedded in the published package; nothing checks that the published string equals a fresh build.
- **Fix:** add a CI step that rebuilds the HTML and diffs it with the packed file; `npm pack --dry-run` file list assertion; `npm audit --omit=dev --audit-level=high` as a gate.

#### F-45 · LOW · SPEC · MySQL `TIMESTAMP` session-zone check looks at one connection

- **Where:** 3.9, 7.3 `timestamp_session_timezone`.
- **Why:** pooled connections can have different session zones (host pools with an init hook on some connections only), and a DST-observing named zone shows a different offset in summer and winter; the check runs once on one connection.
- **Fix:** check on each new connection (pool `connect` event) or recommend `DATETIME`; test with a pool whose second connection has a different zone.

---

## 3. Contradictions and ambiguities summary (item 1 of the brief)

Collected from the findings above so that nobody has to grep:

- Status: "nothing is implemented" vs "implemented up to the read handler" (F-11).
- Timeouts: "enforced by the driver" (10.3) vs deviation 7 (SQL Server) vs host pools (F-05).
- Denied consent stores only page+time (brief and DESIGN 6.6 copy) vs non-personal custom fields/constants/computed are also stored (8.2) (F-03).
- `consent: null` handling: 8.1 vs deviation 8 (F-31).
- "No value" means denied consent (10.5) vs non-personal fields kept (F-37).
- 5.2 "no SET" vs 6.4 read-only session setting (F-21).
- 5.1 "no user-controlled characters" vs inline JSON keys and LIMIT (F-39).
- DESIGN ranges (90d) vs `newVsReturningMaxRangeDays` 31 (F-09); DESIGN has no `unavailable`/`approximate`/`meta.fields` handling (F-23).
- `dynalitics/protocol` source path vs repo (F-11); Docker image in 12 (`postgres:17`) vs compose (`17-alpine`) (F-29).
- Open ambiguity to settle in the text: case-insensitive matching claims (F-20), adapter mount-path stripping (F-17), `authorize` non-boolean results (F-01).

---

## 4. Requirements that cannot be tested as written (item 3)

| Requirement (location)                                                         | Why it cannot be tested                                              | What makes it testable                                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| "each query has `timeoutMs`, enforced by the driver" (10.3)                    | not true for SQL Server and host pools; "enforced" has no observable | observable = no server session left for the query after timeout + 2 s, per database (F-05)                                                            |
| "cheap for D in thousands, noticeable at hundreds of thousands" (8.5.1)        | no numbers                                                           | fixture with N rows / D identities and a p95 budget per database, or delete the sentence                                                              |
| "timing guard that fails if the plan scans" (12 item 7)                        | the spec itself calls it non-deterministic                           | assert plan operators (PG `EXPLAIN (FORMAT JSON)` contains `Index Scan`/`Index Only Scan` on the probe; SQL Server showplan XML contains `IndexSeek`) |
| Multi-instance write-time duplicates "demonstrated, not hidden" (12 item 3)    | race-dependent                                                       | two instances sharing a gated fake driver with a barrier so both read before either commits                                                           |
| Privilege warnings "seems" (7.5), MySQL roles                                  | advisory, role/group privileges undefined                            | test only direct grants, and say roles are out of scope                                                                                               |
| "Detection of triggers, partitioning, collation, indexes is best effort" (7.3) | a missing warning proves nothing; no negative assertion possible     | positive tests on fixtures only                                                                                                                       |
| "removing identifiers and markers leaves no user-controlled characters" (5.1)  | conflicts with inline exceptions                                     | explicit allowed-character oracle (F-39)                                                                                                              |
| "Analytics must never hurt the host" (principle 5)                             | unbounded in `block` mode (F-16), retries (F-04)                     | bounded heap under flood, bounded statement count under permanent failure                                                                             |
| Hash IP "non-reversible" (8.3)                                                 | not a testable property                                              | test keyed, stable, salt-dependent, 64 hex (exists)                                                                                                   |
| Hero numeral "legible" / "calm" (DESIGN 4.4, 7.6, 13.2)                        | subjective                                                           | bounding-box intersection test + axe contrast (F-24)                                                                                                  |
| Registry provenance, "no tokens in repo" (T15)                                 | only observable at release                                           | `npm pack --dry-run` file-list test, secret scan in CI, workflow lint; provenance verified manually after the first publish                           |
| Statement-level claims on SQL Server (all)                                     | no server available locally                                          | CI service container (F-10)                                                                                                                           |

---

## 5. Environment: can PostgreSQL, MySQL and SQL Server run here? (item 6)

Facts (ran):

- Docker client/server 29.2.1 via **Colima** (`vz`, **aarch64**, 2 CPUs, **2 GiB RAM**, `rosetta: false`, `binfmt: true`). Host: Apple M3 Pro. VM is Ubuntu 24.04 arm64.
- Already running (started by someone else, healthy for 2 hours; I did not start or stop them): `dynalitics-test-postgres-1` (postgres:17-alpine, 30 MiB), `dynalitics-test-mysql-1` (mysql:8.4, 567 MiB). Also unrelated to this project: `qa-tidb` (503 MiB), `xcite-postgres-db`, `redis-cache`.
- Memory inside the VM: 2.0 GB total, **about 0.5 GB available** with those five containers running.

Verdict:

| Database               | Runs here?                 | Detail                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 17 (alpine) | **Yes**                    | native arm64, in use by the integration suite                                                                                                                                                                                                                                                                                                                 |
| MySQL 8.4              | **Yes**                    | native arm64, in use by the integration suite. MySQL 8.0 image is also present locally (not part of the suite)                                                                                                                                                                                                                                                |
| SQL Server 2022        | **No** (and I did not try) | (1) the image is amd64-only; the VM is aarch64 with **Rosetta disabled**, so it would run under QEMU user-mode emulation, where `sqlservr` is reported to abort (this matches Tom's note in deviation 9; I did not re-run it). (2) SQL Server needs at least 2 GB; this VM has 2 GB in total and about 0.5 GB free. The 2.35 GB amd64 image is already pulled |

Why I did not start SQL Server: it would very likely exhaust the VM's memory and get other containers OOM-killed, and those include containers that belong to other projects (`xcite-postgres-db`, `redis-cache`, `qa-tidb`). Starting it is not worth that risk for a result I can already predict.

Options for running SQL Server locally (user decision, not done by me): `colima stop && colima start --vm-type vz --vz-rosetta --cpu 4 --memory 6` (this stops every container currently running; Rosetta support for the 2022 image is something I have **not verified**); or run the MSSQL suite only in CI on `ubuntu-latest` (F-10). I recommend the CI route and treating local SQL Server as optional.

Cleanup: I left no containers behind. The only side effect was pulling `alpine:3` (a few MB) to read `/proc/meminfo` inside the VM; the container was run with `--rm`. The MySQL check used a session-scoped `TEMPORARY TABLE` that disappeared on disconnect. `docker ps` after the work shows exactly the five containers that were running before.

Phase plan and test strategy realism (item 6, rest):

- The plan is ambitious relative to the evidence: the dashboard (board: DOING) is being built against a handler that is not written (TODO), a contract that changed mid-build (C1-C9), and a design that was not updated (F-23). Expect rework in `api.ts`, `meta.ts` and the panels.
- Test strategy layer 7 (brute-force oracle with random datasets over 3 databases x `ipIdentity` x `ip.mode`) and layer 8 (about 15 legacy fixture tables per dialect) are each larger than the rest of the suite together. Realistic only if the oracle is built once in pure JS and the fixtures are generated from a table description, not hand-written per dialect.
- No board task owns the test CI workflow (F-10) or the shared protocol source (F-11). Both block the others.
- Suggested order for QA, matching Tom's own #11: (1) pin the contract with a fake-driver handler suite the day `createHandler` lands, (2) recommended-table integration on PG+MySQL (done: 100 tests), (3) CI with SQL Server, (4) existing-table fixtures, (5) oracle.

---

## 6. Test plan skeleton (integration and security suites, once code lands)

Legend: **exists** = already written and passing (`packages/dynalitics/test/integration/db.test.ts`, `privacy-security.test.ts`, unit suite); **new** = to write. "3DB" = runs on Postgres, MySQL and SQL Server (SQL Server in CI).

### 6.1 Consent gate and tracking (`integration/privacy-security.test.ts`, unit `build-row`)

| Requirement                                             | Test name                                                                                                                             | Status        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 8.2 rows 1-6, 9: matrix, denied/absent/null/non-boolean | `consent matrix: explicit false/true/absent/null/'yes'/throwing resolver`                                                             | exists        |
| Invariant: denied => every personal column NULL         | `property: consent=false never stores ip/userId/username/email/personal custom`                                                       | exists (unit) |
| F-03 compute under denied consent                       | `compute(personal:false) under consent=false receives no ip/userId/username/email keys`                                               | new           |
| F-03 constants always written                           | `constant extra column is written on denied rows`                                                                                     | new           |
| 8.3 IP modes raw/truncate/hash/invalid                  | `ip modes: raw, truncate v4/v6, hash keyed+stable+salt-dependent, hostile addresses`                                                  | exists        |
| 3.5 custom keys, prototype pollution                    | `hostile custom keys are dropped, no prototype pollution, unknown_custom_field reported`                                              | exists        |
| F-14 path PII                                           | `absolute URL with userinfo is rejected or reduced to its path`, `;jsessionid stripped`, `page.normalize hook applied before storage` | new           |
| F-32 userId numerics                                    | `userId 0 stored; NaN/Infinity/1.5/2**53 -> invalid_user_id`                                                                          | new           |
| F-33 control chars                                      | `C1, U+2028/2029 and bidi controls removed from stored strings`                                                                       | new           |
| 8.4 limits                                              | `oversize truncate vs reject; custom >20 keys or >4096 bytes rejects`                                                                 | exists (unit) |

### 6.2 Errors, logs and secrets (new suite `security/leaks.test.ts`, 3DB)

| Requirement          | Test name                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| T4 connection string | `canary password never appears in thrown errors, logs, stats(), JSON, CLI stdout/stderr` (partly exists)        |
| F-02 visitor values  | `canary email through type, unique, check and truncation errors never reaches onError.cause, logger or stats()` |
| F-02 hints           | `permission denied hint is present without echoing values`                                                      |
| F-40 handler errors  | `handler onError payload contains no headers, cookies or request object`                                        |

### 6.3 Queue and resource limits (`integration/queue.test.ts`, fake driver + 3DB)

| Requirement             | Test name                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| 9 batching/backpressure | `drop and block backpressure, flush, close idempotent` (exists, partly)                    |
| F-04 circuit breaker    | `permission denied on a 200-row batch issues one failing statement, then backs off`        |
| F-04 poison row         | `one bad row among 200 loses exactly one event`                                            |
| F-16 block waiters      | `100k track() calls in block mode against a stalled driver keep retained heap under bound` |
| F-30 duplicates         | `ambiguous transient failure may duplicate; documented behaviour pinned`                   |
| F-35 statements         | `200 distinct batch sizes keep Prepared_stmt_count under N (MySQL)`                        |
| Parameter limits        | `batch split respects 2100 (mssql) / 65535 params` (exists on PG/MySQL)                    |

### 6.4 Read handler: auth and routing (new `security/handler-auth.test.ts`, fake driver first, then 3DB)

| Requirement                     | Test name                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| createHandler without authorize | `throws when authorize is missing or not a function`                                                                          |
| F-01 strictness                 | `authorize returning 'yes', 1, {}, {allowed:'false'}, undefined, null -> 403`                                                 |
| F-01 reveal strictness          | `revealPii 'no' / 1 -> masked`                                                                                                |
| 10.3 order                      | `authorize runs before 404, 405, parameter validation and before any DB call (spy)`                                           |
| 10.3 fail closed                | `authorize throw/reject -> 500, never 200`; `authorize never settles -> 500 after deadline`                                   |
| 10.3 methods                    | `POST, PUT, DELETE, OPTIONS, HEAD, TRACE -> 405 with Allow: GET; X-HTTP-Method-Override and _method ignored`                  |
| F-17 routing                    | `//api/meta, /api/meta/, /API/meta, /api/%2e%2e/meta, /api/meta%00, %2F -> 404 after authorize`; `basePath boundary`          |
| F-07 base                       | `default basePath serves meta content ''; '//x', '/a//b', '/a/' rejected or normalised`                                       |
| 10.3 headers                    | `no-store, nosniff, referrer no-referrer on every response incl. errors and 403`                                              |
| CORS/CSRF                       | `no Access-Control-* headers; OPTIONS preflight gets no allow headers; GET with Origin of another site still needs authorize` |
| Caching                         | `authorized response never served to a second request without calling authorize; reveal and masked do not share a cache key`  |
| F-15 micro-cache                | `10,000 distinct to values stay under cache cap; default requests hit within TTL`                                             |
| 10.3 strict params              | `unknown, duplicate, array-style (a[]=1), __proto__, constructor, > 2 KB query -> 400`                                        |
| 10.5 cursor                     | `cursor: bad base64, SQL text, extra fields, huge ints -> 400; valid cursor binds typed values`                               |
| 10.3 limits                     | `range, bucket, limit caps -> 400 range_too_large; concurrency 4 then 503`                                                    |
| F-05 timeouts                   | `timeoutMs 1000 against pg_sleep/SLEEP/WAITFOR leaves no active server session within 2 s (3DB)`                              |

### 6.5 Masking and scoping (new `security/handler-pii.test.ts`, 3DB)

| Requirement           | Test name                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.6 default mask     | `ip/email/username masked by default; custom personal -> '***'`                                                                                        |
| F-06 userId           | `userId containing '@' or longer than N is masked by default`                                                                                          |
| F-12 fail closed      | `property: for random strings the masked output never reveals more than the allowed characters`; `XFF list, port, uppercase IPv6, no '@'`              |
| 10.6 reveal triple    | `reveal needs config + authorize + ?pii=reveal; any one missing -> masked and meta.piiMasked true`; `?pii=other -> 400`; `?pii on other routes -> 400` |
| F-13 SQL-side masking | `with reveal disabled no read statement selects bare email/username/ip columns (statement capture)`                                                    |
| 3.6/F-08 scoping      | `every read statement carries the bound scope predicate`; `handler without scope warns at creation`                                                    |

### 6.6 SQL safety (extend `integration/privacy-security.test.ts`, unit `dialect`)

| Requirement                      | Test name                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| T1/T2 injection (values, idents) | `hostile values round-trip`, `hostile table/column/custom-key names refused` (exists)                                     |
| T3 breakdown + JSON key          | `breakdown name not in allow-list -> 400; JSON key literal only from validated config`                                    |
| F-39 oracle                      | `generated SQL minus identifiers and markers matches the allowed-character oracle (all statements, 3 dialects)`           |
| F-22 roles                       | `--writer/--reader injection corpus rejected`                                                                             |
| F-21 inspect                     | `every inspect statement is a member of the dialect's introspection set; hostile table name never reaches statement text` |
| T19/T16 CLI                      | `sql opens no socket; inspect refuses connection strings on argv; canary absent from output; reads JSON only`             |

### 6.7 Cross-database behaviour (new `contract/` suite, 3DB, with non-UTC sessions)

| Requirement            | Test name                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-19 / 3.9 timestamps  | `buckets identical for tz-aware and naive columns under SET TIME ZONE America/Los_Angeles`; `week starts Monday regardless of DATEFIRST / default_week_format` |
| F-45                   | `MySQL TIMESTAMP column with a second connection in a different zone`                                                                                          |
| F-20 identity equality | `'U_42' vs 'u_42' distinct; 'u_42' vs 'u_42 ' distinct (after trimming); lower_case_table_names noted`                                                         |
| F-18 plan              | `varchar identity column probe is an index seek (SQL Server showplan)`                                                                                         |
| F-34 types             | `counts are JS numbers and id is a string even with a custom pg type parser`                                                                                   |
| Identifier limits      | `63-char names pass on PG; 64-char rejected by our pattern`                                                                                                    |
| JSON                   | `json/jsonb/NVARCHAR round-trip semantically equal; key order not asserted; \u0000 stripped`                                                                   |
| LIMIT/TOP              | `limit 1, max, and cursor page boundaries on all three`                                                                                                        |

### 6.8 New vs returning (new `contract/new-vs-returning-oracle.test.ts`, 3DB)

| Requirement               | Test name                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 8.5.1 oracle              | `aggregate SQL equals brute-force JS oracle for random datasets (ties, NULL/denied consent, rows before from, legacy rows, scope)` |
| F-38 invariant            | `new <= identified in every bucket (no reliance on the clamp)`                                                                     |
| 8.5.1 availability matrix | `unavailable reasons: no_identity_column, identity_not_reliable, disabled_by_host, column_not_mapped`; `approximate flag`          |
| 10.5 sum rule             | `new + returning + unknown == visits-over-time for the same range`                                                                 |
| Range cap                 | `range > newVsReturningMaxRangeDays -> 400`                                                                                        |
| 8.5.2 write-time          | `lookup_failed with INSERT-only writer until column grant` (exists, 3DB); `two-instance race with barrier`                         |

### 6.9 Existing tables, schema generator (new `integration/existing-tables.test.ts`, 3DB)

| Requirement       | Test name                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12 item 4         | `generated DDL validates; each dropped/altered column yields the specific problem; printed live fix makes startup succeed` (exists for PG/MySQL)              |
| 7.3 messages      | `snapshot of every problem and warning text`                                                                                                                  |
| 7.2 compatibility | `integer consent, naive timestamps, uuid/int user ids, serial with and without sequence grant, view, trigger, partition, ci collation, utf8mb3, 3-part names` |
| 3.6 extra columns | `constant scopes reads; compute exception -> NULL; NOT NULL column + exception -> rejected`                                                                   |

### 6.10 Dashboard (Playwright, both themes; `dashboard/test/ui/*` for jsdom)

| Requirement          | Test name                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T6 / 10.9 rule 1 XSS | `<img onerror>`, `<script>`, `javascript:`, bidi override, 10 KB string render as inert text in every panel (exists in jsdom `xss.test.ts`; add end-to-end with real handler)                                          |
| CSP                  | `no CSP violation events with the real handler's header; nonce differs per request`                                                                                                                                    |
| F-07                 | `default basePath loads all five panels`                                                                                                                                                                               |
| F-09                 | `90d range with meta cap 31: no error stamp; label shows clamped window`                                                                                                                                               |
| F-23                 | `meta.fields false hides column; unavailable renders calm, no retry; approximate caveat shown`                                                                                                                         |
| F-24                 | `hero numeral vs path bbox for totals 7..1,234,567 at 1024/1440`                                                                                                                                                       |
| a11y                 | `axe-core: zero serious/critical violations, both themes, all states`; `keyboard-only walk (13.2)`; `prefers-reduced-motion: no running animations`; `forced-colors screenshot`; `lang attribute equals copy language` |
| Contrast script      | `token contrast table recomputed in CI, including --surface and hover-mix pairs (F-25)`                                                                                                                                |
| F-27 budget          | `dist/dashboard.html size <= agreed budget (CI gate)`                                                                                                                                                                  |
| Responsive           | `320, 375, 768, 1024, 1440, 1920: no horizontal overflow`                                                                                                                                                              |
| Release              | `npm pack --dry-run file list; rebuilt HTML equals packed HTML; no tokens in repo` (F-44)                                                                                                                              |

---

## 7. What held up under checking

So the findings are read in proportion:

- Every contrast ratio in DESIGN.md section 2 matches my recomputation within 0.05 against `--bg` (F-25 lists the cases it does not cover).
- The CSP claim that CSSOM writes (`el.style.setProperty`) are allowed under `style-src 'nonce-...'` while `style=""` attributes and inline handlers are blocked is correct (my knowledge), and the design consistently avoids the blocked forms.
- The consent matrix in 8.2 is precise and, for rows 1-6, 8-9, already behaves as written in the integration suite (78 tests today).
- "Authorize first, even for unknown paths" with `403` and `no-store` on every response is the right order; the problems above are about what counts as "allowed", not about the ordering.
- Identifier handling (strict pattern plus per-dialect quoting) held up against the hostile corpus in `privacy-security.test.ts`; no injection reached SQL text.
- Zero runtime dependencies is real: `dependencies` is absent in `packages/dynalitics/package.json`; drivers are optional peers.

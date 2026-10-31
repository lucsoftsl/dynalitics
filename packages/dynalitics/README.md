# dynalitics

Server-side analytics that write **one row per visit into your own SQL database** (PostgreSQL, MySQL, SQL Server). There is no dynalitics service, no tracking script and no cookie (the optional [`dynalitics-consent`](https://www.npmjs.com/package/dynalitics-consent) banner sets one, holding only the visitor's choice): your server calls `track()`, and a row lands in a table you own. The same package also serves a read API for the dashboard.

> **Early release (`0.1.x`; the API may still change before 1.0).** Everything below has run against real PostgreSQL 17 and MySQL 8.4 in local integration tests. `0.1.0` is published from a maintainer's machine, so it has no npm provenance; later versions are published by GitHub Actions with provenance.
>
> **SQL Server support: TBD.** The first real run (GitHub Actions) found a bug in how SQL Server formats times, now fixed but not yet confirmed. `dynalitics-mssql` is published automatically, with the same version as the other packages, only once the SQL Server CI job is green; until then it is not on npm.

## Which packages you need

`dynalitics` is the core. It has no dependencies and never loads a database driver. You add **one adapter** for your database, and optionally the dashboard:

| Package                                                                      | What it does                                                                                       | You need it when                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `dynalitics`                                                                 | `track()`, table validation, the `dynalitics sql` CLI, the read API (handler)                      | always                                 |
| [`dynalitics-postgres`](https://www.npmjs.com/package/dynalitics-postgres)   | connects to PostgreSQL through `pg`                                                                | your database is PostgreSQL            |
| [`dynalitics-mysql`](https://www.npmjs.com/package/dynalitics-mysql)         | connects to MySQL through `mysql2`                                                                 | your database is MySQL                 |
| [`dynalitics-mssql`](https://www.npmjs.com/package/dynalitics-mssql)         | **TBD:** connects to SQL Server through `mssql`; published once the SQL Server CI job is green     | your database is SQL Server            |
| [`dynalitics-consent`](https://www.npmjs.com/package/dynalitics-consent)     | optional consent banner with your message; `consentFromRequest(req)` gives `track()` its `consent` | you want dynalitics to ask for consent |
| [`dynalitics-dashboard`](https://www.npmjs.com/package/dynalitics-dashboard) | the browser dashboard (HTML page or React components); talks to the read API                       | you want charts, a table, an explorer  |

```sh
npm install dynalitics dynalitics-postgres     # Node 22+, ESM only
```

Only the driver of the adapter you install ends up in `node_modules`. `dynalitics sql` and `dynalitics/schema` work without any adapter.

## How the pieces fit

```
your web process                         your admin process (can be the same one)
  createDynalitics({ writer })             createDynalitics({ reader })
        |  track() -> queue -> INSERT             |  createHandler() -> GET /api/* -> SELECT
        v                                         v
  +---------------------- your table in your database ----------------------+
                                                  ^
                                   dynalitics-dashboard (browser) calls /api/*
```

The recommended setup uses **two database users**: a writer that can only `INSERT` and a reader that can only `SELECT`. A compromised web process then cannot read back the personal data it wrote.

## Step 1: create the table (`dynalitics sql`)

dynalitics never creates, alters or drops anything at runtime. The CLI **prints** SQL for you to review and run. It never connects.

```sh
npx dynalitics sql --dialect postgres --table public.dynalitics_events \
  --grants --writer dyn_writer --reader dyn_reader --out dynalitics.sql
```

| Flag                                | Meaning                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `--dialect postgres\|mysql\|mssql`  | required                                                                          |
| `--table <name>`                    | `name`, `schema.name` or `db.schema.name`                                         |
| `--config <file.json>`              | table shape as JSON: `columns`, `customFields`, `page`, `firstVisit` (no secrets) |
| `--no-indexes`                      | skip the recommended indexes                                                      |
| `--grants` / `--grants-only`        | append the least-privilege GRANTs / print only them (works for any table)         |
| `--writer <role>` `--reader <role>` | replace the `<writer_role>` / `<reader_role>` placeholders                        |
| `--out <file>` `--force`            | write to a file; refuses to overwrite without `--force`                           |

The same output is available in code from `dynalitics/schema`: `generateSql({ dialect, schema, indexes, grants })` and `generateGrants({ dialect, table, writerRole, readerRole })`.

The recommended table has these columns. Rename any with `columns`, and drop optional ones with `columns.<role> = false`:

| Role           | Column           | Notes                                               |
| -------------- | ---------------- | --------------------------------------------------- |
| `id`           | `id`             | generated by the database; used for paging          |
| `timestamp`    | `visited_at`     | set at `track()` time, UTC                          |
| `consent`      | `consent`        | boolean                                             |
| `pageVisited`  | `page_visited`   | up to `page.maxLength` (512)                        |
| `ip`           | `ip_address`     | **personal**; how it is stored depends on `ip.mode` |
| `userId`       | `user_id`        | **personal**                                        |
| `username`     | `username`       | **personal**                                        |
| `email`        | `email`          | **personal**                                        |
| `custom`       | `custom`         | JSON for your declared custom fields                |
| `isFirstVisit` | `is_first_visit` | only with `firstVisit.enabled`                      |

## Step 2: track visits

```ts
import { createDynalitics } from 'dynalitics';
import { postgres } from 'dynalitics-postgres';

const dyn = await createDynalitics({
  adapter: postgres,
  connection: { writer: { connectionString: process.env.ANALYTICS_WRITER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! },
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
  onError: (e) => logger.warn(e), // already redacted: never contains connection details
});

// In a request handler. Fire and forget: it never throws and never waits for the database.
void dyn.track({
  pageVisited: req.originalUrl, // query string and fragment are stripped unless page.keepQuery
  consent: req.cookies.analytics === 'yes', // YOU decide; anything but `true` counts as denied
  ip: req.ip, // you pass the trusted address; dynalitics never reads X-Forwarded-For
  userId: session?.userId,
  username: session?.name,
  email: session?.email,
  custom: { plan: 'pro' },
});

await dyn.close(); // on shutdown: flushes the queue (5 s by default), then closes the pool
```

`createDynalitics` is async: it connects, then checks that your table matches the configuration. If it does not, it throws a `DynaliticsSchemaError` whose message contains the SQL that would fix it, for you to run (it is never executed). It can also throw `DynaliticsConfigError` (lists every problem at once) and `DynaliticsConnectionError`. No error ever contains a connection string or password.

### The instance

| Member                  | What it does                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `track(visit)`          | queues one visit. Resolves `{ status: 'queued' }`, `{ status: 'dropped', reason }` or `{ status: 'rejected', issues }`. Never rejects. |
| `flush({ timeoutMs? })` | waits until everything queued so far is written or has failed. Call it before a serverless function returns.                           |
| `close({ timeoutMs? })` | stops accepting visits, flushes, closes the pools dynalitics created. Idempotent.                                                      |
| `stats()`               | counters: `queued`, `written`, `droppedFull`, `rejected`, `failed`, `queueLength`, `lruSize`, `lastErrorAt`                            |
| `capabilities`          | `{ canWrite, canRead }`: which credentials are configured                                                                              |
| `model`, `table`        | the resolved column model and table, for diagnostics                                                                                   |

### What is stored (consent)

| `consent` you pass                 | Stored                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `true`                             | page, time, and the IP, user id, username, email and custom fields you passed |
| `false`, or missing and no default | page, time and `consent = false` only                                         |
| anything else (`'yes'`, `1`)       | never coerced: stored like `false` and reported as `invalid_visit`            |

A custom field survives a denial only with `personal: false` **and** `keepWhenDenied: true`. A synchronous default is possible with `consent: { default: (visit) => boolean }`. To have dynalitics ask the visitor, use [`dynalitics-consent`](https://www.npmjs.com/package/dynalitics-consent) and pass `consent: consentFromRequest(req)`. The full matrix is in [`SECURITY.md`](https://github.com/lucsoftsl/dynalitics/blob/main/SECURITY.md).

### Configuration reference

| Option                                                 | Default                      | Meaning                                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adapter`                                              | **required**                 | `postgres`, `mysql` or `mssql` from the adapter package                                                                                                                              |
| `connection`                                           | **required**                 | `{ writer, reader }` (recommended), one of them, or a single credential. A credential is `{ connectionString }` or `{ pool }` (your own pool; dynalitics never closes it)            |
| `acknowledgeSingleCredential`                          | `false`                      | silences the startup warning when one credential does both jobs                                                                                                                      |
| `table`                                                | **required**                 | `'events'`, `'schema.events'` or `{ schema, name }`                                                                                                                                  |
| `tableMode`                                            | `'recommended'`              | `'existing'` maps your own table through an explicit `columns` mapping (partly built: [`docs/SPEC.md`](https://github.com/lucsoftsl/dynalitics/blob/main/docs/SPEC.md) section 17.5) |
| `columns`                                              | standard names               | role → column name, or `false` to not store that role                                                                                                                                |
| `customFields`                                         | none                         | `{ name: { type, maxLength?, personal?, breakdown?, keepWhenDenied?, column? } }`, see below                                                                                         |
| `page.keepQuery` / `page.maxLength`                    | `false` / `512`              | keep the query string; maximum stored length (up to 700)                                                                                                                             |
| `page.normalize`                                       | none                         | `(path) => string`, e.g. turn `/users/42` into `/users/:id`                                                                                                                          |
| `ip.mode`                                              | `'truncate'`                 | `'truncate'` (keep the network part), `'hash'` (needs `ip.salt`, at least 16 characters), `'raw'`                                                                                    |
| `ip.ipv4Prefix` / `ip.ipv6Prefix`                      | `24` / `48`                  | bits kept by `truncate`                                                                                                                                                              |
| `consent.default`                                      | none                         | synchronous `(visit) => boolean`, used when `consent` is missing                                                                                                                     |
| `firstVisit.enabled` / `firstVisit.cacheSize`          | `false` / `50000`            | write-time "first visit" detection (the writer then needs a column-level SELECT)                                                                                                     |
| `queue.maxSize` / `queue.batchSize`                    | `10000` / `200`              | bounded in-memory queue, and rows per `INSERT`                                                                                                                                       |
| `queue.flushIntervalMs`                                | `1000`                       | how often a partial batch is written                                                                                                                                                 |
| `queue.backpressure` / `queue.maxBlockMs`              | `'drop'` / `2000`            | when the queue is full: drop the visit, or `'block'` the caller for up to `maxBlockMs`                                                                                               |
| `queue.retry`                                          | 3 tries, 200 to 5000 ms      | retry with backoff for transient database errors                                                                                                                                     |
| `limits.customMaxKeys` / `customMaxBytes` / `oversize` | `20` / `4096` / `'truncate'` | caps on custom data; `'reject'` refuses oversize visits instead                                                                                                                      |
| `poolSize`                                             | writer `4`, reader `2`       | per credential, 1 to 20; ignored for your own pools                                                                                                                                  |
| `connectTimeoutMs`                                     | `10000`                      |                                                                                                                                                                                      |
| `validateOnStart`                                      | `'strict'`                   | `'skip'` skips the table check (logged loudly; not allowed with `tableMode: 'existing'`)                                                                                             |
| `onError` / `logger`                                   | none / `console`             | error reports (redacted) and log output                                                                                                                                              |

**Custom fields.** `type` is `'string' | 'integer' | 'number' | 'boolean'`. `personal` defaults to **true** (fails closed): such a field is masked in the dashboard, dropped on denied rows and never searchable, unless you declare `personal: false`. `breakdown: true` (needs `personal: false`) lets the dashboard group by the field. `column: true` (or a column name) stores the field in its own column instead of the JSON column.

## Step 3: serve the read API (`dynalitics/handler`)

The dashboard never talks to your database. It calls a small, fixed read API that you mount in your app. The API needs a **reader** credential, so it uses its own instance (or one instance that has both credentials).

```ts
import { createDynalitics } from 'dynalitics';
import { createHandler, toNodeListener } from 'dynalitics/handler';
import { dashboardHtml } from 'dynalitics-dashboard/html';
import { postgres } from 'dynalitics-postgres';

const reader = await createDynalitics({
  adapter: postgres,
  connection: { reader: { connectionString: process.env.ANALYTICS_READER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! }, // repeat the writer's table shape
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
});

const handler = createHandler(reader, {
  authorize: (req) => isAdmin(req.raw), // REQUIRED. Return true, or { allowed: true, revealPii? }
  basePath: '/admin/analytics',
  dashboardHtml, // optional: also serve the HTML dashboard at GET /admin/analytics/
  scope: 'none', // or { column, value } when several sites share the table
});

app.use('/admin/analytics', toNodeListener(handler)); // Express, plain node:http
// For Next.js route handlers, Hono, Bun or Deno: toFetchHandler(handler) gives (Request) => Promise<Response>.
```

| Option                          | Default                                         | Meaning                                                                                                                                  |
| ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `authorize(req)`                | **required**                                    | runs first on every request. Only `true` or `{ allowed: true }` lets a request through; anything else is `403`                           |
| `basePath`                      | `'/'`                                           | where the handler is mounted                                                                                                             |
| `dashboardHtml`                 | none                                            | the string from `dynalitics-dashboard/html`; served with a per-request CSP nonce                                                         |
| `scope`                         | logs a warning                                  | `{ column, value }` adds `AND column = value` to every read; `'none'` means reading the whole table is intended                          |
| `pii.reveal` / `pii.maskUserId` | `false` / `true`                                | personal values are masked unless `pii.reveal` is set, `authorize` returned `revealPii: true` **and** the request asks for `?pii=reveal` |
| `limits`                        | 92 days, 800 buckets, 100 rows, 10 s, 4 queries | `maxRangeDays`, `maxBuckets`, `topPagesMax`, `recentMax`, `timeoutMs` (per query, cancelled in the database), `concurrency`              |
| `newVsReturning`                | enabled, 31 days                                | `enabled`, `source: 'computed' \| 'column'`, `ipIdentity: 'auto' \| 'always' \| 'never'`, `maxRangeDays`                                 |
| `explorer`                      | enabled, 31 days                                | `enabled`, `maxRangeDays` for the search routes below                                                                                    |
| `authorizeTimeoutMs`            | `5000`                                          | an `authorize` that takes longer fails closed with `500`                                                                                 |
| `cacheTtlMs`                    | `0`                                             | short micro-cache for identical requests                                                                                                 |
| `onError`                       | none                                            | read-side error reports (route, status, code; never the request)                                                                         |

### Routes (all `GET`, under `basePath`)

| Route                   | Returns                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `/`                     | the dashboard page (only if `dashboardHtml` was given)                           |
| `/api/meta`             | what this setup supports: widgets, fields, limits, explorer fields               |
| `/api/visits-over-time` | visits per bucket, with an optional `breakdown` by a `breakdown: true` field     |
| `/api/top-pages`        | most visited pages                                                               |
| `/api/new-vs-returning` | new, returning and unknown visitors per bucket (an estimate when IP is involved) |
| `/api/consent-rate`     | granted vs declined per bucket                                                   |
| `/api/recent-visits`    | newest visits, masked, with cursor paging                                        |
| `/api/search`           | explorer: visits matching `q`, plus the match count                              |
| `/api/search/histogram` | explorer: matches per bucket, with an optional `split` by a facet field          |
| `/api/search/fields`    | explorer: the top values per field among the matches                             |

Unknown or repeated parameters are `400` before any SQL runs; a request can never pass SQL, a column name or a sort order. Every response uses the same JSON envelope: `{ success, data, unavailable, error, meta }`. The exact shapes are in `dynalitics/protocol` (types only) and [`docs/SPEC.md`](https://github.com/lucsoftsl/dynalitics/blob/main/docs/SPEC.md) sections 10 and 18.

### The explorer's query language (`q`)

```
pricing                 any searchable field contains "pricing" (case-insensitive)
"two words"             the exact phrase
page:/blog*             starts with /blog   (also *end and *contains*)
plan:pro                equals pro, case-insensitive; inside quotes * is literal: plan:"a*b"
-consent:false          leave these out; works on any part, rows without the field are kept
amount:>=10             numbers: > >= < <=
plan:*                  has a value
```

Parts are combined with AND. The searchable fields are `page`, `consent`, `isFirstVisit` (only with the write-time column) and custom fields declared `personal: false`. **Personal data is never searchable:** `email:x` gets the same "unknown field" answer as a typo, so a search cannot be used to find out whether an address exists. Limits: 512 characters, 12 parts, 128 characters per value. A bad query is `400 invalid_query` with a fixed message, a `reason` and the character `position`.

Case-insensitive matching uses the database's `LOWER()`: exact for ASCII, while other scripts depend on your collation (untested beyond Latin-1 accents). A search reads every row in the chosen range, which is why the explorer's range is capped at 31 days by default.

## Entry points

| Import                | Contents                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| `dynalitics`          | `createDynalitics`, error classes, types                                    |
| `dynalitics/handler`  | `createHandler`, `toNodeListener`, `toFetchHandler`                         |
| `dynalitics/schema`   | `generateSql`, `generateGrants`, `buildColumnModel` (no driver, no network) |
| `dynalitics/protocol` | wire types of the read API (types only)                                     |
| `dynalitics/adapter`  | the contract for adapter packages (see below)                               |
| `npx dynalitics sql`  | the SQL generator CLI                                                       |

## Writing your own adapter

An adapter is a frozen object `{ apiVersion: 1, dialect, packageName, createDriver(options) }`. `createDriver` receives `{ credential, max, connectTimeoutMs, redact, requestTimeoutMs? }` and returns a `Driver` with `query(compiled, { timeoutMs })`, `isTransient(err)` and `close()`. The SQL text always comes from dynalitics; an adapter only runs it. Build every error with `toDriverError` from `dynalitics/adapter`, so that values a database echoes in its error messages never leak, and never close a pool the host passed in. `dialect` must be one of the three supported dialects. The three official adapters are about 150 lines each and are the best reference ([source](https://github.com/lucsoftsl/dynalitics/tree/main/packages)).

## Know this before you rely on it

- **Delivery is in memory and at least once.** A crash loses queued visits; a retried batch can write a duplicate row.
- **Retention and deletion are your job.** There is no delete path.
- **Truncated and hashed IPs are still personal data.** So can page paths be (`/reset/<token>`); use `page.normalize`.
- **New vs returning is an estimate** whenever IP is part of the identity.
- **With your own pool**, query cancellation is best effort: set `statement_timeout` / `max_execution_time` on the reader role.
- `track()` does no rate limiting; protect public endpoints that call it.
- Not built: `extraColumns`, `dynalitics inspect`. Not supported: MariaDB, SQLite, Oracle.

More: the [repository README](https://github.com/lucsoftsl/dynalitics#readme) (guided tour), [`SECURITY.md`](https://github.com/lucsoftsl/dynalitics/blob/main/SECURITY.md) (what is guaranteed and which test backs it) and [`docs/SPEC.md`](https://github.com/lucsoftsl/dynalitics/blob/main/docs/SPEC.md) (the full contract).

MIT licensed.

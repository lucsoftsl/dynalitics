# dynalitics

Analytics that log into **your own SQL database** (PostgreSQL, MySQL, SQL Server). No third-party service, no tracking script, no cookies set by this library. You call `track()` from your server, dynalitics writes one row per visit to a table you own.

> **Status: pre-release (`0.0.0`, not yet on npm).** `track()` (consent gate, IP modes, background queue), startup validation of your table, the `dynalitics sql` command, the read endpoint (`dynalitics/handler`) and the dashboard have all run against real PostgreSQL and MySQL in local integration tests. The GitHub Actions workflows in this repository have **never run on GitHub**, and nothing has been published, so the supply-chain and provenance claims below describe a design that is not yet proven. **Not built yet:** `tableMode: 'existing'`, `extraColumns`, and `dynalitics inspect`. The design lives in [`docs/SPEC.md`](docs/SPEC.md) and [`docs/DESIGN.md`](docs/DESIGN.md).
>
> **SQL Server has never run on a real server; unverified until the `integration (mssql)` CI job is green.**

## What you get

- **Privacy fails closed.** No consent means only the page and the timestamp are stored. Missing consent information counts as "no consent". What exactly is stored in each case is in [`SECURITY.md`](SECURITY.md).
- **No DDL by construction.** dynalitics has no code path that creates, alters or drops anything. If your table is wrong it throws at startup and prints the exact SQL for you to review and run.
- **Least privilege.** The recommended setup uses two database users: a writer that can only `INSERT`, and a reader that can only `SELECT`.
- **Never hurts your app.** `track()` never throws and never waits for the database. Failures go to your `onError` callback.
- **Zero runtime dependencies.** Database drivers (`pg`, `mysql2`, `mssql`) are optional peer dependencies that you install.
- **A dashboard you can read.** A single self-contained HTML page: strict CSP with nonced inline code, no external requests (a build test checks the page for external URLs), light and dark themes, a table alternative for every chart, keyboard operable (tested in jsdom; there is no screen-reader or automated accessibility audit yet). Served by the read endpoint, or use the React components.

## Install

Node 22 or newer, ESM. Install the package and the driver for your database:

```sh
npm install dynalitics pg        # PostgreSQL
npm install dynalitics mysql2    # MySQL
npm install dynalitics mssql     # SQL Server
```

> SQL Server has never run on a real server; unverified until the `integration (mssql)` CI job is green.

## 1. Create the table

dynalitics prints the SQL and never connects while doing it:

```sh
npx dynalitics sql --dialect postgres --table public.dynalitics_events --grants \
  --writer dyn_writer --reader dyn_reader --out dynalitics.sql
```

Review the file, then run it with an account that is allowed to do DDL. The PostgreSQL output looks like this (abridged):

```sql
CREATE TABLE "public"."dynalitics_events" (
  "id"           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "visited_at"   timestamptz NOT NULL,
  "consent"      boolean NOT NULL,
  "page_visited" varchar(512) NOT NULL,
  "ip_address"   varchar(64),   -- PERSONAL DATA
  "user_id"      varchar(128),  -- PERSONAL DATA
  "username"     varchar(128),  -- PERSONAL DATA
  "email"        varchar(320),  -- PERSONAL DATA
  "custom"       jsonb
);
-- plus recommended indexes
GRANT INSERT ON "public"."dynalitics_events" TO "dyn_writer";
GRANT SELECT ON "public"."dynalitics_events" TO "dyn_reader";
```

Options: `--no-indexes`, `--grants-only` (only the GRANTs, works for any table), `--config table-shape.json` (column names, custom fields; JSON only, no secrets), `--out <file>` (refuses to overwrite without `--force`). Run `npx dynalitics sql --help` for the full list. `dynalitics sql` also works without installing a driver.

## 2. Use two database users

Create two database users yourself (dynalitics does not create users) and use the generated `GRANT` statements:

| User   | Used by                                                 | Privilege on the table |
| ------ | ------------------------------------------------------- | ---------------------- |
| writer | your web process, `track()`                             | `INSERT` only          |
| reader | the read endpoint (`dynalitics/handler`), the dashboard | `SELECT` only          |

A compromised web process then cannot read back the personal data it just wrote. A single credential still works for prototypes; dynalitics logs a warning once at startup unless you set `acknowledgeSingleCredential: true`. Put credentials in environment variables or a secret manager, never in source control.

For non-local databases use TLS (`sslmode=require` for PostgreSQL, `encrypt=true` for SQL Server, `ssl` options for MySQL).

## 3. Track visits

This process only writes, so it holds only the writer credential. The dashboard (section 4) needs a reader credential and therefore a second instance.

```ts
import { createDynalitics } from 'dynalitics';

const dyn = await createDynalitics({
  dialect: 'postgres',
  connection: { writer: { connectionString: process.env.ANALYTICS_WRITER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! },
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
  onError: (e) => logger.warn(e), // already redacted, never contains connection details
});

// In a route handler. Fire and forget: it never throws and never waits for the database.
void dyn.track({
  pageVisited: '/pricing?utm_source=x', // query string and fragment are stripped by default
  consent: req.cookies.analytics === 'yes', // you decide how consent is collected
  ip: req.ip, // you pass the trusted address; dynalitics never reads X-Forwarded-For
  userId: session?.userId,
  username: session?.name,
  email: session?.email,
  custom: { plan: 'pro' },
});

// On shutdown, and at the end of a serverless invocation:
await dyn.close(); // flushes the queue, then closes the pool. Use `await dyn.flush()` to flush only.
```

`createDynalitics` is async because it connects and checks the table. It throws `DynaliticsConfigError`, `DynaliticsConnectionError` or `DynaliticsSchemaError`; none of them contain connection strings or passwords. `track()` resolves to `{ status: 'queued' }`, `{ status: 'dropped', reason }` or `{ status: 'rejected', issues }`. `dyn.stats()` returns counters.

### Consent

| `consent`                            | What is stored                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `true`                               | page, timestamp, and the IP, user id, username, email and custom fields you passed     |
| `false`, or not given and no default | page, timestamp and `consent = false` only; IP, user id, username and email are `NULL` |
| a non-boolean value (`'yes'`, `1`)   | never coerced: stored like `false` and reported as `invalid_visit`; it is not rejected |

Custom data does not survive a denial unless you declare the field with `personal: false` **and** `keepWhenDenied: true`. The full table, including the default resolver cases, is in [`SECURITY.md`](SECURITY.md). You can set a synchronous default with `consent: { default: (visit) => boolean }`.

### IP modes

| `ip.mode`            | Stored                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `truncate` (default) | the network part only (prefix lengths are configurable with `ip.ipv4Prefix` and `ip.ipv6Prefix`) |
| `hash`               | a salted hash; needs `ip.salt` (long, secret)                                                    |
| `raw`                | the full address                                                                                 |

**Truncated and hashed addresses are still personal data** under GDPR and similar laws; do not call them anonymous. Rows with consent denied carry the least data (page path and timestamp), but even the page path can identify someone (`/users/42`, `/reset/<token>`). Query strings and fragments are stripped by default; use `page.normalize` to rewrite paths that embed identifiers.

### Queue and delivery

Events go into a bounded in-memory queue and are written in batches with retry and backoff (the `queue` options of `DynaliticsConfig` set the size, batching and backpressure; `queue.backpressure: 'block'` waits instead of dropping). **If the process crashes, queued events are lost, and a retried batch can write duplicate rows.** That is the price of never slowing your app down; call `flush()` before a serverless function returns.

## 4. The dashboard

`dynalitics-dashboard` is a single self-contained HTML page: inline CSS, JS and SVG charts, no fonts, no CDN, no external requests, no inline event handlers, works under `default-src 'none'`. It shows visits over time (optionally split by a field you declared with `breakdown: true`), top pages, new vs returning, consent rate and recent visits, with a date range picker, light and dark themes, a table alternative for every chart, and UTC labels throughout. Widgets and table columns that your configuration cannot support are hidden or shown as "not available" instead of failing.

You serve it with the read endpoint (`dynalitics/handler`). The endpoint needs a **reader** credential, so it uses its own instance; `createHandler` throws on an instance that only has a writer:

```ts
import { createDynalitics } from 'dynalitics';
import { createHandler, toNodeListener } from 'dynalitics/handler';
import { dashboardHtml } from 'dynalitics-dashboard/html';

// A second instance with a READER credential. Repeat the table, customFields and ip.mode of the writer.
const reader = await createDynalitics({
  dialect: 'postgres',
  connection: { reader: { connectionString: process.env.ANALYTICS_READER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! },
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
});

const handler = createHandler(reader, {
  authorize: (req) => isAdmin(req.raw), // REQUIRED: without it createHandler throws and nothing is served
  basePath: '/admin/analytics',
  dashboardHtml,
  scope: 'none', // see the bullet on `scope` below
});
app.use('/admin/analytics', toNodeListener(handler));
```

One instance with both a writer and a reader also works if a single process does both. More examples (Express, Next.js, **not compiled in CI**) are in [`docs/read-api-examples.md`](docs/read-api-examples.md); the full contract is [`docs/SPEC.md`](docs/SPEC.md) section 10.

- `authorize` runs first on every request. IP, email and username are masked unless you opt in on several levels; a request cannot pass SQL, columns or filters.
- **`scope`:** if several sites or tenants share the table, pass `scope: { column, value }` so every read is restricted to yours. `scope: 'none'` says that reading the whole table is intended; leaving it out logs a warning.
- **The served page authenticates with ambient credentials only** (your session cookie, same origin). It cannot attach an `Authorization: Bearer` header. For that case use the React components (`dynalitics-dashboard/react`), which accept `getRequestInit`; see [`docs/REACT.md`](docs/REACT.md).
- If the page sits behind single sign-on and your sign-in expires, the browser reports a redirect or a network error; the page tells you to reload.
- Time is shown in UTC. New vs returning is computed over a capped window (`newVsReturning.maxRangeDays` in the handler options), and the page says so when you pick a longer range.

## Read this before you rely on it

The guarantees, and the things dynalitics does **not** guarantee, are in [`SECURITY.md`](SECURITY.md). The ones that matter most when you first set it up:

- **SQL Server is unverified** (see the banner above).
- **Delivery is at-least-once and in memory**: a crash loses queued events and a retried batch can duplicate rows.
- **Retention, deletion and erasure are your job.** dynalitics has no delete path. An analytics table with email addresses and no deletion process is a compliance problem; plan one before you store personal data.
- **Lawful basis and consent collection are yours too.** dynalitics only honours the boolean you give it.
- **New vs returning visitors is an estimate** whenever IP is part of the identity (shared addresses merge people; salted hashes reset when you rotate the salt).
- **Timeouts with your own pools:** if you pass your own database pool instead of a connection string, query cancellation is best effort. Set server-side statement timeouts as well.
- `track()` does no rate limiting. If you call it from a public endpoint, rate-limit that endpoint yourself.
- Not supported yet: tables you already have (`tableMode: 'existing'`), `extraColumns`, `dynalitics inspect`, MariaDB, SQLite, views.

## Development

```sh
npm ci
npm run build        # tsc + the single-file dashboard + the React bundle
npm run lint && npm run typecheck && npm test
npm run format:check
```

Integration tests against real databases need Docker (`docker/compose.yml`, test-only throw-away credentials) and `DYNALITICS_INTEGRATION=1`. Releasing is described in [`docs/RELEASING.md`](docs/RELEASING.md). Security issues: see [`SECURITY.md`](SECURITY.md).

The dashboard also has an end-to-end run against the real read handler and the Docker databases: `DYNALITICS_INTEGRATION=1 PLAYWRIGHT_CORE=/path/to/playwright-core npm run e2e -w dynalitics-dashboard` (it skips itself unless `DYNALITICS_INTEGRATION=1`; Playwright is not a dependency of this repository).

## License

MIT, see [`LICENSE`](LICENSE).

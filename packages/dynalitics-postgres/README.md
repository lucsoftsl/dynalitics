# dynalitics-postgres

The **PostgreSQL adapter** for [dynalitics](https://www.npmjs.com/package/dynalitics). `dynalitics` itself never loads a database driver; this package is the piece that connects it to PostgreSQL through [`pg`](https://node-postgres.com). It depends on `pg` (pinned to `8.23.1`) and nothing else, so installing it brings in exactly one driver.

```sh
npm install dynalitics dynalitics-postgres     # Node 22+, ESM only
```

## Usage

Pass the exported `postgres` adapter as `adapter` when you create an instance. Everything else (table, consent, IP mode, the read API) is configured on `dynalitics`; see its README.

```ts
import { createDynalitics } from 'dynalitics';
import { postgres } from 'dynalitics-postgres';

const dyn = await createDynalitics({
  adapter: postgres,
  connection: {
    writer: { connectionString: process.env.ANALYTICS_WRITER_URL! }, // INSERT only
    reader: { connectionString: process.env.ANALYTICS_READER_URL! }, // SELECT only
  },
  table: 'public.dynalitics_events',
});
```

Create the table first with `npx dynalitics sql --dialect postgres --table public.dynalitics_events --grants` (prints SQL, never connects).

## What the adapter does

**Connection strings.** For each credential it creates a `pg.Pool` with:

| Setting                   | Value                                           |
| ------------------------- | ----------------------------------------------- |
| `max`                     | `poolSize` (writer 4, reader 2 by default)      |
| `connectionTimeoutMillis` | `connectTimeoutMs` (10 s by default)            |
| `idleTimeoutMillis`       | 30 s                                            |
| `statement_timeout`       | 30 s, a server-side ceiling for every statement |

TLS, host, port and database come from the connection string itself. Use `sslmode=require` for anything that is not on localhost. An idle connection that dies (server restart, network blip) never crashes your process: the pool's `error` event is handled.

**Your own pool.** Pass `{ pool: yourPgPool }` instead of a connection string. dynalitics never closes it on `close()`.

**Deadlines.** Every read runs on its own pooled client. When the read handler's deadline passes (`limits.timeoutMs`, 10 s by default), the adapter sends `SELECT pg_cancel_backend(pid)` (allowed for your own role, waits at most 2 s) and destroys that connection, so a slow query cannot keep running unseen. A pool without `connect()` only gets a client-side `query_timeout`; in that case set `statement_timeout` on the reader role yourself.

**Errors.** The adapter never passes a raw `pg` error on. Data and constraint errors (SQLSTATE classes 22 and 23) forward no message text at all, because PostgreSQL prints the offending value. Permission errors (`42501`) become a fixed sentence. Connection, authentication and timeout errors keep their message, redacted and with quoted values removed. Connection drops, `57P0x` shutdowns, serialization failures and deadlocks (`40001`, `40P01`) and "too many connections" are marked transient, so the writer retries them.

## Versions

`dynalitics-postgres` and `dynalitics` are released together with the same version number, and the adapter declares `dynalitics` as a peer dependency at exactly that version. If the two ever disagree on the adapter contract, `createDynalitics` refuses to start and names both versions.

Tested against PostgreSQL 17 (integration tests, local Docker).

MIT licensed.

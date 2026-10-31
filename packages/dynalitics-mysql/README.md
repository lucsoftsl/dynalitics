# dynalitics-mysql

The **MySQL adapter** for [dynalitics](https://www.npmjs.com/package/dynalitics). `dynalitics` itself never loads a database driver; this package is the piece that connects it to MySQL through [`mysql2`](https://sidorares.github.io/node-mysql2/docs). It depends on `mysql2` (pinned to `3.24.6`) and nothing else, so installing it brings in exactly one driver.

```sh
npm install dynalitics dynalitics-mysql     # Node 22+, ESM only
```

## Usage

Pass the exported `mysql` adapter as `adapter` when you create an instance. Everything else (table, consent, IP mode, the read API) is configured on `dynalitics`; see its README.

```ts
import { createDynalitics } from 'dynalitics';
import { mysql } from 'dynalitics-mysql';

const dyn = await createDynalitics({
  adapter: mysql,
  connection: {
    writer: { connectionString: process.env.ANALYTICS_WRITER_URL! }, // mysql://user:pass@host/db, INSERT only
    reader: { connectionString: process.env.ANALYTICS_READER_URL! }, // SELECT only
  },
  table: 'analytics.dynalitics_events', // on MySQL the "schema" part is the database
});
```

Create the table first with `npx dynalitics sql --dialect mysql --table analytics.dynalitics_events --grants` (prints SQL, never connects).

## What the adapter does

**Connection strings.** For each credential it creates a `mysql2/promise` pool with:

| Setting                 | Value                                      | Why                                                                     |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| `connectionLimit`       | `poolSize` (writer 4, reader 2 by default) |                                                                         |
| `connectTimeout`        | `connectTimeoutMs` (10 s by default)       |                                                                         |
| `timezone`              | `'Z'`                                      | timestamps are written and read as UTC                                  |
| `dateStrings`           | `true`                                     | no time-zone conversion on the way back                                 |
| `multipleStatements`    | `false`                                    | one statement per call, always                                          |
| `maxPreparedStatements` | 64                                         | prepared statements are counted server-wide (`max_prepared_stmt_count`) |

Every statement that carries values runs as a real prepared statement (`execute`), so values are bound by the server; only the parameterless `SHOW` statements of the startup check use a plain query. Booleans are sent as `1`/`0`. Use the `ssl` options of your connection string for anything that is not on localhost.

**Your own pool.** Pass `{ pool: yourPool }` instead of a connection string. It must be a **promise** pool (`mysql2/promise`). dynalitics never closes it on `close()`.

**Deadlines.** Each `SELECT` carries a `MAX_EXECUTION_TIME` hint, so MySQL stops a slow read by itself when the read handler's deadline passes (`limits.timeoutMs`, 10 s by default). As a backstop, the adapter destroys the connection 500 ms later if the server has not answered. A pool without `getConnection()` only gets a client-side timeout; in that case set `max_execution_time` on the reader account yourself.

**Errors.** The adapter never passes a raw `mysql2` error on. Data and constraint errors (duplicate key, truncation, bad value, NULL in a NOT NULL column and similar) forward no message text at all, because MySQL prints the offending value. Table and column permission errors become a fixed sentence. Connection, authentication and timeout errors keep their message, redacted and with quoted values removed. Lost connections, deadlocks, lock wait timeouts and "too many connections" are marked transient, so the writer retries them.

## Versions

`dynalitics-mysql` and `dynalitics` are released together with the same version number, and the adapter declares `dynalitics` as a peer dependency at exactly that version. If the two ever disagree on the adapter contract, `createDynalitics` refuses to start and names both versions.

Tested against MySQL 8.4 (integration tests, local Docker). The explorer's number filters use `CAST(... AS DOUBLE)`, which needs MySQL 8.0.17 or newer (untested on older versions). MariaDB is not supported.

MIT licensed.

# dynalitics-mssql

The **SQL Server adapter** for [dynalitics](https://www.npmjs.com/package/dynalitics). `dynalitics` itself never loads a database driver; this package is the piece that connects it to SQL Server through [`mssql`](https://github.com/tediousjs/node-mssql) (which uses `tedious`). It depends on `mssql` (pinned to `12.7.13`) and nothing else; note that `mssql` itself has a sizeable dependency tree, which only users of this adapter get.

> **SQL Server has never run on a real server; unverified until the `integration (mssql)` CI job is green.** The code below is written to the same contract as the PostgreSQL and MySQL adapters and is covered by unit tests with a mocked driver, but no statement has executed on SQL Server yet. Treat it as a preview.

```sh
npm install dynalitics dynalitics-mssql     # Node 22+, ESM only
```

## Usage

Pass the exported `mssql` adapter as `adapter` when you create an instance. Everything else (table, consent, IP mode, the read API) is configured on `dynalitics`; see its README.

```ts
import { createDynalitics } from 'dynalitics';
import { mssql } from 'dynalitics-mssql';

const dyn = await createDynalitics({
  adapter: mssql,
  connection: {
    // e.g. 'Server=db,1433;Database=app;User Id=dyn_writer;Password=...;Encrypt=true'
    writer: { connectionString: process.env.ANALYTICS_WRITER_URL! }, // INSERT only
    reader: { connectionString: process.env.ANALYTICS_READER_URL! }, // SELECT only
  },
  table: 'dbo.dynalitics_events',
});
```

Create the table first with `npx dynalitics sql --dialect mssql --table dbo.dynalitics_events --grants` (prints SQL, never connects).

## What the adapter does

**Connection strings.** For each credential it parses the string with `mssql`'s own parser, creates a `ConnectionPool` and connects it, with:

| Setting                  | Value                                      |
| ------------------------ | ------------------------------------------ |
| `pool.max`               | `poolSize` (writer 4, reader 2 by default) |
| `pool.idleTimeoutMillis` | 30 s                                       |
| `connectionTimeout`      | `connectTimeoutMs` (10 s by default)       |
| `requestTimeout`         | 30 s                                       |

Every value is sent as a request parameter (`@p1`, `@p2`, ...; `mssql` infers the SQL type from the JavaScript value), never as SQL text. Use `Encrypt=true` for anything that is not on localhost.

**Your own pool.** Pass `{ pool: yourConnectionPool }` instead of a connection string. It must already be **connected**: the adapter only calls `pool.request()` on it, and dynalitics never closes it on `close()`.

**Deadlines.** When the read handler's deadline passes (`limits.timeoutMs`, 10 s by default), the adapter calls `request.cancel()`, which asks SQL Server to stop the statement, and reports a timeout.

**Errors.** The adapter never passes a raw `mssql` error on. Data and constraint errors (NULL insert, foreign key, truncation, duplicate key, conversion; error numbers 220, 245, 515, 547, 2601, 2627, 2628, 8114, 8115, 8152) forward no message text, because SQL Server prints the offending value. Permission errors (229, 230, 262, 297) become a fixed sentence. Connection, login and timeout errors keep their message, redacted and with quoted values removed. Socket errors, closed connections, timeouts and deadlocks (1205) are marked transient, so the writer retries them.

## Versions

`dynalitics-mssql` and `dynalitics` are released together with the same version number, and the adapter declares `dynalitics` as a peer dependency at exactly that version. If the two ever disagree on the adapter contract, `createDynalitics` refuses to start and names both versions.

MIT licensed.

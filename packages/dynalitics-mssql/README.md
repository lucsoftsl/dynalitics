# dynalitics-mssql

The SQL Server adapter for [dynalitics](../dynalitics/README.md). It depends on `mssql` (pinned to `12.7.13`) and nothing else, so installing it brings in exactly one database driver.

> SQL Server has never run on a real server. The `integration (mssql)` CI job has to go green before this adapter counts as working.

```sh
npm install dynalitics dynalitics-mssql
```

```ts
import { createDynalitics } from 'dynalitics';
import { mssql } from 'dynalitics-mssql';

const dyn = await createDynalitics({
  adapter: mssql,
  connection: {
    writer: { connectionString: process.env.ANALYTICS_WRITER_URL! },
    reader: { connectionString: process.env.ANALYTICS_READER_URL! },
  },
  table: 'dbo.dynalitics_events',
});
```

You can pass your own pool instead of a connection string (`{ pool }`); dynalitics never closes a pool it did not create. For timeouts, cancellation and error-message rules, see `docs/SPEC.md` section 5.2.

`dynalitics-mssql` and `dynalitics` are released together with the same version. The adapter declares `dynalitics` as a peer dependency at that exact version.

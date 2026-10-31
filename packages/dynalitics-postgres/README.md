# dynalitics-postgres

The PostgreSQL adapter for [dynalitics](../dynalitics/README.md). It depends on `pg` (pinned to `8.23.1`) and nothing else, so installing it brings in exactly one database driver.

```sh
npm install dynalitics dynalitics-postgres
```

```ts
import { createDynalitics } from 'dynalitics';
import { postgres } from 'dynalitics-postgres';

const dyn = await createDynalitics({
  adapter: postgres,
  connection: {
    writer: { connectionString: process.env.ANALYTICS_WRITER_URL! },
    reader: { connectionString: process.env.ANALYTICS_READER_URL! },
  },
  table: 'dynalitics_events',
});
```

You can pass your own pool instead of a connection string (`{ pool }`); dynalitics never closes a pool it did not create. For timeouts, cancellation and error-message rules, see `docs/SPEC.md` section 5.2.

`dynalitics-postgres` and `dynalitics` are released together with the same version. The adapter declares `dynalitics` as a peer dependency at that exact version.

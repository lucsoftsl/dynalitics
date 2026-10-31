# dynalitics

Log analytics into your own SQL database (PostgreSQL, MySQL, SQL Server). Server-side only, zero runtime dependencies, least-privilege by design.

> **Pre-release.** `track()`, the consent gate, IP modes, the queue, startup table validation, the `dynalitics sql` command and the read endpoint (`dynalitics/handler`) have run against real PostgreSQL and MySQL in local integration tests. The GitHub Actions workflows have never run and nothing is published yet. `tableMode: 'existing'`, `extraColumns` and `dynalitics inspect` are not built yet.

```sh
npm install dynalitics pg            # or mysql2 / mssql
npx dynalitics sql --dialect postgres --table public.dynalitics_events --grants --out dynalitics.sql
```

> SQL Server has never run on a real server; unverified until the `integration (mssql)` CI job is green.

```ts
import { createDynalitics } from 'dynalitics';

const dyn = await createDynalitics({
  dialect: 'postgres',
  connection: { writer: { connectionString: process.env.ANALYTICS_WRITER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! },
});

void dyn.track({ pageVisited: '/pricing', consent: true, ip: req.ip, userId: session?.userId });
await dyn.close(); // on shutdown
```

- No consent means only the page and the timestamp are stored.
- dynalitics never creates or alters tables; it prints the SQL for you to run.
- Use a writer user with `INSERT` only and a reader user with `SELECT` only. The example above is the writer process. The read endpoint and the dashboard need a **reader** credential, which means a second `createDynalitics` instance with `connection: { reader: { connectionString } }` (`createHandler` throws on a writer-only instance); see the repository README, section 4.
- Truncated or hashed IPs are still personal data. Retention and deletion are your responsibility.

Full guide, consent and IP-mode tables and limits: see the [repository README](https://github.com/OWNER/dynalitics#readme). What is and is not guaranteed: [`SECURITY.md`](https://github.com/OWNER/dynalitics/blob/main/SECURITY.md).

MIT licensed.

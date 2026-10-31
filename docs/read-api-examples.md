# Read API: framework examples

The handler is framework-agnostic: `createHandler` returns `{ basePath, handle(req) }` and two adapters
turn that into a Node listener or a Fetch-API handler. **`authorize` is required**; without it
`createHandler` throws and nothing is served. Use a **reader** credential (SELECT only).

The `dyn` in these examples is its own instance that holds **only a reader credential**. The process that calls
`track()` uses a different instance with the writer credential (repository README, section 3). Passing a writer-only
instance to `createHandler` throws; one instance with both credentials also works if a single process does both.

> **Not compiled and not run in CI.** The Express and Next.js code below has never been compiled against the real
> frameworks or run in this repository's CI (only the handler itself is tested, against real databases, through its
> Node and Fetch adapters). Treat it as a starting point and type-check it in your own project.

## Express

```ts
import express from 'express';
import { createDynalitics } from 'dynalitics';
import { createHandler, toNodeListener } from 'dynalitics/handler';
import { dashboardHtml } from 'dynalitics-dashboard/html';

const dyn = await createDynalitics({
  dialect: 'postgres',
  connection: { reader: { connectionString: process.env.ANALYTICS_READER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! }, // same mode as the writer
  customFields: { plan: { type: 'string', maxLength: 32, personal: false, breakdown: true } },
});

const handler = createHandler(dyn, {
  authorize: (req) => {
    const user = (req.raw as express.Request & { user?: { isAdmin?: boolean } }).user;
    return user?.isAdmin === true; // or { allowed: true, revealPii: true } for a super-admin
  },
  basePath: '/admin/analytics',
  dashboardHtml,
  // The table is shared by several sites: only read this site's rows. Use scope: 'none' if the whole table is yours.
  scope: { column: 'site_id', value: 'main' },
});

const app = express();
// Put your own authentication and rate limiting in front. Express strips the mount path;
// the adapter copes with both stripped and unstripped URLs.
app.use('/admin/analytics', toNodeListener(handler));
```

## Next.js (App Router)

`app/admin/analytics/[[...path]]/route.ts`

```ts
import { createDynalitics } from 'dynalitics';
import { createHandler, toFetchHandler } from 'dynalitics/handler';
import { dashboardHtml } from 'dynalitics-dashboard/html';
import { auth } from '@/auth'; // your session helper

const dyn = await createDynalitics({
  dialect: 'postgres',
  connection: { reader: { connectionString: process.env.ANALYTICS_READER_URL! } },
  table: 'public.dynalitics_events',
  ip: { mode: 'hash', salt: process.env.ANALYTICS_IP_SALT! },
});

const handler = createHandler(dyn, {
  authorize: async (req) => (await auth(req.raw as Request))?.user?.role === 'admin',
  basePath: '/admin/analytics',
  dashboardHtml,
  scope: 'none', // the whole table is this site's
});

export const GET = toFetchHandler(handler);
// Never cache an authorised response, and run on Node: pg, mysql2 and mssql do not run on the Edge runtime.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
```

Serverless note: a cold start pays two round trips to check the table. Share one `dyn` per instance (module scope, as above).

## Revealing personal data (opt-in, three conditions)

Masked by default. Email, username and IP are revealed only when **all** hold: `pii: { reveal: true }` in
`createHandler`, `authorize` returned `{ allowed: true, revealPii: true }` for this request, and the request
has `?pii=reveal`. Anything less returns masked values, never an error. `userId` is masked too (`u_***42`); set `pii: { maskUserId: false }` only if your ids are not personal.

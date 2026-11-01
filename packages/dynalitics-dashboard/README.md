# dynalitics-dashboard

The browser dashboard for [dynalitics](https://www.npmjs.com/package/dynalitics). It talks **only** to the dynalitics read API (`dynalitics/handler`) that you mount in your server; it never sees a database or a credential. It comes in two forms:

| Import                       | What it is                                                                      | Use it when                                                  |
| ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `dynalitics-dashboard/html`  | `dashboardHtml`: one self-contained HTML page as a string (inline CSS, JS, SVG) | you want a dashboard page with no frontend work              |
| `dynalitics-dashboard/react` | React 18/19 components: the whole dashboard or single widgets                   | you want it inside your own React admin, or need header auth |

> **Early release (`0.1.x`).** The HTML page is unit-tested against a typed mock of the read API and has an end-to-end run against the real handler on PostgreSQL and MySQL (`npm run e2e`, needs Docker and Playwright, not run in CI). It has not run against SQL Server, and only in Chromium. The React components are tested against the typed mock only.

```sh
npm install dynalitics-dashboard     # no runtime dependencies; react/react-dom are optional peers
```

## What it shows

**Overview** (both forms):

- **Visits over time**: total visits per hour, day or week, optionally split by a field you declared with `breakdown: true`.
- **Top pages**: the most visited pages and their share.
- **New vs returning**: new, returning and unknown visitors, with an "approximate" caveat when IP is part of the identity.
- **Consent**: granted vs declined over time.
- **Errors** (only when the server stores the HTTP status, `columns.status` in `dynalitics`): the failure rate, 4xx and 5xx over time, the failing pages and the commonest reasons. 5xx is red, 4xx amber, success stays quiet, and the code is always printed so colour is never the only signal.
- **Recent visits**: the newest rows, with personal values masked unless the server allows revealing them, and "Load more" paging. With a status column, each row shows a status badge and the error reason.

**Explorer** (HTML page only for now; not yet in the React components): a search-first view for digging into individual visits, Grafana/Splunk style.

- A **query bar** with a small query language: `pricing plan:pro -consent:false page:/blog*` (the syntax is in the page's "Syntax" panel and in the [`dynalitics` README](https://www.npmjs.com/package/dynalitics#the-explorers-query-language-q)). Matching is case-insensitive. Personal fields (IP, email, username, user id) can never be searched.
- **Matches over time**: a histogram of matching visits; click or press Enter on a day to zoom into its hours.
- **Split by** any groupable field, to stack the histogram by value. Splitting by `statusClass` uses the error colours.
- **Error filters**: `5xx`, `4xx` and `All errors` buttons when the server stores a status (they just write `statusClass:5xx` and so on into the query).
- **Fields**: the top values of each field among the matches. Click a value to filter on it, `−` to exclude it.
- **Matching visits**: the same table as Recent visits, with the match count.
- **Live**: refresh every 5, 15 or 30 seconds. New rows are marked. Polling pauses while the tab is hidden, and stops on an error.
- The query, split, range and live setting are kept in the URL, so a view can be shared as a link.

Everything else is shared: date ranges (24h, 7d, 30d, 90d; only those the server allows, and at most 31 days in the explorer by default), light and dark themes, all times in UTC, a table alternative for every chart, keyboard exploration of charts, `prefers-reduced-motion` support. Widgets that your configuration cannot support say "not available" instead of failing, and every widget handles its own loading, empty, error and timeout state.

## The HTML page

Pass the string to `createHandler`, which serves it at `GET {basePath}/`:

```ts
import { createHandler, toNodeListener } from 'dynalitics/handler';
import { dashboardHtml } from 'dynalitics-dashboard/html';

const handler = createHandler(readerInstance, {
  authorize: (req) => isAdmin(req.raw),
  basePath: '/admin/analytics',
  dashboardHtml,
  scope: 'none',
});
app.use('/admin/analytics', toNodeListener(handler)); // open /admin/analytics/ in a browser
```

On every request the handler fills two placeholders and sends the page with a strict Content Security Policy:

| Placeholder            | Replaced with                                                     |
| ---------------------- | ----------------------------------------------------------------- |
| `%%DYNALITICS_NONCE%%` | a fresh random nonce (also used in the `Content-Security-Policy`) |
| `%%DYNALITICS_BASE%%`  | the mount path of the read API, e.g. `/admin/analytics`           |

At the root mount the base is the **empty string**, never `/` (a `/` would make the page request `//api/meta`, which is a different host). The page builds `{base}/api/*` and only ever calls its own origin.

**Authentication.** The page calls the API with `credentials: 'same-origin'`, so it works with **ambient credentials only**, typically your session cookie. It cannot send an `Authorization: Bearer` header; use the React components for that. A redirect to a login page or single sign-on is reported as "unexpected reply", and a network failure on the first request adds a hint that the sign-in may have expired.

## The React components

```tsx
import { DynaliticsDashboard } from 'dynalitics-dashboard/react';
import 'dynalitics-dashboard/react/styles.css';

<DynaliticsDashboard endpoint="/admin/analytics" />;
```

`endpoint` is the mount path of the read API. The stylesheet is scoped to the component and needs no CSS-in-JS library. The React form renders the same DOM as the HTML page (a parity test compares them panel by panel), so it looks identical. It also offers:

- **Header authorisation**: `getRequestInit` lets you add an `Authorization` header (or anything else) to every request.
- **Single widgets** to place in your own layout.
- **Theming**, server-side rendering and Next.js notes.

All of these are described in [`docs/REACT.md`](https://github.com/lucsoftsl/dynalitics/blob/main/docs/REACT.md).

## Security properties

- Every string that comes from the API (page URLs, usernames, emails, user ids, IPs, field values) is rendered as text. The source contains no `innerHTML`, `eval` or `new Function`, and a build test fails if one appears.
- The HTML page works under `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; connect-src 'self'`: no inline event handlers, no inline `style` attributes, no external fonts, scripts or images (a build test checks the page for external URLs).
- Personal values arrive masked from the server. The page only offers a reveal button if the server says it is allowed, never stores the revealed state, and hides revealed values when printing.
- In the explorer, the query is sent to the server as text and parsed there; the page never builds SQL or filters data itself.

## Size

The HTML page is about 81 KB raw (about 27 KB gzipped). A build test (`test/build.test.ts`) enforces a hard limit of 45 KB **gzipped** and a looser raw guard (110 KB) that only stops regressions. `npm run build` prints the current sizes.

MIT licensed.

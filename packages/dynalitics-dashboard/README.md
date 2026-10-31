# dynalitics-dashboard

The browser dashboard for [dynalitics](https://github.com/OWNER/dynalitics#readme): a **single self-contained HTML page** (inline CSS, JS and SVG charts) that talks only to a dynalitics read endpoint. It never sees database credentials.

> **Pre-release.** The HTML page is unit-tested against a typed mock of the read contract and has an end-to-end run against the real `dynalitics/handler` on real PostgreSQL and MySQL (`npm run e2e`, needs Docker and Playwright, not run in CI). It has not been run against SQL Server, and not in browsers other than Chromium. React components are available as `dynalitics-dashboard/react` (see below); they are tested against the typed mock only.

```ts
import { dashboardHtml } from 'dynalitics-dashboard/html'; // a complete HTML string
```

The server replaces two placeholders in that string on every request, then sends it with a strict CSP:

| Placeholder            | Replaced with                                                     |
| ---------------------- | ----------------------------------------------------------------- |
| `%%DYNALITICS_NONCE%%` | a fresh random nonce (also used in the `Content-Security-Policy`) |
| `%%DYNALITICS_BASE%%`  | the mount path of the read endpoint, e.g. `/admin/analytics`      |

At the **root mount** the base is the **empty string**, never `/` (a `/` would make the page request `//api/meta`, a different host). The page accepts `''` and builds `{base}/api/*`; it only ever calls its own origin.

## What it shows

Visits over time, top pages, new vs returning (with an "approximate" caveat when IP is part of the identity), consent rate and a recent-visits table. Date ranges 24h / 7d / 30d / 90d (only those the server allows), light and dark themes, UTC labels, a table alternative for every chart, keyboard exploration of charts, `prefers-reduced-motion` support. Loading, empty, "not available for your setup", 401/403, timeout and unreachable states are all handled per widget.

## React components

The same dashboard as components for React 18 and 19 (`react` and `react-dom` are optional peer dependencies):

```tsx
import { DynaliticsDashboard } from 'dynalitics-dashboard/react';
import 'dynalitics-dashboard/react/styles.css';

<DynaliticsDashboard endpoint="/admin/analytics" />;
```

The stylesheet is scoped to the component and needs no CSS-in-JS library. Individual widgets, header-based authorisation (`getRequestInit`), Next.js and theming are described in [docs/REACT.md](https://github.com/OWNER/dynalitics/blob/main/docs/REACT.md).

## Authentication

The served page calls the endpoint with `credentials: 'same-origin'`, so it works with **ambient credentials only** (your session cookie). Hosts that authorise with an `Authorization: Bearer` header cannot use the served page. A redirect to a login page or single sign-on is reported as "unexpected reply", and a network failure on the first request adds a hint that the sign-in may have expired.

## Security properties

- Every string that comes from the API (page URLs, usernames, emails, user ids, IPs) is rendered as text. The source contains no `innerHTML`, `eval` or `new Function`, and a test fails the build if one appears.
- Works under `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; connect-src 'self'`: no inline event handlers, no inline `style` attributes, no external fonts, scripts or images.
- Personal values arrive masked from the server; the page only offers a reveal button if the server says it is allowed, never stores the revealed state and hides it when printing.

## Size

The size of the HTML page is gated by a build test (`test/build.test.ts`): a hard limit on the **gzipped** size, and a larger guard on the raw size that only stops regressions. `npm run build` prints the current sizes. No runtime dependencies.

MIT licensed.

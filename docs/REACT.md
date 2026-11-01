# React components: `dynalitics-dashboard/react`

React 18 and 19 components for the dynalitics read endpoint. They draw the same dashboard as the self-contained HTML page (same markup, same CSS), as normal components you can place in your own app.

You need the read endpoint mounted on your server first (see `docs/SPEC.md` section 10: `createHandler` with your `authorize` function). The components talk only to that endpoint on your own origin. They never see database credentials.

## Install

```sh
npm install dynalitics-dashboard react react-dom
```

`react` and `react-dom` are **optional peer dependencies**: people who only serve the HTML page install nothing extra. The package has no runtime dependencies. Supported: React `^18.0.0 || ^19.0.0`.

## Include the stylesheet

One plain CSS file with the design tokens (light and dark themes). Import it once, anywhere your bundler allows CSS:

```ts
import 'dynalitics-dashboard/react/styles.css';
```

No bundler? Copy `node_modules/dynalitics-dashboard/dist/react/dashboard.css` next to your assets and add `<link rel="stylesheet" href="/assets/dashboard.css">`.

The stylesheet is scoped under `.dy-root`: it does not style `html`, `body` or anything else in your page, and it needs no CSS-in-JS library. The theme follows the operating system by itself; no script is needed for that.

## Plain React

```tsx
import { createRoot } from 'react-dom/client';
import { DynaliticsDashboard } from 'dynalitics-dashboard/react';
import 'dynalitics-dashboard/react/styles.css';

createRoot(document.getElementById('root')!).render(
  <DynaliticsDashboard endpoint="/admin/analytics" />,
);
```

`endpoint` is the path where your server mounted the read endpoint (the `basePath` of `createHandler`).

## Next.js (App Router)

The dashboard uses state and effects, so it is a client component. Keep it in its own file:

```tsx
// app/admin/analytics/dashboard.tsx
'use client';

import { DynaliticsDashboard } from 'dynalitics-dashboard/react';
import 'dynalitics-dashboard/react/styles.css';

export default function Dashboard() {
  return <DynaliticsDashboard endpoint="/admin/analytics" landmark="region" />;
}
```

```tsx
// app/admin/analytics/page.tsx  (a server component)
import Dashboard from './dashboard';

export default function Page() {
  return <Dashboard />;
}
```

- The route handler that serves `/admin/analytics/api/*` is `toFetchHandler(handler)` from the server package (see SPEC 10.1 for the Next.js example, including `dynamic = 'force-dynamic'` and the Node runtime).
- `landmark="region"` avoids a second `<main>` when your layout already has one.
- Server-side rendering works: the server renders the shell and the loading state, the browser then loads the data. If your Content-Security-Policy forbids inline `style` attributes (`style-src` without `'unsafe-inline'`), the bars and the range pill rely on them in server-rendered HTML. In that case render the dashboard only in the browser: `dynamic(() => import('./dashboard'), { ssr: false })`. (Client-side rendering is unaffected by such a CSP: React sets those styles through the DOM API, which CSP allows.)

## Authorisation

By default every request is a same-origin `GET` with `credentials: 'same-origin'`, so your session cookie is sent and your `authorize(req)` on the server decides. If you authorise with a header instead, pass `getRequestInit`. It runs before every request and may be async:

```tsx
<DynaliticsDashboard
  endpoint="/admin/analytics"
  getRequestInit={async () => ({
    headers: { authorization: `Bearer ${await getAccessToken()}` },
  })}
/>
```

`getAccessToken` is your own function that returns a short-lived token. Do not hard-code tokens in source, and never put credentials in `endpoint`.

What the component keeps for itself, whatever `getRequestInit` returns: the method stays `GET`, no body is sent, `redirect` stays `'manual'` (a redirect means a login page, never data), our abort signal and `accept: application/json` win. You may set extra `headers`, `credentials`, `mode`, `cache` and `referrerPolicy`. If your function throws or rejects, the dashboard shows "not authorised" and never shows the error text.

## Props

`<DynaliticsDashboard>` and `<DynaliticsProvider>` take the same props (the dashboard adds `landmark`):

| Prop             | Type                                        | Default             | Meaning                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`       | `string`                                    | `''`                | Same-origin path of the read endpoint. `''` and `/` mean the site root. Anything that is not a plain same-origin path (an absolute URL, `//host`, a path with an empty segment such as `/a//b`) is treated as the root, so request options never go to another origin. |
| `getRequestInit` | `() => RequestInit \| Promise<RequestInit>` | none                | Extra request options, see above.                                                                                                                                                                                                                                      |
| `theme`          | `'system' \| 'light' \| 'dark'`             | `'system'`          | `system` follows the OS and shows a "Dark theme" button (the choice is kept in `localStorage`); `light` and `dark` fix the theme and hide the button.                                                                                                                  |
| `locale`         | `string`                                    | browser             | Number and date formatting. Labels are English and every time is UTC.                                                                                                                                                                                                  |
| `defaultRange`   | `'24h' \| '7d' \| '30d' \| '90d'`           | server's 7d         | Range shown first, if the server offers it.                                                                                                                                                                                                                            |
| `onRangeChange`  | `(range) => void`                           | none                | Called when the user picks a range, e.g. to mirror it in your router. The URL is never touched by the component.                                                                                                                                                       |
| `landmark`       | `'main' \| 'region'`                        | `'main'`            | Dashboard only. Use `region` if your page already has a `<main>`.                                                                                                                                                                                                      |
| `className`      | `string`                                    | none                | Extra class on the `.dy-root` element.                                                                                                                                                                                                                                 |
| `reloadPage`     | `() => void`                                | `location.reload()` | What the "Reload page" button does.                                                                                                                                                                                                                                    |
| `fetch`          | `typeof fetch`                              | global              | Replacement `fetch` (advanced, used by the tests).                                                                                                                                                                                                                     |

## Individual widgets

Build your own layout from the widgets. They share one provider, which reads `/api/meta` once and owns the date range:

```tsx
import {
  DynaliticsProvider,
  RangeSelector,
  VisitsOverTime,
  ConsentRate,
  TopPages,
  NewVsReturning,
  RecentVisits,
  Errors,
  useDynalitics,
} from 'dynalitics-dashboard/react';

function Refresh() {
  const { refresh, status } = useDynalitics();
  return (
    <button onClick={refresh} disabled={status !== 'ready'}>
      Refresh
    </button>
  );
}

<DynaliticsProvider endpoint="/admin/analytics" theme="light">
  <RangeSelector />
  <Refresh />
  <VisitsOverTime />
  <ConsentRate />
</DynaliticsProvider>;
```

Each widget only requests its own route. `<Errors />` shows the 4xx/5xx panel when the server stores the HTTP status (`columns.status`), and "not available for your setup" otherwise; `<DynaliticsDashboard>` simply leaves it out in that case. Both `<Errors>` and `<RecentVisits>` take an optional `no` (the "No. 5" label). `useDynalitics()` returns `{ status, range, ranges, setRange, refresh, updatedAt, isDark }`.

## What every widget does for you

- **States:** loading (skeleton after 200 ms, so fast responses do not flash), empty, "not available for your setup" (calm, no retry), and errors with fixed wording for 401/403, unreachable, timeout, database busy, unexpected reply (login page, redirect) and bad request. Retry has a 2 s cooldown and nothing retries by itself.
- **Driven by `/api/meta`:** widgets the server reports as unavailable are not requested; table columns appear only for the fields your table maps; ranges longer than the server allows are not offered.
- **New vs returning:** clamped to the server's cap (31 days by default) and labelled with the window it really shows, with an "Estimate" tag when IP addresses are part of the identity.
- **Personal data:** values arrive masked from the server and are shown as received. The "Show full values" button appears only if the server allows it; the revealed state is never stored.
- **Accessibility:** every chart is keyboard-explorable (left/right, Home/End, Escape), has a text summary, announces periods in a live region and has a real table alternative; visible focus rings; `prefers-reduced-motion` and forced-colours supported.

## Theming

All colours, fonts and spacing are CSS custom properties on `.dy-root`. Override them with a class of your own (it must be at least as specific, so repeat `.dy-root`):

```css
.analytics.dy-root {
  --c-accent: #1f6feb;
}
```

```tsx
<DynaliticsDashboard className="analytics" endpoint="/admin/analytics" />
```

Dark-theme values live on `.dy-root[data-theme='dark']` (and, without JavaScript, in a `prefers-color-scheme` rule). Token meanings and the verified contrast ratios are in `docs/DESIGN.md` section 2; keep text at 4.5:1 and marks at 3:1 if you change colours (`node docs/check-design-tokens.mjs` checks the defaults).

## Security

- Every string that comes from the API (page URLs, usernames, emails, user ids, IPs, breakdown values, server messages) is rendered as a React text child. The source has no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` and no string-built links, and tests fail the build if one appears.
- The only network calls are `GET {endpoint}/api/*`. No fonts, scripts or images are loaded from anywhere else.
- Server error messages are never shown; the wording is fixed. The only server text shown is a widget's own "not available" explanation, as plain text.

## Differences from the HTML page

The React dashboard renders the same DOM and CSS as the HTML page for every panel. Intentional differences, because it lives inside your page:

- It does not mirror the range in the URL hash (use `onRangeChange` and `defaultRange`).
- No version number in the footer.
- `theme="system"` reads a stored choice in the browser after the first render (no flash: the OS preference already applies through CSS).
- Page-level layout is viewport-based (the same breakpoints as the HTML page), not container-based.
- Widgets used with `<DynaliticsProvider>` have no masthead; use `useDynalitics()` and `<RangeSelector />` for your own refresh and range controls.

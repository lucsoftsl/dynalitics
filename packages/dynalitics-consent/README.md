# dynalitics-consent

An optional **consent banner** for [dynalitics](https://www.npmjs.com/package/dynalitics). It asks visitors whether they allow analytics, remembers the answer in one first-party cookie, and gives your server a one-line helper that turns that answer into the `consent` boolean `track()` expects.

`dynalitics` itself never asks for consent: it only honours the boolean you pass. Use this package if you want dynalitics to do the asking; skip it if you already have a consent manager (then pass its answer to `track()` yourself).

> **Pre-release (`0.0.0`, not on npm yet).** Tested in jsdom (plain DOM and React, including server rendering); not yet in real browsers.

```sh
npm install dynalitics-consent     # no runtime dependencies; react is an optional peer
```

## How it fits together

```
browser                                           your server
  <ConsentBanner message="..." />                   consentFromRequest(req)  -> true / false
    visitor clicks Allow / Reject                     |
    -> cookie dynalitics_consent=granted|denied  ---> dyn.track({ consent, ... })
```

Until the visitor clicks, there is no cookie, the helper returns `false`, and dynalitics stores only the page and the time. Nothing personal is ever recorded before a choice.

## 1. Show the banner

**React:**

```tsx
import { ConsentBanner } from 'dynalitics-consent/react';
import 'dynalitics-consent/styles.css';

export function Layout({ children }) {
  return (
    <>
      {children}
      <ConsentBanner
        enabled={true}
        message="We count the pages you visit to improve this site. Do you allow analytics?"
        acceptLabel="Allow"
        rejectLabel="No thanks"
        policyUrl="/privacy"
      />
    </>
  );
}
```

**Without React** (any site, any framework):

```ts
import { mountConsentBanner } from 'dynalitics-consent';
import 'dynalitics-consent/styles.css'; // or copy dist/styles.css into your own stylesheet

const banner = mountConsentBanner({
  message: 'We count the pages you visit to improve this site. Do you allow analytics?',
  policyUrl: '/privacy',
});
```

The banner only appears when the visitor has not chosen yet.

### Options (the same for both)

| Option        | Default                | What it does                                                                                        |
| ------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `message`     | **required**           | the question, as plain text                                                                         |
| `enabled`     | `true`                 | `false` shows nothing and never touches the cookie                                                  |
| `title`       | none                   | an optional heading, plain text                                                                     |
| `acceptLabel` | `'Allow'`              | text of the allow button                                                                            |
| `rejectLabel` | `'Reject'`             | text of the reject button                                                                           |
| `policyUrl`   | none                   | link to your privacy policy: a path like `/privacy` or an `https://` URL (anything else is ignored) |
| `policyLabel` | `'Privacy policy'`     | text of that link                                                                                   |
| `cookieName`  | `'dynalitics_consent'` | change it only if it clashes; use the same name on the server                                       |
| `maxAgeDays`  | `180`                  | how long the answer is remembered (1 to 395 days)                                                   |
| `onChange`    | none                   | `(choice: 'granted' \| 'denied') => void`, called after a click                                     |

All text is rendered as text, never as HTML, so it is safe to load it from a CMS.

## 2. Read the answer on the server

```ts
import { createDynalitics } from 'dynalitics';
import { postgres } from 'dynalitics-postgres';
import { consentFromRequest } from 'dynalitics-consent/server';

const dyn = await createDynalitics({ adapter: postgres /* ... */ });

app.use((req, res, next) => {
  void dyn.track({
    pageVisited: req.originalUrl,
    consent: consentFromRequest(req), // true only after the visitor clicked "Allow"
    ip: req.ip,
    userId: req.user?.id,
  });
  next();
});
```

`consentFromRequest` accepts a Node request (Express, Fastify, `node:http`), a Fetch `Request` (Next.js route handlers, Hono, Bun, Deno) or a raw `Cookie` header string. It returns `true` **only** for an explicit "Allow". No cookie, "Reject", an unknown value, a malformed header, or two conflicting cookies all give `false`. It never throws for a request.

## 3. Let visitors change their mind

Consent must be as easy to withdraw as to give. Put a "Cookie settings" link somewhere permanent, such as your footer:

```tsx
import { useConsent } from 'dynalitics-consent/react';

function CookieSettingsLink() {
  const { reopen } = useConsent();
  return (
    <button type="button" onClick={reopen}>
      Cookie settings
    </button>
  );
}
```

Without React, call `banner.open()` on the handle `mountConsentBanner` returned.

`useConsent()` also gives you `choice` (`'granted'`, `'denied'` or `null`), `grant()` and `deny()`, if you prefer to build your own UI. Without React the same is available as `readConsent()`, `writeConsent(choice)` and `clearConsent()`. Every change also fires a `dynalitics:consent` event on `window` with `detail.choice`.

## What it does and does not do

- **One cookie, nothing else.** `dynalitics_consent=granted|denied; Path=/; Max-Age=…; SameSite=Lax`, plus `Secure` on https pages, written only when the visitor clicks. No local storage, no network requests, no tracking of any kind.
- **Equal choices.** Allow and Reject are the same element with the same style; neither is pre-selected or highlighted.
- **Accessible.** A non-modal dialog (`role="dialog"`, `aria-modal="false"`) labelled by its title or message; it does not trap focus or block the page. Buttons are at least 44 px tall, with visible focus rings. Hidden when printing.
- **Strict-CSP friendly.** Styling is class-based in a separate stylesheet; no inline `style` attributes, no injected `<style>` tags.
- **Server rendering.** The React banner renders nothing on the server and decides in the browser, so hydration never mismatches.
- **Theming.** Override the CSS custom properties on `.dy-consent` (`--dy-consent-bg`, `--dy-consent-fg`, `--dy-consent-muted`, `--dy-consent-rule`, `--dy-consent-focus`, `--dy-consent-font`). It follows `prefers-color-scheme` by default.
- **Not legal advice.** The wording of your message, your privacy policy, and whether a banner is enough in your jurisdiction remain your responsibility.

## Entry points

| Import                          | Contents                                                                  |
| ------------------------------- | ------------------------------------------------------------------------- |
| `dynalitics-consent`            | `mountConsentBanner`, `readConsent`, `writeConsent`, `clearConsent` (DOM) |
| `dynalitics-consent/react`      | `<ConsentBanner>`, `useConsent()`                                         |
| `dynalitics-consent/server`     | `consentFromRequest`, `parseConsentCookie` (no DOM; runs anywhere)        |
| `dynalitics-consent/styles.css` | the banner's stylesheet                                                   |

The full contract is in [`docs/SPEC.md` section 19](https://github.com/lucsoftsl/dynalitics/blob/main/docs/SPEC.md).

MIT licensed.

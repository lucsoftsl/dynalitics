// Fixed English copy of the dashboard (docs/DESIGN.md sections 6 and 8). These strings mirror the
// HTML dashboard in src/ui; test/react/copy.test.ts fails if either side drifts. Server text
// (error messages) is never shown, except `unavailable.message`, which is rendered as plain text.
import type { FailureKind } from '../ui/api.js';

export interface ErrorCopy {
  readonly stamp: string;
  readonly title: string;
  readonly body: string;
  readonly retry: boolean;
  readonly shorter: boolean;
}

export const ERROR_COPY: Record<FailureKind, ErrorCopy> = {
  forbidden: {
    stamp: 'NOT AUTHORISED',
    title: "You can't view analytics.",
    body: 'The app that serves this page said no. Sign in with an account that is allowed to see analytics, then reload.',
    retry: false,
    shorter: false,
  },
  unexpected: {
    stamp: 'UNEXPECTED REPLY',
    title: "The analytics endpoint didn't return data.",
    body: "It returned something that isn't analytics JSON, or redirected somewhere else. This usually means a login page, single sign-on or a proxy in front of this route. Check the route and its authorisation.",
    retry: true,
    shorter: false,
  },
  unreachable: {
    stamp: 'UNREACHABLE',
    title: "Can't reach the analytics endpoint.",
    body: 'Check your connection and that the server is running. Nothing was lost; data stays in your database.',
    retry: true,
    shorter: false,
  },
  timeout: {
    stamp: 'TIMED OUT',
    title: 'That took too long.',
    body: 'The query exceeded its time limit. Choose a shorter range.',
    retry: true,
    shorter: true,
  },
  busy: {
    stamp: 'UNAVAILABLE',
    title: 'The database is busy or unavailable.',
    body: 'Try again in a moment.',
    retry: true,
    shorter: false,
  },
  bad_request: {
    stamp: 'BAD REQUEST',
    title: "That range isn't allowed.",
    body: 'Choose a shorter range.',
    retry: false,
    shorter: true,
  },
  not_found: {
    stamp: 'NOT FOUND',
    title: "This route doesn't exist.",
    body: 'The dashboard and server versions may not match. Update both packages.',
    retry: false,
    shorter: false,
  },
  server: {
    stamp: 'ERROR',
    title: 'Something went wrong on the server.',
    body: 'The server logged the details. Try again.',
    retry: true,
    shorter: false,
  },
};

export const SSO_HINT =
  'If this page sits behind single sign-on, your sign-in may have expired: reload the page.';

export const HINT_LONG =
  'Use the left and right arrow keys to move between periods. Escape closes the tooltip.';
export const HINT_SHORT = '← → explore · Esc close';

export const UNKNOWN_DEF = 'Unknown means no consent, or consent but no usable identity.';
export const CAVEAT =
  'Visitors are matched by IP address as well as user id, so shared addresses can merge people and hashed addresses reset when the salt changes. Read these as estimates, not a head count.';

export const capNote = (cap: number): string =>
  cap === 1
    ? 'Showing the last day: this widget is capped at 1 day.'
    : `Showing the last ${cap} days: this widget is capped at ${cap} days.`;

export const NO_VALUE_NOTE = 'Rows without a value for this field.';

export const CONSENT_SUB = (denied: string): string =>
  `${denied} visits declined. Declined visits store only the page and the time. No IP, user id, name or email is kept, and they are never counted as new or returning.`;

export { ERRORS_COPY } from '../ui/panels/errors.js';
import { ERRORS_EMPTY } from '../ui/panels/errors.js';

export const EMPTY = {
  pages: { title: 'No pages yet.', body: 'Pages appear once visits are recorded.' },
  nvr: {
    title: 'Nobody classified yet.',
    body: 'Visits count as new or returning only when consent was given and an identity was supplied.',
  },
  consent: {
    title: 'No consent decisions yet.',
    body: 'Granted and declined visits will appear here.',
  },
  table: {
    title: 'No visits in this range.',
    body: 'Newest visits appear here as soon as they are written.',
  },
  errors: ERRORS_EMPTY,
} as const;

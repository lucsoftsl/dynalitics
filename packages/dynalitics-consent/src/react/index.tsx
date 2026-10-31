'use client';

// 'dynalitics-consent/react' (docs/SPEC.md 19). Same DOM and class names as the plain-DOM banner, so one stylesheet
// serves both. Renders nothing on the server and on the first client render, so hydration never mismatches.
import { useCallback, useEffect, useId, useState, type ReactElement } from 'react';
import {
  CONSENT_EVENT,
  readConsent,
  writeConsent,
  type ConsentBannerOptions,
  type ConsentChoice,
  type CookieOptions,
} from '../index.js';
import { safePolicyUrl } from '../shared.js';

export type { ConsentBannerOptions, ConsentChoice, CookieOptions } from '../index.js';

/** Asks every mounted <ConsentBanner> to show itself again (withdrawal / "Cookie settings"). */
const OPEN_EVENT = 'dynalitics:consent-open';

export interface UseConsent {
  /** null until the visitor chose (and always null during server rendering). */
  readonly choice: ConsentChoice | null;
  readonly grant: () => void;
  readonly deny: () => void;
  /** Shows the banner again, whatever was stored. */
  readonly reopen: () => void;
}

/** The visitor's choice, kept in sync with the banner and with other tabs' writes on this page. */
export function useConsent(options: CookieOptions = {}): UseConsent {
  const { cookieName, maxAgeDays } = options;
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  useEffect(() => {
    const sync = (): void => setChoice(readConsent({ cookieName }));
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    return () => window.removeEventListener(CONSENT_EVENT, sync);
  }, [cookieName]);
  const write = useCallback(
    (c: ConsentChoice) => writeConsent(c, { cookieName, maxAgeDays }),
    [cookieName, maxAgeDays],
  );
  return {
    choice,
    grant: () => write('granted'),
    deny: () => write('denied'),
    reopen: () => window.dispatchEvent(new Event(OPEN_EVENT)),
  };
}

export type ConsentBannerProps = ConsentBannerOptions;

function assertMessage(message: unknown): void {
  if (typeof message !== 'string' || message.trim() === '')
    throw new TypeError('dynalitics-consent: message is required');
}

export function ConsentBanner(props: ConsentBannerProps): ReactElement | null {
  assertMessage(props.message);
  const { enabled = true, cookieName, maxAgeDays, onChange } = props;
  const id = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (readConsent({ cookieName }) === null) setOpen(true);
    const reopen = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, reopen);
    return () => window.removeEventListener(OPEN_EVENT, reopen);
  }, [enabled, cookieName]);

  if (!enabled || !open) return null;
  const choose = (c: ConsentChoice): void => {
    writeConsent(c, { cookieName, maxAgeDays });
    setOpen(false);
    onChange?.(c);
  };
  const url = safePolicyUrl(props.policyUrl);
  return (
    <div
      className="dy-consent"
      role="dialog"
      aria-modal="false"
      aria-labelledby={props.title ? `${id}-t` : `${id}-m`}
    >
      {props.title ? (
        <p className="dy-consent-title" id={`${id}-t`}>
          {props.title}
        </p>
      ) : null}
      <p className="dy-consent-msg" id={`${id}-m`}>
        {props.message}
      </p>
      {url ? (
        <a className="dy-consent-link" href={url}>
          {props.policyLabel ?? 'Privacy policy'}
        </a>
      ) : null}
      <div className="dy-consent-actions">
        <button
          type="button"
          className="dy-consent-btn"
          data-choice="denied"
          onClick={() => choose('denied')}
        >
          {props.rejectLabel ?? 'Reject'}
        </button>
        <button
          type="button"
          className="dy-consent-btn"
          data-choice="granted"
          onClick={() => choose('granted')}
        >
          {props.acceptLabel ?? 'Allow'}
        </button>
      </div>
    </div>
  );
}

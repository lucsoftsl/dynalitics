// @vitest-environment jsdom
// docs/SPEC.md 19.2 and 19.3: the plain-DOM banner.
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clearConsent,
  CONSENT_EVENT,
  mountConsentBanner,
  readConsent,
  writeConsent,
} from '../src/index.js';
import { consentFromRequest } from '../src/server.js';

const banner = () => document.querySelector<HTMLElement>('.dy-consent');
const button = (choice: 'granted' | 'denied') =>
  document.querySelector<HTMLButtonElement>(`.dy-consent-btn[data-choice="${choice}"]`);

afterEach(() => {
  clearConsent();
  clearConsent({ cookieName: 'other' });
  document.body.innerHTML = '';
});

describe('mountConsentBanner', () => {
  test('asks when there is no choice; Allow stores granted, removes itself and reports', () => {
    const onChange = vi.fn();
    const events: unknown[] = [];
    window.addEventListener(CONSENT_EVENT, (e) => events.push((e as CustomEvent).detail));
    const h = mountConsentBanner({ message: 'May we count your visit?', onChange });
    expect(banner()?.getAttribute('role')).toBe('dialog');
    expect(banner()?.getAttribute('aria-modal')).toBe('false');
    expect(h.choice()).toBeNull();
    button('granted')!.click();
    expect(banner()).toBeNull();
    expect(document.cookie).toContain('dynalitics_consent=granted');
    expect(readConsent()).toBe('granted');
    expect(h.choice()).toBe('granted');
    expect(onChange).toHaveBeenCalledWith('granted');
    expect(events).toContainEqual({ choice: 'granted' });
  });

  test('Reject stores denied; a stored choice means no banner on the next page', () => {
    mountConsentBanner({ message: 'm' });
    button('denied')!.click();
    expect(readConsent()).toBe('denied');
    document.body.innerHTML = '';
    mountConsentBanner({ message: 'm' });
    expect(banner()).toBeNull();
  });

  test('open() shows the banner again so the visitor can change their mind', () => {
    writeConsent('granted');
    const h = mountConsentBanner({ message: 'm' });
    expect(banner()).toBeNull();
    h.open();
    h.open(); // idempotent
    expect(document.querySelectorAll('.dy-consent')).toHaveLength(1);
    button('denied')!.click();
    expect(readConsent()).toBe('denied');
  });

  test('enabled: false renders nothing, reads nothing, writes nothing', () => {
    const h = mountConsentBanner({ message: 'm', enabled: false });
    h.open();
    expect(banner()).toBeNull();
    expect(h.choice()).toBeNull();
    expect(document.cookie).not.toContain('dynalitics_consent');
  });

  test('both choices are the same element with the same class (equal prominence)', () => {
    mountConsentBanner({ message: 'm', acceptLabel: 'Yes please', rejectLabel: 'No thanks' });
    const a = button('granted')!;
    const r = button('denied')!;
    expect(a.tagName).toBe(r.tagName);
    expect(a.className).toBe(r.className);
    expect([a.textContent, r.textContent]).toEqual(['Yes please', 'No thanks']);
  });

  test('every string is text, and only safe policy links are rendered', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    mountConsentBanner({
      message: hostile,
      title: hostile,
      acceptLabel: hostile,
      policyUrl: 'javascript:alert(3)',
    });
    expect(document.querySelector('img, script')).toBeNull();
    expect(document.querySelector('.dy-consent-msg')?.textContent).toBe(hostile);
    expect(document.querySelector('a')).toBeNull();
    document.body.innerHTML = '';
    mountConsentBanner({ message: 'm', policyUrl: '/privacy', policyLabel: 'Read more' });
    const a = document.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/privacy');
    expect(a.textContent).toBe('Read more');
  });

  test('labelled by the title when there is one, else by the message', () => {
    mountConsentBanner({ message: 'm', title: 'Analytics' });
    const id = banner()!.getAttribute('aria-labelledby')!;
    expect(document.getElementById(id)?.textContent).toBe('Analytics');
  });

  test('custom cookie name and container; bad options are configuration errors', () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    mountConsentBanner({ message: 'm', cookieName: 'other' }, box);
    expect(box.querySelector('.dy-consent')).not.toBeNull();
    button('granted')!.click();
    expect(readConsent({ cookieName: 'other' })).toBe('granted');
    expect(readConsent()).toBeNull();
    expect(() => mountConsentBanner({ message: '' })).toThrow(/message/);
    expect(() => mountConsentBanner({ message: 'm', cookieName: 'a b' })).toThrow(/cookieName/);
    expect(() => mountConsentBanner({ message: 'm', maxAgeDays: 400 })).toThrow(/maxAgeDays/);
    expect(() => writeConsent('yes' as never)).toThrow(TypeError);
  });

  test('round trip: what the banner writes is exactly what the server helper accepts', () => {
    mountConsentBanner({ message: 'm' });
    expect(consentFromRequest(document.cookie)).toBe(false); // asked, not answered: no consent
    button('granted')!.click();
    expect(consentFromRequest(document.cookie)).toBe(true);
    mountConsentBanner({ message: 'm' }).open();
    button('denied')!.click();
    expect(consentFromRequest(document.cookie)).toBe(false);
  });

  test('clearConsent forgets the choice', () => {
    writeConsent('granted');
    clearConsent();
    expect(readConsent()).toBeNull();
  });
});

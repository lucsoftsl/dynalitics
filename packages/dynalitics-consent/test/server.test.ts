// docs/SPEC.md 19.4: the server helper is the only thing track() sees. It must fail closed.
import { describe, expect, test } from 'vitest';
import { consentFromRequest, parseConsentCookie } from '../src/server.js';
import { consentCookie, safePolicyUrl } from '../src/shared.js';

describe('consentFromRequest', () => {
  test.each([
    ['granted', 'dynalitics_consent=granted', true],
    ['granted among other cookies', 'a=1; dynalitics_consent=granted; b=2', true],
    ['whitespace around the value', 'dynalitics_consent = granted ', true],
    ['denied', 'dynalitics_consent=denied', false],
    ['no cookie header', '', false],
    ['other cookies only', 'session=abc', false],
    ['unknown value', 'dynalitics_consent=yes', false],
    ['upper case value', 'dynalitics_consent=GRANTED', false],
    ['empty value', 'dynalitics_consent=', false],
    ['conflicting duplicates', 'dynalitics_consent=granted; dynalitics_consent=denied', false],
    ['similar name', 'xdynalitics_consent=granted', false],
    ['malformed header', ';;==;dynalitics_consent', false],
  ])('%s -> %s', (_label, header, expected) => {
    expect(consentFromRequest(header)).toBe(expected);
  });

  test('identical duplicates (same cookie on two paths) still count', () => {
    expect(consentFromRequest('dynalitics_consent=granted; dynalitics_consent=granted')).toBe(true);
  });

  test('Node IncomingMessage shape, including an array header', () => {
    expect(consentFromRequest({ headers: { cookie: 'dynalitics_consent=granted' } })).toBe(true);
    expect(consentFromRequest({ headers: { cookie: ['x=1', 'dynalitics_consent=granted'] } })).toBe(
      true,
    );
    expect(consentFromRequest({ headers: {} })).toBe(false);
  });

  test('Fetch Request', () => {
    const req = new Request('https://site.test/', {
      headers: { cookie: 'dynalitics_consent=granted' },
    });
    expect(consentFromRequest(req)).toBe(true);
    expect(consentFromRequest(new Request('https://site.test/'))).toBe(false);
  });

  test('never throws on a hostile request object', () => {
    const throwing = {
      headers: {
        get: () => {
          throw new Error('boom');
        },
      },
    };
    expect(consentFromRequest(throwing)).toBe(false);
    expect(consentFromRequest(null as never)).toBe(false);
    expect(consentFromRequest({ headers: { cookie: 42 } } as never)).toBe(false);
  });

  test('custom cookie name; an invalid one is a configuration error', () => {
    expect(consentFromRequest('my_c=granted', { cookieName: 'my_c' })).toBe(true);
    expect(consentFromRequest('dynalitics_consent=granted', { cookieName: 'my_c' })).toBe(false);
    expect(() => consentFromRequest('', { cookieName: 'bad;name' })).toThrow(TypeError);
  });

  test('parseConsentCookie returns the choice or null', () => {
    expect(parseConsentCookie('dynalitics_consent=denied')).toBe('denied');
    expect(parseConsentCookie('dynalitics_consent=maybe')).toBeNull();
    expect(parseConsentCookie(undefined)).toBeNull();
  });
});

describe('shared helpers', () => {
  test('cookie string: path, max-age, SameSite=Lax, Secure only on https', () => {
    expect(consentCookie('c', 'granted', 60, true)).toBe(
      'c=granted; Path=/; Max-Age=60; SameSite=Lax; Secure',
    );
    expect(consentCookie('c', '', 0, false)).toBe('c=; Path=/; Max-Age=0; SameSite=Lax');
  });

  test.each([
    ['/privacy', '/privacy'],
    ['https://example.com/p', 'https://example.com/p'],
    ['http://example.com/p', 'http://example.com/p'],
    ['//evil.example/p', null],
    ['javascript:alert(1)', null],
    [' javascript:alert(1)', null],
    ['data:text/html,x', null],
    ['privacy', null],
    ['', null],
    [undefined, null],
  ])('policy url %j -> %j', (input, expected) => {
    expect(safePolicyUrl(input)).toBe(expected);
  });
});

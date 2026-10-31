import { describe, expect, test } from 'vitest';
import { maskEmail, maskIp, maskUserId, maskUsername } from '../../src/read/mask.js';

describe('PII masking (spec 10.6)', () => {
  test.each([
    ['203.0.113.77', '203.0.x.x'],
    ['2001:db8:abcd::1', '2001:db8::x'],
    ['::1', '::x'],
    ['a'.repeat(64), 'aaaaaaaa…'],
    [null, null],
    ['', null],
    ['not an ip at all', '***'],
  ])('ip %j -> %j', (input, expected) => {
    expect(maskIp(input)).toBe(expected);
  });

  test.each([
    ['jane@example.com', 'j***@example.com'],
    ['a@b.co', 'a***@b.co'],
    ['no-at-sign', '***'],
    ['@example.com', '***'],
    ['a@b@c.d', '***'],
    ['jane doe@example.com', '***'],
    ['😀x@example.com', '😀***@example.com'],
    [null, null],
  ])('email %j -> %j', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  test.each([
    ['jane', 'j***'],
    ['', '***'],
    ['😀jane', '😀***'],
    [null, null],
  ])('username %j -> %j', (input, expected) => {
    expect(maskUsername(input)).toBe(expected);
  });

  test('masked values never contain the original beyond the documented prefix', () => {
    expect(maskEmail('secret.person@example.com')).not.toContain('ecret');
    expect(maskUsername('hunter2')).not.toContain('unter');
  });
});

describe('userId masking (F-06): masked by default, shape u_***42', () => {
  test.each([
    ['u_90042', 'u_***42'],
    ['abcdef', 'ab***ef'],
    ['3f2a8c1d-0000-4000-8000-1234567890ab', '3f***ab'],
    ['18231', '***'],
    ['u_42', '***'],
    ['', '***'],
    ['jane@example.com', 'j***@example.com'],
    ['😀😀😀😀😀😀', '😀😀***😀😀'],
    [null, null],
  ])('userId %j -> %j', (input, expected) => {
    expect(maskUserId(input)).toBe(expected);
  });
  test('shows at most 4 characters of an id, always at least 6 characters long to show anything', () => {
    for (const id of ['abcde', 'abcdef', 'x'.repeat(100)]) {
      const out = maskUserId(id) ?? '';
      expect(out.replace('***', '').length).toBeLessThanOrEqual(4);
    }
  });
});

describe('masking is total and fails closed (F-12)', () => {
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  const alphabet = '0123456789abcdefABCDEF.:,% @xX-_<>"\'/\\\u0000😀é';
  const random = (r: () => number): string =>
    Array.from(
      { length: Math.floor(r() * 40) },
      () => [...alphabet][Math.floor(r() * [...alphabet].length)],
    ).join('');

  test('ip: whatever goes in, the output is null, a fixed shape, or "***"; never more than two octets', () => {
    const r = rng(7);
    const shape =
      /^(\d{1,3}\.\d{1,3}\.x\.x|[0-9a-f]{1,4}(:[0-9a-f]{1,4})?::x|::x|[0-9a-f]{8}…|\*\*\*)$/i;
    for (let i = 0; i < 5000; i++) {
      const input = random(r);
      const out = maskIp(input);
      expect(out === null || shape.test(out), JSON.stringify([input, out])).toBe(true);
      if (out !== null && /\.x\.x$/.test(out))
        expect(input.split('.').slice(0, 2).join('.')).toBe(out.slice(0, -4));
    }
  });
  test.each([
    '1.2.3.4, 5.6.7.8',
    '203.0.113.9:8080',
    'unknown',
    '::ffff:1.2.3.4',
    'FE80::1%eth0',
    '1.2.3',
    '1.2.3.4.5',
    '999.1.1.1',
  ])('ip %j never leaks more than the documented prefix', (input) => {
    const out = maskIp(input) ?? '';
    expect(out).not.toContain('3.4');
    expect(out).not.toContain('5.6');
    expect(out.length).toBeLessThanOrEqual(12);
  });
  test('email, username and userId: bounded output for arbitrary input', () => {
    const r = rng(11);
    for (let i = 0; i < 5000; i++) {
      const input = random(r);
      const e = maskEmail(input) ?? '';
      expect(/^[^@\s]\*\*\*@[^@\s]+$|^\*\*\*$/u.test(e), JSON.stringify([input, e])).toBe(true);
      expect([...(maskUsername(input) ?? '')].length).toBeLessThanOrEqual(4);
      const u = maskUserId(input) ?? '';
      expect(u === '***' || /\*\*\*/.test(u)).toBe(true);
      expect([...u.replace('***', '')].length).toBeLessThanOrEqual(Math.max(4, [...e].length));
    }
  });
});

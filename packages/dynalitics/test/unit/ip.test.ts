import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyIpMode, normalizeIp } from '../../src/track/ip.js';

describe('normalizeIp', () => {
  test.each([
    ['203.0.113.77', '203.0.113.77'],
    [' 203.0.113.77 ', '203.0.113.77'],
    ['203.0.113.77:51234', '203.0.113.77'],
    ['::ffff:203.0.113.77', '203.0.113.77'],
    ['[2001:DB8::1]:443', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::1', '::1'],
    ['64:ff9b::1.2.3.4', '64:ff9b::102:304'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeIp(input)?.text).toBe(expected);
  });

  test('reports the family', () => {
    expect(normalizeIp('1.2.3.4')?.family).toBe(4);
    expect(normalizeIp('::1')?.family).toBe(6);
  });

  test.each([
    '',
    'not-an-ip',
    '999.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    'x'.repeat(100),
    "1.2.3.4'; DROP TABLE x",
    '2001:db8:::1',
  ])('rejects %j', (input) => {
    expect(normalizeIp(input)).toBeNull();
  });
});

describe('applyIpMode', () => {
  const cfg = (mode: 'raw' | 'hash' | 'truncate', extra = {}) => ({
    mode,
    salt: 'a-long-enough-salt-value',
    ipv4Prefix: 24,
    ipv6Prefix: 48,
    ...extra,
  });

  test('raw keeps the normalised address', () => {
    expect(applyIpMode(normalizeIp('203.0.113.77')!, cfg('raw'))).toBe('203.0.113.77');
  });

  test('truncate zeroes host bits (IPv4 /24 default, IPv6 /48 default)', () => {
    expect(applyIpMode(normalizeIp('203.0.113.77')!, cfg('truncate'))).toBe('203.0.113.0');
    expect(applyIpMode(normalizeIp('2001:db8:abcd:1234:5678::1')!, cfg('truncate'))).toBe(
      '2001:db8:abcd::',
    );
  });

  test('truncate honours custom prefixes, including the extremes', () => {
    expect(applyIpMode(normalizeIp('203.0.113.77')!, cfg('truncate', { ipv4Prefix: 16 }))).toBe(
      '203.0.0.0',
    );
    expect(applyIpMode(normalizeIp('203.0.113.77')!, cfg('truncate', { ipv4Prefix: 8 }))).toBe(
      '203.0.0.0',
    );
    expect(applyIpMode(normalizeIp('203.0.113.77')!, cfg('truncate', { ipv4Prefix: 32 }))).toBe(
      '203.0.113.77',
    );
    expect(applyIpMode(normalizeIp('2001:db8::1')!, cfg('truncate', { ipv6Prefix: 128 }))).toBe(
      '2001:db8::1',
    );
    expect(applyIpMode(normalizeIp('2001:db8:1:2::1')!, cfg('truncate', { ipv6Prefix: 32 }))).toBe(
      '2001:db8::',
    );
  });

  test('hash is a salted HMAC-SHA256 hex digest of the canonical address', () => {
    const out = applyIpMode(normalizeIp('203.0.113.77')!, cfg('hash'));
    expect(out).toBe(
      createHmac('sha256', 'a-long-enough-salt-value').update('203.0.113.77').digest('hex'),
    );
    expect(out).toHaveLength(64);
    expect(out).not.toContain('203');
  });

  test('hash is stable across spellings of the same IPv6 address and changes with the salt', () => {
    const a = applyIpMode(normalizeIp('2001:DB8::1')!, cfg('hash'));
    const b = applyIpMode(normalizeIp('2001:0db8:0:0:0:0:0:1')!, cfg('hash'));
    const c = applyIpMode(
      normalizeIp('2001:db8::1')!,
      cfg('hash', { salt: 'another-long-enough-salt' }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test('hash without a salt is refused (validation normally prevents this)', () => {
    expect(() =>
      applyIpMode(normalizeIp('1.2.3.4')!, {
        mode: 'hash',
        salt: undefined,
        ipv4Prefix: 24,
        ipv6Prefix: 48,
      }),
    ).toThrow(/salt/);
  });
});

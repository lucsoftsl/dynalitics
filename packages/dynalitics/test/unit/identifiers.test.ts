import { describe, expect, test } from 'vitest';
import {
  assertCustomKey,
  assertIdentifier,
  isCustomKey,
  isIdentifier,
  parseTableRef,
} from '../../src/model/identifiers.js';
import { DynaliticsConfigError } from '../../src/errors.js';

describe('identifiers', () => {
  test('accepts plain identifiers up to 63 characters', () => {
    expect(isIdentifier('page_views')).toBe(true);
    expect(isIdentifier('_x1')).toBe(true);
    expect(isIdentifier('a'.repeat(63))).toBe(true);
  });

  test.each([
    'a'.repeat(64),
    '1abc',
    'my table',
    'a-b',
    'a$b',
    'a;DROP TABLE x',
    'x"y',
    'x`y',
    'x]y',
    '',
    'ünï',
    "x'y",
  ])('rejects unsafe identifier %j', (name) => {
    expect(isIdentifier(name)).toBe(false);
    expect(() => assertIdentifier(name, 'column')).toThrow(DynaliticsConfigError);
  });

  test('custom key pattern allows 64 characters and rejects prototype names', () => {
    expect(isCustomKey('a'.repeat(64))).toBe(true);
    expect(isCustomKey('plan')).toBe(true);
    for (const bad of ['__proto__', 'constructor', 'prototype', 'a b', '1x']) {
      expect(isCustomKey(bad)).toBe(false);
    }
    expect(() => assertCustomKey('__proto__')).toThrow(DynaliticsConfigError);
  });

  describe('parseTableRef', () => {
    test('parses one, two and three part strings', () => {
      expect(parseTableRef('events')).toEqual({ name: 'events' });
      expect(parseTableRef('dbo.events')).toEqual({ schema: 'dbo', name: 'events' });
      expect(parseTableRef('db.dbo.events')).toEqual({
        database: 'db',
        schema: 'dbo',
        name: 'events',
      });
    });

    test('parses the object form', () => {
      expect(parseTableRef({ schema: 'analytics', name: 'pv' })).toEqual({
        schema: 'analytics',
        name: 'pv',
      });
    });

    test('rejects more than three parts and bad parts, with the identifier message', () => {
      expect(() => parseTableRef('a.b.c.d')).toThrow(/at most 3 parts/);
      expect(() => parseTableRef('public.events; DROP TABLE x')).toThrow(/not supported/);
      expect(() => parseTableRef({ name: 'a b' })).toThrow(/Allowed: letters, digits/);
      expect(() => parseTableRef('')).toThrow(DynaliticsConfigError);
    });
  });
});

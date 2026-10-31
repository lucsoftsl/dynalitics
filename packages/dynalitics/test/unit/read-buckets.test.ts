import { describe, expect, test } from 'vitest';
import { bucketStarts, floorBucket, nextBucket } from '../../src/read/buckets.js';

const d = (s: string) => new Date(s);

describe('floorBucket (UTC)', () => {
  test.each([
    ['hour', '2026-10-30T12:34:56.789Z', '2026-10-30T12:00:00.000Z'],
    ['day', '2026-10-30T12:34:56.789Z', '2026-10-30T00:00:00.000Z'],
    ['week', '2026-10-30T12:34:56.789Z', '2026-10-26T00:00:00.000Z'], // Friday -> Monday
    ['week', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z'], // Monday stays
    ['week', '2026-11-01T23:59:59.999Z', '2026-10-26T00:00:00.000Z'], // Sunday -> previous Monday
    ['month', '2026-10-30T12:34:56.789Z', '2026-10-01T00:00:00.000Z'],
    ['month', '2026-12-31T23:59:59.999Z', '2026-12-01T00:00:00.000Z'],
  ] as const)('%s %s -> %s', (interval, input, expected) => {
    expect(floorBucket(d(input), interval).toISOString()).toBe(expected);
  });
});

describe('nextBucket', () => {
  test('steps by the interval, handling month lengths and year ends', () => {
    expect(nextBucket(d('2026-10-30T12:00:00.000Z'), 'hour').toISOString()).toBe(
      '2026-10-30T13:00:00.000Z',
    );
    expect(nextBucket(d('2026-10-30T00:00:00.000Z'), 'day').toISOString()).toBe(
      '2026-10-31T00:00:00.000Z',
    );
    expect(nextBucket(d('2026-10-26T00:00:00.000Z'), 'week').toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
    expect(nextBucket(d('2026-12-01T00:00:00.000Z'), 'month').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(nextBucket(d('2026-01-01T00:00:00.000Z'), 'month').toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });
});

describe('bucketStarts (zero filling)', () => {
  test('lists every bucket intersecting [from, to), including partial first and last ones', () => {
    const s = bucketStarts(d('2026-10-24T05:00:00.000Z'), d('2026-10-27T00:00:00.000Z'), 'day');
    expect(s.map((x) => x.toISOString())).toEqual([
      '2026-10-24T00:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ]);
  });
  test('to exactly on a boundary does not add an empty trailing bucket', () => {
    expect(
      bucketStarts(d('2026-10-24T00:00:00.000Z'), d('2026-10-25T00:00:00.000Z'), 'day'),
    ).toHaveLength(1);
  });
  test('weeks and months', () => {
    expect(
      bucketStarts(d('2026-10-01T00:00:00.000Z'), d('2026-10-31T00:00:00.000Z'), 'week'),
    ).toHaveLength(5);
    expect(
      bucketStarts(d('2026-01-15T00:00:00.000Z'), d('2026-04-02T00:00:00.000Z'), 'month'),
    ).toHaveLength(4);
  });
});

import { describe, expect, test, vi } from 'vitest';
import { createFirstVisit } from '../../src/track/first-visit.js';

const u = (value: string) => ({ kind: 'u' as const, value });
const i = (value: string) => ({ kind: 'i' as const, value });

function make(found: Record<string, string[]> = {}, cacheSize = 100) {
  const lookup = vi.fn((kind: 'u' | 'i', values: readonly string[]) =>
    Promise.resolve(new Set(values.filter((v) => (found[kind] ?? []).includes(v)))),
  );
  const fv = createFirstVisit({
    cacheSize,
    processKey: Buffer.from('k'.repeat(32)),
    maxParams: 3,
    lookup,
  });
  return { fv, lookup };
}

describe('write-time first visit (opt-in)', () => {
  test('unseen identity is first; one already in the database is not', async () => {
    const { fv } = make({ u: ['old'] });
    expect(await fv.resolve([u('new'), u('old')])).toEqual([true, false]);
  });

  test('no identity -> NULL', async () => {
    const { fv, lookup } = make();
    expect(await fv.resolve([null])).toEqual([null]);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('repeats inside one batch: only the first occurrence can be true', async () => {
    const { fv } = make();
    expect(await fv.resolve([u('a'), u('a'), i('a'), u('a')])).toEqual([true, false, true, false]);
  });

  test('committed identities hit the LRU and cause no further lookups', async () => {
    const { fv, lookup } = make();
    await fv.resolve([u('a')]);
    fv.commit([u('a')]);
    lookup.mockClear();
    expect(await fv.resolve([u('a')])).toEqual([false]);
    expect(lookup).not.toHaveBeenCalled();
    expect(fv.size()).toBe(1);
  });

  test('NOT committing (failed insert) means the next visit is still first', async () => {
    const { fv } = make();
    await fv.resolve([u('a')]);
    expect(await fv.resolve([u('a')])).toEqual([true]);
  });

  test('lookups are chunked by maxParams and kinds are separate queries', async () => {
    const { fv, lookup } = make();
    await fv.resolve([u('1'), u('2'), u('3'), u('4'), i('5')]);
    expect(lookup.mock.calls.map(([k, v]) => [k, v.length])).toEqual([
      ['u', 3],
      ['u', 1],
      ['i', 1],
    ]);
  });

  test('LRU evicts the oldest entry beyond cacheSize; evicted identities are looked up again', async () => {
    const { fv, lookup } = make({}, 2);
    fv.commit([u('a'), u('b'), u('c')]);
    expect(fv.size()).toBe(2);
    lookup.mockClear();
    await fv.resolve([u('a')]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('a failing lookup yields NULL for the affected rows instead of guessing', async () => {
    const lookup = vi.fn(() => Promise.reject(new Error('permission denied')));
    const fv = createFirstVisit({
      cacheSize: 10,
      processKey: Buffer.from('k'),
      maxParams: 10,
      lookup,
    });
    const onFail = vi.fn();
    expect(await fv.resolve([u('a'), null], onFail)).toEqual([null, null]);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  test('the LRU never holds raw identity values', () => {
    const { fv } = make();
    fv.commit([u('jane@example.com')]);
    expect(JSON.stringify([...fv.debugKeys()])).not.toContain('jane');
  });
});

import { describe, expect, test } from 'vitest';
import { ENABLED, leftovers, setupFixture, type Fixture } from './support.js';

const namesOf = (fixtures: readonly Fixture[]): string[] =>
  fixtures.flatMap((f) => [f.bareTable, f.writerName, f.readerName]);

describe.each(ENABLED)('fixture cleanup is complete and loud: %s', (dialect) => {
  test('cleaning up several fixtures at the same time leaves no table, role or user behind', async () => {
    const fixtures = await Promise.all(Array.from({ length: 6 }, () => setupFixture(dialect)));
    const names = namesOf(fixtures);
    expect((await leftovers(dialect, names)).length).toBe(names.length); // they exist before cleanup

    await Promise.all(fixtures.map((f) => f.cleanup()));

    expect(await leftovers(dialect, names)).toEqual([]);
  });

  test('a fixture that created its own schema removes the schema too', async () => {
    const f = await setupFixture(dialect, {}, { ownSchema: true });
    const names = [...namesOf([f]), f.schemaName];
    expect((await leftovers(dialect, names)).length).toBe(names.length);
    await f.cleanup();
    expect(await leftovers(dialect, names)).toEqual([]);
  });

  test('a cleanup that cannot finish rejects instead of hiding it, and a second cleanup finishes the job', async () => {
    const f = await setupFixture(dialect);
    const names = namesOf([f]);
    await f.admin.close(); // the admin connection is gone: no statement can run

    await expect(f.cleanup()).rejects.toThrow(/cleanup/i);
    expect((await leftovers(dialect, names)).length).toBeGreaterThan(0);

    // Remove what the failed attempt left, using a fresh fixture-independent connection.
    const { cleanupByName } = await import('./support.js');
    await cleanupByName(dialect, f.table, [f.writerName, f.readerName]);
    expect(await leftovers(dialect, names)).toEqual([]);
  });
});

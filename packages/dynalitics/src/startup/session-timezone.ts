import type { Driver } from '../driver/types.js';

/** '00:00:00', '-00:00:00' and '0:00' all mean "UTC". */
export const isUtcOffset = (timeDiff: string): boolean =>
  /^-?0{1,3}:00(:00)?/.test(timeDiff.trim());

const PROBE_SQL = 'SELECT TIMEDIFF(NOW(), UTC_TIMESTAMP()) AS diff';

/**
 * MySQL only. A TIMESTAMP column converts through the SESSION time zone, so every connection that reads or writes has to
 * run in UTC. Returns the first offset that is not UTC, or '00:00:00'. Reads only; never changes the session (spec 3.9).
 * It looks at one pooled connection per driver, which is what a pool configured with an init statement gives all of them.
 */
export async function probeSessionTimeDiff(
  drivers: readonly Driver[],
  timeoutMs: number,
): Promise<string> {
  for (const driver of drivers) {
    const rows = await driver.query({ sql: PROBE_SQL, params: [] }, { timeoutMs });
    const raw = rows[0]?.['diff'];
    const diff = typeof raw === 'string' ? raw : '';
    if (!isUtcOffset(diff)) return diff;
  }
  return '00:00:00';
}

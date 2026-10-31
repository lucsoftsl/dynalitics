import type { SqlDialect } from '../dialect/types.js';
import type { Driver } from '../driver/types.js';
import type { TableRef } from '../model/identifiers.js';
import { tableArg } from './compare.js';

export type CredentialKind = 'writer' | 'reader' | 'single';

export interface PrivilegeInput {
  readonly driver: Driver;
  readonly dialect: SqlDialect;
  readonly table: TableRef;
  readonly kind: CredentialKind;
  readonly firstVisitEnabled: boolean;
}
export interface PrivilegeResult {
  readonly privileges: ReadonlySet<string> | undefined;
  readonly warning: string | undefined;
}

const INSPECT_TIMEOUT_MS = 5000;
const NEEDLESS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'ALTER',
  'DROP',
  'CREATE',
  'CONTROL',
  'TAKE OWNERSHIP',
  'SUPERUSER',
  'GRANT OPTION',
  'SUPER',
]);

function expectedFor(kind: CredentialKind, firstVisitEnabled: boolean): ReadonlySet<string> {
  if (kind === 'reader') return new Set(['SELECT']);
  if (kind === 'single') return new Set(['INSERT', 'SELECT']);
  return new Set(firstVisitEnabled ? ['INSERT', 'SELECT'] : ['INSERT']);
}

function wording(kind: CredentialKind, excess: string, table: string, cmd: string): string {
  const list = `(${excess})`;
  if (kind === 'writer') {
    return `The writer credential seems to have more privileges than dynalitics needs ${list}. It only needs INSERT on ${table}. See: ${cmd}`;
  }
  if (kind === 'reader') {
    return `The reader credential seems to be able to change data or structure ${list}. It only needs SELECT on ${table}. See: ${cmd}`;
  }
  return `The credential seems to have more privileges than dynalitics needs ${list}. dynalitics needs INSERT and SELECT on ${table}; use separate writer and reader credentials. See: ${cmd}`;
}

/**
 * Best effort and advisory (spec 7.5): catalog SELECTs only, never throws, never blocks startup. It can miss
 * privileges granted through roles or groups and can be wrong; the wording says "seems" on purpose.
 */
export async function inspectPrivileges(input: PrivilegeInput): Promise<PrivilegeResult> {
  const { driver, dialect, table, kind, firstVisitEnabled } = input;
  try {
    const results = [];
    for (const q of dialect.privilegeSql(table)) {
      results.push(await driver.query(q, { timeoutMs: INSPECT_TIMEOUT_MS }));
    }
    const privileges = dialect.parsePrivileges(results, table);
    const expected = expectedFor(kind, firstVisitEnabled);
    const excess = [...privileges].filter((p) => NEEDLESS.has(p) && !expected.has(p)).sort();
    if (excess.length === 0) return { privileges, warning: undefined };
    const cmd = `npx dynalitics sql --grants-only --dialect ${dialect.name} --table ${tableArg(table)}`;
    return {
      privileges,
      warning: wording(kind, excess.join(', '), dialect.qualifiedTable(table), cmd),
    };
  } catch {
    return { privileges: undefined, warning: undefined };
  }
}

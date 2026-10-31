import { describe, expect, test } from 'vitest';
import { inspectPrivileges } from '../../src/startup/privileges.js';
import { getDialect } from '../../src/dialect/index.js';
import { DriverError, type Driver } from '../../src/driver/types.js';

const table = { schema: 'public', name: 'events' };
const fakeDriver = (answers: Record<string, unknown>[][]): Driver => {
  let i = 0;
  return {
    query: () => Promise.resolve(answers[i++] ?? []),
    isTransient: () => false,
    close: () => Promise.resolve(),
  };
};
const pg = getDialect('postgres');
const my = getDialect('mysql');

describe('privilege warning (best effort, advisory)', () => {
  test('writer with only INSERT: no warning', async () => {
    const r = await inspectPrivileges({
      driver: fakeDriver([[{ privilege: 'INSERT' }], []]),
      dialect: pg,
      table,
      kind: 'writer',
      firstVisitEnabled: false,
    });
    expect(r.warning).toBeUndefined();
  });

  test('writer that can also SELECT/UPDATE/DELETE is warned, with exact wording', async () => {
    const r = await inspectPrivileges({
      driver: fakeDriver([
        [
          { privilege: 'INSERT' },
          { privilege: 'SELECT' },
          { privilege: 'UPDATE' },
          { privilege: 'DELETE' },
        ],
        [],
      ]),
      dialect: pg,
      table,
      kind: 'writer',
      firstVisitEnabled: false,
    });
    expect(r.warning).toBe(
      'The writer credential seems to have more privileges than dynalitics needs (DELETE, SELECT, UPDATE). It only needs INSERT on "public"."events". See: npx dynalitics sql --grants-only --dialect postgres --table public.events',
    );
  });

  test('writer may SELECT when write-time first-visit is enabled', async () => {
    const r = await inspectPrivileges({
      driver: fakeDriver([[{ privilege: 'INSERT' }, { privilege: 'SELECT' }], []]),
      dialect: pg,
      table,
      kind: 'writer',
      firstVisitEnabled: true,
    });
    expect(r.warning).toBeUndefined();
  });

  test('reader that can write is warned', async () => {
    const r = await inspectPrivileges({
      driver: fakeDriver([[{ privilege: 'SELECT' }, { privilege: 'INSERT' }], []]),
      dialect: pg,
      table,
      kind: 'reader',
      firstVisitEnabled: false,
    });
    expect(r.warning).toContain(
      'The reader credential seems to be able to change data or structure (INSERT).',
    );
  });

  test('single credential expects INSERT + SELECT and flags superusers', async () => {
    const ok = await inspectPrivileges({
      driver: fakeDriver([[{ privilege: 'INSERT' }, { privilege: 'SELECT' }], []]),
      dialect: pg,
      table,
      kind: 'single',
      firstVisitEnabled: false,
    });
    expect(ok.warning).toBeUndefined();
    const su = await inspectPrivileges({
      driver: fakeDriver([
        [{ privilege: 'INSERT' }, { privilege: 'SELECT' }],
        [{ privilege: 'SUPERUSER' }],
      ]),
      dialect: pg,
      table,
      kind: 'single',
      firstVisitEnabled: false,
    });
    expect(su.warning).toContain('SUPERUSER');
  });

  test('never throws: a denied catalog query just yields no opinion', async () => {
    const failing: Driver = {
      query: () =>
        Promise.reject(
          new DriverError({ name: 'Error', message: 'permission denied' }, false, false),
        ),
      isTransient: () => false,
      close: () => Promise.resolve(),
    };
    const r = await inspectPrivileges({
      driver: failing,
      dialect: pg,
      table,
      kind: 'writer',
      firstVisitEnabled: false,
    });
    expect(r).toEqual({ privileges: undefined, warning: undefined });
  });

  test('MySQL SHOW GRANTS parsing: global, database and table scope; column grants count as the privilege', async () => {
    const grants = [
      { 'Grants for app@%': 'GRANT USAGE ON *.* TO `app`@`%`' },
      { 'Grants for app@%': 'GRANT INSERT, SELECT (user_id) ON `analytics`.`events` TO `app`@`%`' },
      { 'Grants for app@%': 'GRANT UPDATE ON `analytics`.* TO `app`@`%`' },
      { 'Grants for app@%': 'GRANT DELETE ON `other`.* TO `app`@`%`' },
    ];
    const r = await inspectPrivileges({
      driver: fakeDriver([grants, [{ db: 'analytics' }]]),
      dialect: my,
      table: { name: 'events' },
      kind: 'writer',
      firstVisitEnabled: false,
    });
    expect([...(r.privileges ?? [])].sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(r.warning).toContain('(SELECT, UPDATE)');
  });

  test('MySQL ALL PRIVILEGES and GRANT OPTION', async () => {
    const r = await inspectPrivileges({
      driver: fakeDriver([
        [{ g: 'GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION' }],
        [{ db: 'x' }],
      ]),
      dialect: my,
      table: { schema: 'x', name: 'events' },
      kind: 'single',
      firstVisitEnabled: false,
    });
    expect(r.warning).toContain('GRANT OPTION');
    expect(r.warning).toContain('DROP');
  });
});

import { describe, expect, test } from 'vitest';
import { generateGrants, generateSql } from '../../src/schema/index.js';
import { DynaliticsConfigError } from '../../src/errors.js';

describe('generateSql: PostgreSQL defaults', () => {
  const sql = generateSql({
    dialect: 'postgres',
    schema: { table: 'public.dynalitics_events' },
    grants: {},
  });

  test('CREATE TABLE', () => {
    expect(sql.createTable).toMatchInlineSnapshot(`
      "CREATE TABLE "public"."dynalitics_events" (
        "id"               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "visited_at"       timestamptz NOT NULL,
        "consent"          boolean NOT NULL,
        "page_visited"     varchar(512) NOT NULL,
        "ip_address"       varchar(64),  -- PERSONAL DATA (stored per ip.mode)
        "user_id"          varchar(128),  -- PERSONAL DATA
        "username"         varchar(128),  -- PERSONAL DATA
        "email"            varchar(320),  -- PERSONAL DATA
        "custom"           jsonb  -- declared custom fields; personal ones are NULL without consent
      );"
    `);
  });

  test('indexes', () => {
    expect(sql.indexes).toMatchInlineSnapshot(`
      [
        "CREATE INDEX "dynalitics_events_visited_at_idx" ON "public"."dynalitics_events" ("visited_at", "id");",
        "CREATE INDEX "dynalitics_events_user_id_idx" ON "public"."dynalitics_events" ("user_id", "visited_at") WHERE "user_id" IS NOT NULL;",
        "CREATE INDEX "dynalitics_events_ip_idx" ON "public"."dynalitics_events" ("ip_address", "visited_at") WHERE "ip_address" IS NOT NULL;",
      ]
    `);
  });

  test('grants: writer INSERT only, reader SELECT only, with placeholders', () => {
    expect(sql.grants).toMatchInlineSnapshot(`
      [
        "GRANT USAGE ON SCHEMA "public" TO <writer_role>, <reader_role>;",
        "-- Application (writer): INSERT only. It cannot read anything back.",
        "GRANT INSERT ON "public"."dynalitics_events" TO <writer_role>;",
        "-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.",
        "GRANT SELECT ON "public"."dynalitics_events" TO <reader_role>;",
      ]
    `);
    expect(sql.grants.join('\n')).not.toMatch(/GRANT SELECT .* TO <writer_role>/);
  });

  test('full script has a header and sections, and is printed text only', () => {
    expect(
      sql.full.startsWith('-- dynalitics schema for postgres. Generated, review before running.'),
    ).toBe(true);
    expect(sql.full).toContain('-- Recommended indexes');
    expect(sql.full).toContain('-- Least-privilege grants');
    expect(sql.full.endsWith('\n')).toBe(true);
  });
});

describe('generateSql: MySQL and SQL Server', () => {
  test('MySQL', () => {
    const sql = generateSql({
      dialect: 'mysql',
      schema: { table: 'analytics.events' },
      grants: {},
    });
    expect({ t: sql.createTable, i: sql.indexes, g: sql.grants }).toMatchInlineSnapshot(`
      {
        "g": [
          "-- Application (writer): INSERT only. It cannot read anything back.",
          "GRANT INSERT ON \`analytics\`.\`events\` TO <writer_role>;",
          "-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.",
          "GRANT SELECT ON \`analytics\`.\`events\` TO <reader_role>;",
        ],
        "i": [
          "CREATE INDEX \`events_visited_at_idx\` ON \`analytics\`.\`events\` (\`visited_at\`, \`id\`);",
          "CREATE INDEX \`events_user_id_idx\` ON \`analytics\`.\`events\` (\`user_id\`, \`visited_at\`);",
          "CREATE INDEX \`events_ip_idx\` ON \`analytics\`.\`events\` (\`ip_address\`, \`visited_at\`);",
        ],
        "t": "CREATE TABLE \`analytics\`.\`events\` (
        \`id\`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`visited_at\`       DATETIME(3) NOT NULL,
        \`consent\`          TINYINT(1) NOT NULL,
        \`page_visited\`     VARCHAR(512) NOT NULL,
        \`ip_address\`       VARCHAR(64),  -- PERSONAL DATA (stored per ip.mode)
        \`user_id\`          VARCHAR(128),  -- PERSONAL DATA
        \`username\`         VARCHAR(128),  -- PERSONAL DATA
        \`email\`            VARCHAR(320),  -- PERSONAL DATA
        \`custom\`           JSON,  -- declared custom fields; personal ones are NULL without consent
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;",
      }
    `);
  });
  test('SQL Server', () => {
    const sql = generateSql({ dialect: 'mssql', schema: { table: 'dbo.events' }, grants: {} });
    expect({ t: sql.createTable, i: sql.indexes, g: sql.grants }).toMatchInlineSnapshot(`
      {
        "g": [
          "-- Application (writer): INSERT only. It cannot read anything back.",
          "GRANT INSERT ON OBJECT::[dbo].[events] TO <writer_role>;",
          "-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.",
          "GRANT SELECT ON OBJECT::[dbo].[events] TO <reader_role>;",
        ],
        "i": [
          "CREATE INDEX [events_visited_at_idx] ON [dbo].[events] ([visited_at], [id]);",
          "CREATE INDEX [events_user_id_idx] ON [dbo].[events] ([user_id], [visited_at]) WHERE [user_id] IS NOT NULL;",
          "CREATE INDEX [events_ip_idx] ON [dbo].[events] ([ip_address], [visited_at]) WHERE [ip_address] IS NOT NULL;",
        ],
        "t": "CREATE TABLE [dbo].[events] (
        [id]               BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        [visited_at]       DATETIME2(3) NOT NULL,
        [consent]          BIT NOT NULL,
        [page_visited]     NVARCHAR(512) COLLATE Latin1_General_100_BIN2 NOT NULL,
        [ip_address]       NVARCHAR(64) COLLATE Latin1_General_100_BIN2 NULL,  -- PERSONAL DATA (stored per ip.mode)
        [user_id]          NVARCHAR(128) COLLATE Latin1_General_100_BIN2 NULL,  -- PERSONAL DATA
        [username]         NVARCHAR(128) NULL,  -- PERSONAL DATA
        [email]            NVARCHAR(320) NULL,  -- PERSONAL DATA
        [custom]           NVARCHAR(MAX) NULL CONSTRAINT [CK_events_custom_json] CHECK ([custom] IS NULL OR ISJSON([custom]) = 1)  -- declared custom fields; personal ones are NULL without consent
      );",
      }
    `);
  });
});

describe('generateSql options', () => {
  test('indexes can be turned off and grants are off unless asked for', () => {
    const sql = generateSql({ dialect: 'postgres', schema: { table: 'e' }, indexes: false });
    expect(sql.indexes).toEqual([]);
    expect(sql.grants).toEqual([]);
    expect(sql.full).not.toContain('CREATE INDEX');
  });

  test('firstVisit.enabled adds the column and the writer-side column SELECT', () => {
    const sql = generateSql({
      dialect: 'postgres',
      schema: { table: 'public.e', firstVisit: { enabled: true } },
      grants: {},
    });
    expect(sql.createTable).toContain('"is_first_visit"');
    expect(sql.grants.join('\n')).toContain(
      'GRANT SELECT ("user_id", "ip_address") ON "public"."e" TO <writer_role>;',
    );
  });

  test('renamed, disabled and promoted columns flow through to DDL and indexes', () => {
    const sql = generateSql({
      dialect: 'postgres',
      schema: {
        table: 'e',
        columns: { timestamp: 'created_at', email: false, id: false, ip: false },
        customFields: { locale: { type: 'string', maxLength: 16, personal: false, column: true } },
      },
    });
    expect(sql.createTable).toContain('"created_at"');
    expect(sql.createTable).not.toContain('"email"');
    expect(sql.createTable).toContain('"locale"');
    expect(sql.indexes[0]).toContain('("created_at")');
    expect(sql.indexes.join('\n')).not.toContain('ip_address');
  });

  test('personal columns are marked in comments', () => {
    const sql = generateSql({ dialect: 'mssql', schema: { table: 'e' } });
    for (const col of ['ip_address', 'user_id', 'username', 'email']) {
      const line = sql.createTable.split('\n').find((l) => l.includes(`[${col}]`));
      expect(line).toContain('PERSONAL DATA');
    }
  });

  test('custom role names are validated and quoted, placeholders pass through', () => {
    const sql = generateSql({
      dialect: 'postgres',
      schema: { table: 'public.e' },
      grants: { writerRole: 'app_writer', readerRole: '<reader_role>' },
    });
    expect(sql.grants.join('\n')).toContain('TO "app_writer"');
    expect(sql.grants.join('\n')).toContain('TO <reader_role>');
    const my = generateSql({
      dialect: 'mysql',
      schema: { table: 'd.e' },
      grants: { writerRole: 'w1' },
    });
    expect(my.grants.join('\n')).toContain('TO `w1`@`%`');
  });

  test('refuses injection through role, table and column names', () => {
    expect(() =>
      generateSql({
        dialect: 'postgres',
        schema: { table: 'e' },
        grants: { writerRole: 'x; DROP TABLE e' },
      }),
    ).toThrow(DynaliticsConfigError);
    expect(() =>
      generateSql({ dialect: 'postgres', schema: { table: 'e"; DROP TABLE x;--' } }),
    ).toThrow(DynaliticsConfigError);
    expect(() =>
      generateSql({
        dialect: 'mysql',
        schema: { table: 'e', columns: { email: 'a`; DROP TABLE x;--' } },
      }),
    ).toThrow(DynaliticsConfigError);
  });

  test('rejects cross-database names on PostgreSQL and existing mode', () => {
    expect(() => generateSql({ dialect: 'postgres', schema: { table: 'db.s.t' } })).toThrow(
      /cross-database/,
    );
    expect(() =>
      generateSql({ dialect: 'postgres', schema: { table: 't', tableMode: 'existing' } }),
    ).toThrow(/--grants-only/);
  });

  test('long index names are shortened with a stable hash', () => {
    const name = 'a'.repeat(60);
    const a = generateSql({ dialect: 'postgres', schema: { table: name } }).indexes;
    const b = generateSql({ dialect: 'postgres', schema: { table: name } }).indexes;
    expect(a).toEqual(b);
    for (const stmt of a) {
      const ident = /CREATE INDEX "([^"]+)"/.exec(stmt)?.[1] ?? '';
      expect(ident.length).toBeLessThanOrEqual(63);
    }
    expect(new Set(a.map((s) => /CREATE INDEX "([^"]+)"/.exec(s)?.[1])).size).toBe(a.length);
  });

  test('does not mutate the schema it is given', () => {
    const schema = Object.freeze({
      table: 'public.e',
      columns: Object.freeze({ email: false as const }),
    });
    expect(() => generateSql({ dialect: 'postgres', schema })).not.toThrow();
  });
});

describe('generateGrants (works for any table, prints only)', () => {
  test('table-level grants for an existing table, all dialects', () => {
    expect(generateGrants({ dialect: 'postgres', table: 'public.page_views' }))
      .toMatchInlineSnapshot(`
      [
        "GRANT USAGE ON SCHEMA "public" TO <writer_role>, <reader_role>;",
        "-- Application (writer): INSERT only. It cannot read anything back.",
        "GRANT INSERT ON "public"."page_views" TO <writer_role>;",
        "-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.",
        "GRANT SELECT ON "public"."page_views" TO <reader_role>;",
      ]
    `);
    expect(generateGrants({ dialect: 'mysql', table: 'page_views' })).toMatchInlineSnapshot(`
      [
        "-- No schema given: these grants apply to the current database. Use schema.name to be explicit.",
        "-- Application (writer): INSERT only. It cannot read anything back.",
        "GRANT INSERT ON \`page_views\` TO <writer_role>;",
        "-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.",
        "GRANT SELECT ON \`page_views\` TO <reader_role>;",
      ]
    `);
    expect(
      generateGrants({
        dialect: 'mssql',
        table: 'dbo.page_views',
        writerRole: 'app_writer',
        readerRole: 'app_reader',
        writerSelectColumns: ['account_id'],
      }),
    ).toMatchInlineSnapshot(`
      [
        "-- Application (writer): INSERT only. It cannot read anything back.",
        "GRANT INSERT ON OBJECT::[dbo].[page_views] TO [app_writer];",
        "-- Needed only because firstVisit.enabled is on (write-time detection): column-level SELECT on identity columns.",
        "GRANT SELECT ON OBJECT::[dbo].[page_views] ([account_id]) TO [app_writer];",
        "-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.",
        "GRANT SELECT ON OBJECT::[dbo].[page_views] TO [app_reader];",
      ]
    `);
  });
});

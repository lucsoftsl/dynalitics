import {
  PLACEHOLDER_ROLE,
  UNLIMITED,
  assertJsonKey,
  assertLimit,
  createDialect,
  qualify,
  renderRoleWith,
} from './common.js';
import type { SqlDialect } from './types.js';
import type { ColumnDef } from '../model/types.js';

function columnType(c: ColumnDef): string {
  switch (c.type.kind) {
    case 'id':
      return 'bigint';
    case 'timestamp':
      return 'timestamptz';
    case 'boolean':
      return 'boolean';
    case 'string':
      return `varchar(${c.type.maxLength})`;
    case 'integer':
      return 'bigint';
    case 'number':
      return 'double precision';
    case 'json':
      return 'jsonb';
  }
}

export const postgres: SqlDialect = createDialect({
  name: 'postgres',
  limits: { maxParams: 65_535, maxRowsPerInsert: UNLIMITED, maxIdentifier: 63 },
  open: '"',
  close: '"',
  explicitNull: false,
  read: {
    bucket: (col, interval) =>
      `to_char(date_trunc('${interval}', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')`,
    tsText: (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    isTrue: (col) => `${col} IS TRUE`,
    isFalse: (col) => `${col} IS FALSE`,
    jsonKey: (col, key) => `(${col} ->> '${assertJsonKey(key)}')`,
    // SIMILAR TO, not ~: F-39 allows no '~' outside literals. PostgreSQL has no TRY_CAST.
    jsonNumber: (col, key) => {
      const v = `(${col} ->> '${assertJsonKey(key)}')`;
      return `CASE WHEN ${v} SIMILAR TO '-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?' THEN CAST(${v} AS double precision) END`;
    },
    castText: (col, kind) =>
      kind === 'string'
        ? col
        : kind === 'boolean'
          ? `CASE WHEN ${col} IS TRUE THEN 'true' WHEN ${col} IS FALSE THEN 'false' END`
          : `CAST(${col} AS text)`,
    count: 'COUNT(*)',
    top: () => '',
    limit: (n) => ` LIMIT ${assertLimit(n)}`,
  },
  placeholder: (i) => `$${i}`,
  jsonCast: (ph) => `${ph}::jsonb`,
  timestampParam: (d) => d.toISOString(),
  columnType,
  idDefinition: 'bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
  collation: () => '',
  constraint: () => '',
  tableSuffix: () => '',
  tableConstraints: () => [],
  addColumnKeyword: 'ADD COLUMN',
  dropNotNull: (table, name) => `ALTER TABLE ${table} ALTER COLUMN ${name} DROP NOT NULL;`,
  alterType: (table, name, type) =>
    `ALTER TABLE ${table} ALTER COLUMN ${name} TYPE ${type} USING ${name}::${type};`,
  supportsPartialIndex: true,
  introspectSql: (table) => ({
    sql: `SELECT c.column_name AS name, c.udt_name AS data_type, c.character_maximum_length AS max_length,
       (c.is_nullable = 'YES') AS is_nullable, (c.column_default IS NOT NULL) AS has_default,
       (c.is_identity = 'YES' OR c.is_generated = 'ALWAYS') AS is_generated,
       c.datetime_precision AS dt_precision, t.table_type AS table_type, c.table_schema AS schema_name
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = COALESCE($1::text, current_schema()) AND c.table_name = $2::text
ORDER BY c.ordinal_position`,
    params: [table.schema ?? null, table.name],
  }),
  privilegeSql: (_table, qualified) => [
    {
      sql: `SELECT p AS privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p
WHERE has_table_privilege(current_user, $1::text, p)`,
      params: [qualified],
    },
    {
      sql: `SELECT 'SUPERUSER' AS privilege FROM pg_roles WHERE rolname = current_user AND rolsuper`,
      params: [],
    },
  ],
  parsePrivileges: (results) =>
    new Set(results.flat().map((r) => String(r['privilege']).toUpperCase())),
  grantTarget: (table, q) => qualify(table, q),
  grantSelectColumns: (target, columns, role, q) =>
    `GRANT SELECT (${columns.map(q).join(', ')}) ON ${target} TO ${role};`,
  renderRole: (role, q) => renderRoleWith(role, q),
  grantPreamble: (table, writer, reader, q) =>
    table.schema === undefined
      ? []
      : [`GRANT USAGE ON SCHEMA ${q(table.schema)} TO ${writer}, ${reader};`],
});

export { PLACEHOLDER_ROLE };

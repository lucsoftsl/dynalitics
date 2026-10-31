import { assertJsonKey, assertLimit, createDialect, qualify, renderRoleWith } from './common.js';
import type { SqlDialect } from './types.js';
import type { ColumnDef } from '../model/types.js';

const BIN_COLLATION = 'COLLATE Latin1_General_100_BIN2';

function columnType(c: ColumnDef): string {
  switch (c.type.kind) {
    case 'id':
      return 'BIGINT';
    case 'timestamp':
      return 'DATETIME2(3)';
    case 'boolean':
      return 'BIT';
    case 'string':
      return `NVARCHAR(${c.type.maxLength})`;
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'FLOAT(53)';
    case 'json':
      return 'NVARCHAR(MAX)';
  }
}

export const mssql: SqlDialect = createDialect({
  name: 'mssql',
  limits: { maxParams: 2100, maxRowsPerInsert: 1000, maxIdentifier: 128 },
  open: '[',
  close: ']',
  explicitNull: true,
  read: {
    bucket: (col, interval) => {
      const floor = {
        hour: `DATEADD(hour, DATEDIFF(hour, 0, ${col}), 0)`,
        day: `DATEADD(day, DATEDIFF(day, 0, ${col}), 0)`,
        // 1900-01-01 is a Monday and DATEDIFF(day) ignores DATEFIRST, so weeks never depend on session settings.
        week: `DATEADD(day, (DATEDIFF(day, '19000101', ${col}) / 7) * 7, '19000101')`,
        month: `DATEADD(month, DATEDIFF(month, 0, ${col}), 0)`,
      }[interval];
      return `CONVERT(varchar(23), ${floor}, 126) + 'Z'`;
    },
    tsText: (col) => `CONVERT(varchar(23), ${col}, 126) + 'Z'`,
    isTrue: (col) => `${col} = 1`,
    isFalse: (col) => `${col} = 0`,
    jsonKey: (col, key) => `JSON_VALUE(${col}, '$.${assertJsonKey(key)}')`,
    castText: (col, kind) =>
      kind === 'string'
        ? col
        : kind === 'boolean'
          ? `CASE WHEN ${col} = 1 THEN 'true' WHEN ${col} = 0 THEN 'false' END`
          : `CAST(${col} AS NVARCHAR(4000))`,
    count: 'COUNT_BIG(*)',
    top: (n) => `TOP ${assertLimit(n)} `,
    limit: () => '',
  },
  placeholder: (i) => `@p${i}`,
  timestampParam: (d) => d.toISOString().replace('Z', ''),
  columnType,
  idDefinition: 'BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY',
  collation: (c) =>
    c.role === 'pageVisited' || c.role === 'ip' || c.role === 'userId' ? BIN_COLLATION : '',
  constraint: (c, model) =>
    c.role === 'custom'
      ? `CONSTRAINT [CK_${model.table.name}_custom_json] CHECK ([${c.name}] IS NULL OR ISJSON([${c.name}]) = 1)`
      : '',
  tableSuffix: () => '',
  tableConstraints: () => [],
  addColumnKeyword: 'ADD',
  dropNotNull: (table, name, type) => `ALTER TABLE ${table} ALTER COLUMN ${name} ${type} NULL;`,
  alterType: (table, name, type) => `ALTER TABLE ${table} ALTER COLUMN ${name} ${type} NULL;`,
  supportsPartialIndex: true,
  introspectSql: (table, q) => {
    const catalog = table.database === undefined ? '' : `${q(table.database)}.`;
    return {
      sql: `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS data_type, c.CHARACTER_MAXIMUM_LENGTH AS max_length,
       CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS is_nullable,
       CASE WHEN c.COLUMN_DEFAULT IS NOT NULL THEN 1 ELSE 0 END AS has_default,
       CASE WHEN c.DATA_TYPE = 'timestamp'
              OR COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_CATALOG) + '.' + QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') = 1
              OR COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_CATALOG) + '.' + QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsComputed') = 1
            THEN 1 ELSE 0 END AS is_generated,
       c.DATETIME_PRECISION AS dt_precision, t.TABLE_TYPE AS table_type, c.TABLE_SCHEMA AS schema_name
FROM ${catalog}INFORMATION_SCHEMA.COLUMNS c
JOIN ${catalog}INFORMATION_SCHEMA.TABLES t
  ON t.TABLE_CATALOG = c.TABLE_CATALOG AND t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = COALESCE(@p1, SCHEMA_NAME()) AND c.TABLE_NAME = @p2
ORDER BY c.ORDINAL_POSITION`,
      params: [table.schema ?? null, table.name],
    };
  },
  privilegeSql: (_table, qualified) => [
    {
      sql: `SELECT permission_name AS privilege FROM fn_my_permissions(@p1, 'OBJECT')`,
      params: [qualified],
    },
    {
      sql: `SELECT 'SUPERUSER' AS privilege WHERE IS_SRVROLEMEMBER('sysadmin') = 1 OR IS_MEMBER('db_owner') = 1`,
      params: [],
    },
  ],
  parsePrivileges: (results) =>
    new Set(results.flat().map((r) => String(r['privilege']).toUpperCase())),
  grantTarget: (table, q) => `OBJECT::${qualify(table, q)}`,
  grantSelectColumns: (target, columns, role, q) =>
    `GRANT SELECT ON ${target} (${columns.map(q).join(', ')}) TO ${role};`,
  renderRole: (role, q) => renderRoleWith(role, q),
  grantPreamble: () => [],
});

import {
  UNLIMITED,
  assertJsonKey,
  assertLimit,
  createDialect,
  qualify,
  renderRoleWith,
} from './common.js';
import type { Row, SqlDialect } from './types.js';
import type { ColumnDef } from '../model/types.js';
import type { TableRef } from '../model/identifiers.js';

function columnType(c: ColumnDef): string {
  switch (c.type.kind) {
    case 'id':
      return 'BIGINT UNSIGNED';
    case 'timestamp':
      return 'DATETIME(3)';
    case 'boolean':
      return 'TINYINT(1)';
    case 'string':
      return `VARCHAR(${c.type.maxLength})`;
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'json':
      return 'JSON';
  }
}

const ALL_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'REFERENCES',
  'TRIGGER',
];

/** Best effort: parses `SHOW GRANTS` text for grants that apply to this table. Roles make it heuristic. */
function parseGrants(results: readonly (readonly Row[])[], table: TableRef): ReadonlySet<string> {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const grants = (results[0] ?? []).map((r) => text(Object.values(r)[0]));
  const currentDb = text(results[1]?.[0]?.['db']);
  const db = table.schema ?? currentDb;
  const unescape = (s: string): string => s.replace(/\\([_%])/g, '$1');
  const found = new Set<string>();
  for (const line of grants) {
    const m = /^GRANT (.+?) ON (.+?) TO /.exec(line);
    if (m === null) continue;
    const scope = (m[2] ?? '').replace(/`/g, '');
    const [scopeDb = '', scopeTable = ''] = scope.split('.');
    const applies =
      scope === '*.*' ||
      (unescape(scopeDb) === db && (scopeTable === '*' || scopeTable === table.name));
    if (!applies) continue;
    const privs = (m[1] ?? '')
      .replace(/\([^)]*\)/g, '')
      .split(',')
      .map((p) => p.trim().toUpperCase());
    for (const p of privs) {
      if (p === 'ALL PRIVILEGES' || p === 'ALL') ALL_PRIVILEGES.forEach((x) => found.add(x));
      else if (p !== 'USAGE' && p !== '') found.add(p);
    }
    if (/WITH GRANT OPTION\s*$/.test(line)) found.add('GRANT OPTION');
  }
  return found;
}

export const mysql: SqlDialect = createDialect({
  name: 'mysql',
  limits: { maxParams: 65_535, maxRowsPerInsert: UNLIMITED, maxIdentifier: 64 },
  open: '`',
  close: '`',
  explicitNull: false,
  read: {
    bucket: (col, interval) => {
      switch (interval) {
        case 'hour':
          return `DATE_FORMAT(${col}, '%Y-%m-%dT%H:00:00.000Z')`;
        case 'day':
          return `DATE_FORMAT(${col}, '%Y-%m-%dT00:00:00.000Z')`;
        case 'week':
          return `DATE_FORMAT(DATE_SUB(DATE(${col}), INTERVAL WEEKDAY(${col}) DAY), '%Y-%m-%dT00:00:00.000Z')`;
        case 'month':
          return `DATE_FORMAT(${col}, '%Y-%m-01T00:00:00.000Z')`;
      }
    },
    tsText: (col) =>
      `CONCAT(DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s.'), LPAD(MICROSECOND(${col}) DIV 1000, 3, '0'), 'Z')`,
    isTrue: (col) => `${col} = 1`,
    isFalse: (col) => `${col} = 0`,
    jsonKey: (col, key) => `JSON_UNQUOTE(JSON_EXTRACT(${col}, '$.${assertJsonKey(key)}'))`,
    castText: (col, kind) =>
      kind === 'string'
        ? col
        : kind === 'boolean'
          ? `CASE WHEN ${col} = 1 THEN 'true' WHEN ${col} = 0 THEN 'false' END`
          : `CAST(${col} AS CHAR)`,
    count: 'COUNT(*)',
    top: () => '',
    limit: (n) => ` LIMIT ${assertLimit(n)}`,
  },
  placeholder: () => '?',
  timestampParam: (d) => d.toISOString().replace('T', ' ').replace('Z', ''),
  columnType,
  idDefinition: 'BIGINT UNSIGNED NOT NULL AUTO_INCREMENT',
  collation: () => '',
  constraint: () => '',
  tableSuffix: () => ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
  tableConstraints: (model, q) => {
    const id = model.columns.find((c) => c.role === 'id');
    return id === undefined ? [] : [`PRIMARY KEY (${q(id.name)})`];
  },
  addColumnKeyword: 'ADD COLUMN',
  dropNotNull: (table, name, type) => `ALTER TABLE ${table} MODIFY COLUMN ${name} ${type} NULL;`,
  alterType: (table, name, type) => `ALTER TABLE ${table} MODIFY COLUMN ${name} ${type};`,
  supportsPartialIndex: false,
  introspectSql: (table) => ({
    sql: `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS data_type, c.CHARACTER_MAXIMUM_LENGTH AS max_length,
       (c.IS_NULLABLE = 'YES') AS is_nullable, (c.COLUMN_DEFAULT IS NOT NULL) AS has_default,
       (c.EXTRA LIKE '%auto_increment%' OR c.EXTRA LIKE '%GENERATED%') AS is_generated,
       c.DATETIME_PRECISION AS dt_precision, t.TABLE_TYPE AS table_type, c.TABLE_SCHEMA AS schema_name
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND c.TABLE_NAME = ?
ORDER BY c.ORDINAL_POSITION`,
    params: [table.schema ?? null, table.name],
  }),
  privilegeSql: () => [
    { sql: 'SHOW GRANTS FOR CURRENT_USER()', params: [] },
    { sql: 'SELECT DATABASE() AS db', params: [] },
  ],
  parsePrivileges: (results, table) => parseGrants(results, table),
  grantTarget: (table, q) => (table.schema === undefined ? q(table.name) : qualify(table, q)),
  grantSelectColumns: (target, columns, role, q) =>
    `GRANT SELECT (${columns.map(q).join(', ')}) ON ${target} TO ${role};`,
  renderRole: (role, q) => renderRoleWith(role, (name) => `${q(name)}@\`%\``),
  grantPreamble: (table) =>
    table.schema === undefined
      ? [
          '-- No schema given: these grants apply to the current database. Use schema.name to be explicit.',
        ]
      : [],
});

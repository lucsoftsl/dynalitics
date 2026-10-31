import { createHash } from 'node:crypto';
import { DynaliticsConfigError } from '../errors.js';
import {
  assertIdentifier,
  isCustomKey,
  isIdentifier,
  type TableRef,
} from '../model/identifiers.js';
import { isIntegerColumn } from '../model/physical.js';
import type { ColumnDef, ColumnModel, Dialect, SqlValue } from '../model/types.js';
import type {
  ColumnInfo,
  CompiledQuery,
  GrantOptions,
  ReadSyntax,
  Row,
  SqlDialect,
} from './types.js';

export const PLACEHOLDER_ROLE = /^<[a-z_]+>$/;
const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** Everything that differs between dialects. The generic builder below turns this into a SqlDialect. */
export interface DialectSyntax {
  readonly name: Dialect;
  readonly limits: SqlDialect['limits'];
  readonly open: string;
  readonly close: string;
  readonly explicitNull: boolean;
  readonly read: ReadSyntax;
  placeholder(index: number): string;
  jsonCast?(placeholder: string): string;
  timestampParam(d: Date): string;
  columnType(c: ColumnDef): string;
  /** Full definition for the id column, constraints included. */
  idDefinition: string;
  /** Collation clause that goes right after the type ('' if none). */
  collation(c: ColumnDef): string;
  /** Constraint that goes after nullability, e.g. SQL Server's ISJSON check ('' if none). */
  constraint(c: ColumnDef, model: ColumnModel): string;
  tableSuffix(): string;
  tableConstraints(model: ColumnModel, quote: (n: string) => string): readonly string[];
  addColumnKeyword: string;
  dropNotNull(table: string, name: string, type: string): string;
  alterType(table: string, name: string, type: string): string;
  supportsPartialIndex: boolean;
  introspectSql(table: TableRef, q: (n: string) => string): CompiledQuery;
  privilegeSql(table: TableRef, qualified: string): readonly CompiledQuery[];
  parsePrivileges(results: readonly (readonly Row[])[], table: TableRef): ReadonlySet<string>;
  grantTarget(table: TableRef, q: (n: string) => string): string;
  grantSelectColumns(
    target: string,
    columns: readonly string[],
    role: string,
    q: (n: string) => string,
  ): string;
  renderRole(role: string, q: (n: string) => string): string;
  grantPreamble(
    table: TableRef,
    writer: string,
    reader: string,
    q: (n: string) => string,
  ): readonly string[];
}

const toBool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 't' || v === 'YES';
const toNum = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

function describeComment(c: ColumnDef): string {
  if (c.role === 'isFirstVisit')
    return '-- derived from personal identifiers; NULL without consent';
  if (c.role === 'custom')
    return '-- declared custom fields; personal ones are NULL without consent';
  if (c.role === 'ip') return '-- PERSONAL DATA (stored per ip.mode)';
  return c.personal ? '-- PERSONAL DATA' : '';
}

export function indexName(table: string, suffix: string, max: number): string {
  const full = `${table}_${suffix}`;
  if (full.length <= max) return full;
  const digest = createHash('sha1').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, max - 9)}_${digest}`;
}

interface IndexSpec {
  readonly suffix: string;
  readonly columns: readonly string[];
  readonly whereNotNull?: string;
}

/** Recommended indexes (spec 6.3): range scans, and the "any earlier row?" probes of read-time first-visit. */
export function indexSpecs(model: ColumnModel): readonly IndexSpec[] {
  const ts = model.columns.find((c) => c.role === 'timestamp');
  const id = model.columns.find((c) => c.role === 'id');
  if (ts === undefined) return [];
  const specs: IndexSpec[] = [
    { suffix: 'visited_at_idx', columns: id === undefined ? [ts.name] : [ts.name, id.name] },
  ];
  const { userId, ip } = model.identity;
  if (userId !== undefined) {
    specs.push({
      suffix: 'user_id_idx',
      columns: [userId.name, ts.name],
      whereNotNull: userId.name,
    });
  }
  if (ip !== undefined)
    specs.push({ suffix: 'ip_idx', columns: [ip.name, ts.name], whereNotNull: ip.name });
  return specs;
}

export const qualify = (t: TableRef, q: (n: string) => string): string =>
  [t.database, t.schema, t.name]
    .filter((p): p is string => p !== undefined)
    .map(q)
    .join('.');

export function createDialect(s: DialectSyntax): SqlDialect {
  const quoteIdent = (name: string): string => {
    assertIdentifier(name, 'identifier');
    return `${s.open}${name}${s.close}`;
  };
  const qualifiedTable = (t: TableRef): string =>
    [t.database, t.schema, t.name]
      .filter((p): p is string => p !== undefined)
      .map(quoteIdent)
      .join('.');
  const columnType = (c: ColumnDef): string => s.columnType(c);

  const columnDefinition = (c: ColumnDef, model: ColumnModel): string => {
    if (c.type.kind === 'id') return s.idDefinition;
    const nullPart = c.nullable ? (s.explicitNull ? 'NULL' : '') : 'NOT NULL';
    return [`${columnType(c)} ${s.collation(c)}`.trim(), nullPart, s.constraint(c, model)]
      .filter((part) => part !== '')
      .join(' ');
  };

  return {
    name: s.name,
    limits: s.limits,
    quoteIdent,
    qualifiedTable,
    read: s.read,
    placeholder: (i) => s.placeholder(i),
    columnType,
    timestampParam: (d) => s.timestampParam(d),

    buildInsert(model, rows): CompiledQuery {
      const cols = model.insertColumns;
      const params: SqlValue[] = [];
      const tuples = rows.map((row) => {
        if (row.length !== cols.length) {
          throw new Error(`expected ${cols.length} values per row, got ${row.length}`);
        }
        const phs = row.map((value, idx) => {
          // A boolean headed for a real integer column (tinyint(1), smallint) is bound as 1/0.
          const target = cols[idx];
          params.push(
            typeof value === 'boolean' && target?.type.kind === 'boolean' && isIntegerColumn(target)
              ? value
                ? 1
                : 0
              : value,
          );
          const ph = s.placeholder(params.length);
          return cols[idx]?.type.kind === 'json' && s.jsonCast !== undefined ? s.jsonCast(ph) : ph;
        });
        return `(${phs.join(', ')})`;
      });
      return {
        sql: `INSERT INTO ${qualifiedTable(model.table)} (${cols.map((c) => quoteIdent(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`,
        params,
      };
    },

    firstVisitLookup(model, kind, values): CompiledQuery {
      const col = kind === 'u' ? model.identity.userId : model.identity.ip;
      if (col === undefined) throw new Error('identity column is not mapped');
      const phs = values.map((_, i) => s.placeholder(i + 1)).join(', ');
      const userCol = model.identity.userId;
      const extra =
        kind === 'i' && userCol !== undefined ? ` AND ${quoteIdent(userCol.name)} IS NULL` : '';
      return {
        sql: `SELECT DISTINCT ${quoteIdent(col.name)} AS v FROM ${qualifiedTable(model.table)} WHERE ${quoteIdent(col.name)} IN (${phs})${extra}`,
        params: [...values],
      };
    },

    introspectSql: (t) => s.introspectSql(t, quoteIdent),

    mapColumnRow(row): ColumnInfo {
      const maxLength = toNum(row['max_length']);
      return {
        name: String(row['name']),
        dataType: String(row['data_type']).toLowerCase(),
        maxLength,
        nullable: toBool(row['is_nullable']),
        hasDefault: toBool(row['has_default']),
        generated: toBool(row['is_generated']),
        precision: toNum(row['dt_precision']),
        tableType: typeof row['table_type'] === 'string' ? row['table_type'] : 'BASE TABLE',
        ...(typeof row['schema_name'] === 'string' ? { schema: row['schema_name'] } : {}),
      };
    },

    privilegeSql: (t) => s.privilegeSql(t, qualifiedTable(t)),
    parsePrivileges: (results, t) => s.parsePrivileges(results, t),

    createTableSql(model): string {
      const lines = model.columns.map((c) => ({
        text: `${quoteIdent(c.name).padEnd(18)} ${columnDefinition(c, model)}`,
        comment: describeComment(c),
      }));
      const constraints = s.tableConstraints(model, quoteIdent);
      const all = [...lines, ...constraints.map((text) => ({ text, comment: '' }))];
      const body = all
        .map(
          (l, i) =>
            `  ${l.text}${i < all.length - 1 ? ',' : ''}${l.comment === '' ? '' : `  ${l.comment}`}`,
        )
        .join('\n');
      return `CREATE TABLE ${qualifiedTable(model.table)} (\n${body}\n)${s.tableSuffix()};`;
    },

    createIndexSql(model): readonly string[] {
      const table = qualifiedTable(model.table);
      return indexSpecs(model).map((spec) => {
        const name = quoteIdent(indexName(model.table.name, spec.suffix, s.limits.maxIdentifier));
        const where =
          spec.whereNotNull !== undefined && s.supportsPartialIndex
            ? ` WHERE ${quoteIdent(spec.whereNotNull)} IS NOT NULL`
            : '';
        return `CREATE INDEX ${name} ON ${table} (${spec.columns.map(quoteIdent).join(', ')})${where};`;
      });
    },

    grantSql(opts: GrantOptions): readonly string[] {
      const writer = s.renderRole(opts.writerRole, quoteIdent);
      const reader = s.renderRole(opts.readerRole, quoteIdent);
      const target = s.grantTarget(opts.table, quoteIdent);
      const out = [...s.grantPreamble(opts.table, writer, reader, quoteIdent)];
      out.push('-- Application (writer): INSERT only. It cannot read anything back.');
      out.push(`GRANT INSERT ON ${target} TO ${writer};`);
      if (opts.writerSelectColumns !== undefined && opts.writerSelectColumns.length > 0) {
        out.push(
          '-- Needed only because firstVisit.enabled is on (write-time detection): column-level SELECT on identity columns.',
        );
        out.push(s.grantSelectColumns(target, opts.writerSelectColumns, writer, quoteIdent));
      }
      out.push(
        '-- Dashboard (reader): SELECT only. This role can see PERSONAL DATA columns; protect it accordingly.',
      );
      out.push(`GRANT SELECT ON ${target} TO ${reader};`);
      return out;
    },

    addColumnSql: (t, c) =>
      `ALTER TABLE ${qualifiedTable(t)} ${s.addColumnKeyword} ${quoteIdent(c.name)} ${columnType(c)};`,
    dropNotNullSql: (t, c) => s.dropNotNull(qualifiedTable(t), quoteIdent(c.name), columnType(c)),
    alterTypeSql: (t, c) => s.alterType(qualifiedTable(t), quoteIdent(c.name), columnType(c)),
    renderRole: (role) => s.renderRole(role, quoteIdent),
  };
}

/** Shared role rendering: placeholders like <writer_role> pass through, real names must be valid identifiers. */
export function renderRoleWith(role: string, wrap: (name: string) => string): string {
  if (PLACEHOLDER_ROLE.test(role)) return role;
  if (!isIdentifier(role)) {
    throw new DynaliticsConfigError([
      `Role ${JSON.stringify(role)} is not supported. Use letters, digits and underscore (max 63), or leave the <placeholder>.`,
    ]);
  }
  return wrap(role);
}

export { UNLIMITED };

/** Guards for the few non-identifier values that are inlined into read SQL. */
export function assertLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 100_000)
    throw new Error('limit must be a positive integer');
  return n;
}
export function assertJsonKey(key: string): string {
  if (!isCustomKey(key)) throw new Error('invalid custom field key');
  return key;
}

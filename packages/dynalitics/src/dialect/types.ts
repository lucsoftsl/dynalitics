import type { Interval } from '../protocol.js';
import type { TableRef } from '../model/identifiers.js';
import type { ColumnDef, ColumnModel, Dialect, SqlValue } from '../model/types.js';

export interface CompiledQuery {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export type Row = Readonly<Record<string, unknown>>;

/** Normalised catalog row, identical across dialects. */
export interface ColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly maxLength: number | null;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly precision: number | null;
  readonly tableType: string;
  /** The schema (database for MySQL) the catalog found the table in; used to qualify names from then on. */
  readonly schema?: string;
}

export interface GrantOptions {
  readonly table: TableRef;
  readonly writerRole: string;
  readonly readerRole: string;
  /** Column-level SELECT for the writer, only needed for write-time first-visit detection. */
  readonly writerSelectColumns?: readonly string[];
}

/** SQL fragments used by the read API. Inputs that are not column names are validated before use. */
export interface ReadSyntax {
  /** UTC start of the bucket as ISO text, e.g. 2026-10-25T00:00:00.000Z. Weeks start on Monday, independent of session settings. */
  bucket(col: string, interval: Interval): string;
  /** An exact instant as ISO text (ms precision, UTC). */
  tsText(col: string): string;
  isTrue(col: string): string;
  /** True only for a non-NULL false value. */
  isFalse(col: string): string;
  /** Text value of a JSON key. `key` must match the custom key pattern; it comes from host config, never from a request. */
  jsonKey(col: string, key: string): string;
  castText(col: string, kind: 'string' | 'integer' | 'number' | 'boolean'): string;
  /** Row count that cannot overflow: COUNT_BIG(*) on SQL Server (COUNT is a 32-bit int there). */
  readonly count: string;
  /** `TOP n ` for SQL Server, '' otherwise. n must be a positive integer. */
  top(n: number): string;
  /** ` LIMIT n` for PostgreSQL and MySQL, '' for SQL Server. */
  limit(n: number): string;
}

/** Pure SQL text generation. No driver imports, no I/O. */
export interface SqlDialect {
  readonly name: Dialect;
  readonly limits: {
    readonly maxParams: number;
    readonly maxRowsPerInsert: number;
    readonly maxIdentifier: number;
  };
  quoteIdent(name: string): string;
  qualifiedTable(table: TableRef): string;
  placeholder(index: number): string;
  columnType(c: ColumnDef): string;
  timestampParam(d: Date): string;
  buildInsert(model: ColumnModel, rows: readonly (readonly SqlValue[])[]): CompiledQuery;
  firstVisitLookup(model: ColumnModel, kind: 'u' | 'i', values: readonly string[]): CompiledQuery;
  introspectSql(table: TableRef): CompiledQuery;
  mapColumnRow(row: Row): ColumnInfo;
  privilegeSql(table: TableRef): readonly CompiledQuery[];
  parsePrivileges(results: readonly (readonly Row[])[], table: TableRef): ReadonlySet<string>;
  createTableSql(model: ColumnModel): string;
  createIndexSql(model: ColumnModel): readonly string[];
  grantSql(opts: GrantOptions): readonly string[];
  addColumnSql(table: TableRef, c: ColumnDef): string;
  dropNotNullSql(table: TableRef, c: ColumnDef): string;
  alterTypeSql(table: TableRef, c: ColumnDef): string;
  readonly read: ReadSyntax;
  /** Renders a role/user for GRANT: placeholders pass through, real names are validated and quoted. */
  renderRole(role: string): string;
}

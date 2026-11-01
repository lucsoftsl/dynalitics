import type { TableRef } from './identifiers.js';

export type Dialect = 'postgres' | 'mysql' | 'mssql';
export type IpMode = 'raw' | 'hash' | 'truncate';
export type SqlValue = string | number | boolean | null;
export type CustomValue = string | number | boolean | null;
export type ScalarType = 'string' | 'integer' | 'number' | 'boolean';

export type Role =
  | 'timestamp'
  | 'consent'
  | 'pageVisited'
  | 'ip'
  | 'userId'
  | 'username'
  | 'email'
  | 'custom'
  | 'isFirstVisit'
  | 'id'
  | 'status'
  | 'errorReason';

export type LogicalType =
  | { readonly kind: 'id' }
  | { readonly kind: 'timestamp' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'string'; readonly maxLength: number }
  | { readonly kind: 'integer' }
  | { readonly kind: 'number' }
  | { readonly kind: 'json' };

export interface ColumnDef {
  readonly role: Role | 'promoted' | 'extra';
  /** Role name, custom field name, or extra column name. */
  readonly key: string;
  /** Physical column name, already validated against the identifier pattern. */
  readonly name: string;
  readonly type: LogicalType;
  readonly nullable: boolean;
  /** Drives consent stripping, SQL comments and grant comments. */
  readonly personal: boolean;
  /** True only for `id`: never inserted. */
  readonly dbGenerated: boolean;
  /** The real database type, lower-case (`timestamptz`, `int2`, ...). Set after the catalog was read (startup), never from config. */
  readonly physicalType?: string;
}

export interface CustomFieldDef {
  type: ScalarType;
  maxLength?: number;
  personal?: boolean;
  column?: true | string;
  breakdown?: boolean;
  /** Keep this (non-personal) field on rows where consent was denied. Default false: denied rows store nothing else. */
  keepWhenDenied?: boolean;
}

export interface ResolvedCustomField {
  readonly key: string;
  readonly type: ScalarType;
  readonly maxLength: number;
  readonly personal: boolean;
  readonly breakdown: boolean;
  readonly keepWhenDenied: boolean;
  /** Present when the field is promoted to its own column. */
  readonly column?: ColumnDef;
}

/** The part of the config that decides table shape. No secrets, no functions: safe to read from JSON. */
export interface SchemaConfig {
  table: string | { database?: string; schema?: string; name: string };
  tableMode?: 'recommended' | 'existing';
  /** A column name, `true` for the default name (needed to opt in to `status` / `errorReason`), or `false`. */
  columns?: Partial<Record<Role, string | boolean>>;
  customFields?: Record<string, CustomFieldDef>;
  page?: { maxLength?: number };
  firstVisit?: { enabled?: boolean };
}

export interface ColumnModel {
  readonly table: TableRef;
  readonly mode: 'recommended' | 'existing';
  /** Mapped columns, in DDL order. */
  readonly columns: readonly ColumnDef[];
  /** `columns` minus database-generated ones, in insert order. */
  readonly insertColumns: readonly ColumnDef[];
  /** Optional roles that are not stored; drives the startup info log. */
  readonly unmappedRoles: readonly Role[];
  readonly customFields: ReadonlyMap<string, ResolvedCustomField>;
  readonly identity: { readonly userId?: ColumnDef; readonly ip?: ColumnDef };
  readonly firstVisitEnabled: boolean;
}

export const OPTIONAL_STORED_ROLES: readonly Role[] = [
  'ip',
  'userId',
  'username',
  'email',
  'custom',
  'id',
];

/** Roles that are not part of the recommended table unless the config opts in (`columns.status: true`). */
export const OPT_IN_ROLES: readonly Role[] = ['status', 'errorReason'];

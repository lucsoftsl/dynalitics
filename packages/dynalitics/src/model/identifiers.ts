import { DynaliticsConfigError } from '../errors.js';

/** The ONLY way identifiers (table, schema, column names) enter SQL. Quoting is added on top as defence in depth. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const CUSTOM_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export interface TableRef {
  readonly database?: string;
  readonly schema?: string;
  readonly name: string;
}

export function isIdentifier(name: unknown): name is string {
  return typeof name === 'string' && IDENTIFIER.test(name);
}

export function isCustomKey(name: unknown): name is string {
  return typeof name === 'string' && CUSTOM_KEY.test(name) && !FORBIDDEN_KEYS.has(name);
}

export function identifierMessage(name: string, what: string): string {
  return `Identifier ${JSON.stringify(name)} (${what}) is not supported. Allowed: letters, digits and underscore, starting with a letter or underscore, at most 63 characters. Create a view or rename the object.`;
}

export function assertIdentifier(name: string, what: string): string {
  if (!isIdentifier(name)) throw new DynaliticsConfigError([identifierMessage(name, what)]);
  return name;
}

export function assertCustomKey(key: string): string {
  if (!isCustomKey(key)) {
    throw new DynaliticsConfigError([
      `${JSON.stringify(key)} is not a valid custom field key. Allowed: ^[A-Za-z_][A-Za-z0-9_]{0,63}$ (not __proto__, constructor or prototype).`,
    ]);
  }
  return key;
}

/** Parses 'name', 'schema.name', 'db.schema.name' or an object into a validated TableRef. */
export function parseTableRef(
  input: string | { database?: string; schema?: string; name: string },
): TableRef {
  const parts: { database?: string; schema?: string; name: string } =
    typeof input === 'string' ? splitTableString(input) : input;
  const checked = (value: string, what: string): string => assertIdentifier(value, what);
  return {
    ...(parts.database === undefined
      ? {}
      : { database: checked(parts.database, 'table database') }),
    ...(parts.schema === undefined ? {} : { schema: checked(parts.schema, 'table schema') }),
    name: checked(parts.name, 'table name'),
  };
}

function splitTableString(input: string): { database?: string; schema?: string; name: string } {
  const segments = input.split('.');
  if (segments.length > 3) {
    throw new DynaliticsConfigError(['Table name has at most 3 parts: database.schema.name.']);
  }
  const [a = '', b, c] = segments;
  if (segments.length === 1) return { name: a };
  if (segments.length === 2) return { schema: a, name: b ?? '' };
  return { database: a, schema: b ?? '', name: c ?? '' };
}

/** Dialect-specific restrictions on table references (spec 3.7). */
export function assertTableForDialect(
  ref: TableRef,
  dialect: 'postgres' | 'mysql' | 'mssql',
): void {
  if (ref.database !== undefined && dialect !== 'mssql') {
    throw new DynaliticsConfigError([
      dialect === 'postgres'
        ? 'PostgreSQL tables are addressed as name or schema.name; cross-database names do not exist.'
        : 'MySQL tables are addressed as name or schema.name, where "schema" means the database.',
    ]);
  }
}

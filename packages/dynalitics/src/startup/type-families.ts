import type { ColumnInfo } from '../dialect/types.js';
import type { ColumnDef, Dialect } from '../model/types.js';

export type WarnCode =
  | 'naive_timestamp'
  | 'low_precision_timestamp'
  | 'json_unindexable'
  | 'non_unicode_column'
  | 'case_insensitive_identity';
type Kind = Exclude<ColumnDef['type']['kind'], never>;

interface Family {
  readonly ok: readonly string[];
  readonly warn?: Readonly<Record<string, WarnCode>>;
}

const INTS = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'];

/** The compatibility table of spec 7.2, restricted to the roles that exist in recommended mode. */
const FAMILIES: Readonly<Record<Dialect, Readonly<Record<Kind, Family>>>> = {
  postgres: {
    id: { ok: ['int2', 'int4', 'int8'] },
    timestamp: { ok: ['timestamptz'], warn: { timestamp: 'naive_timestamp' } },
    boolean: { ok: ['bool', 'int2', 'int4', 'int8'] },
    string: { ok: ['varchar', 'text'] },
    integer: { ok: ['int2', 'int4', 'int8'] },
    number: { ok: ['float8', 'float4', 'numeric'] },
    json: { ok: ['jsonb'], warn: { json: 'json_unindexable' } },
  },
  mysql: {
    id: { ok: INTS },
    timestamp: { ok: ['datetime', 'timestamp'] },
    boolean: { ok: ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'bit'] },
    string: { ok: ['varchar', 'tinytext', 'text', 'mediumtext', 'longtext'] },
    integer: { ok: INTS },
    number: { ok: ['double', 'float', 'decimal'] },
    json: { ok: ['json'] },
  },
  mssql: {
    id: { ok: INTS },
    timestamp: {
      ok: ['datetime2', 'datetimeoffset'],
      warn: { datetime: 'low_precision_timestamp', smalldatetime: 'low_precision_timestamp' },
    },
    boolean: { ok: ['bit', 'tinyint', 'smallint', 'int', 'bigint'] },
    string: { ok: ['nvarchar'], warn: { varchar: 'non_unicode_column' } },
    integer: { ok: INTS },
    number: { ok: ['float', 'real', 'decimal', 'numeric'] },
    json: { ok: ['nvarchar'] },
  },
};

export interface TypeCheck {
  readonly ok: boolean;
  readonly accepted: readonly string[];
  readonly warn?: WarnCode;
}

export function checkType(dialect: Dialect, def: ColumnDef, info: ColumnInfo): TypeCheck {
  const family = FAMILIES[dialect][def.type.kind];
  const accepted = [...family.ok, ...Object.keys(family.warn ?? {})];
  const type = info.dataType;
  // citext compares case-insensitively: fine for text, but it changes what "the same visitor" means.
  if (dialect === 'postgres' && type === 'citext' && (def.role === 'ip' || def.role === 'userId')) {
    return { ok: true, accepted, warn: 'case_insensitive_identity' };
  }
  // SQL Server JSON lives in NVARCHAR(MAX); a bounded nvarchar would silently truncate documents.
  if (
    dialect === 'mssql' &&
    def.type.kind === 'json' &&
    type === 'nvarchar' &&
    info.maxLength !== -1
  ) {
    return { ok: false, accepted: ['nvarchar(max)'] };
  }
  if (family.ok.includes(type)) return { ok: true, accepted };
  const warn = family.warn?.[type];
  return warn === undefined ? { ok: false, accepted } : { ok: true, accepted, warn };
}

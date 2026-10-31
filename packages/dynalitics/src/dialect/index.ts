import type { Dialect } from '../model/types.js';
import { mssql } from './mssql.js';
import { mysql } from './mysql.js';
import { postgres } from './postgres.js';
import type { SqlDialect } from './types.js';

const DIALECTS: Readonly<Record<Dialect, SqlDialect>> = { postgres, mysql, mssql };

export function getDialect(name: Dialect): SqlDialect {
  return DIALECTS[name];
}

export type { SqlDialect, CompiledQuery, ColumnInfo, Row, GrantOptions } from './types.js';

import type { ColumnInfo } from '../../src/dialect/types.js';
import type { ColumnModel, ColumnDef, Dialect } from '../../src/model/types.js';

/** What the catalog would report for a table that exactly matches the model. */
export function perfectColumns(dialect: Dialect, model: ColumnModel): ColumnInfo[] {
  return model.columns.map((c) => infoFor(dialect, c));
}

export function infoFor(dialect: Dialect, c: ColumnDef): ColumnInfo {
  const base = {
    name: c.name,
    nullable: c.nullable,
    hasDefault: false,
    generated: c.dbGenerated,
    precision: null as number | null,
    tableType: 'BASE TABLE',
  };
  const t = c.type;
  const pick = <T>(pg: T, my: T, ms: T): T =>
    dialect === 'postgres' ? pg : dialect === 'mysql' ? my : ms;
  switch (t.kind) {
    case 'id':
      return { ...base, dataType: pick('int8', 'bigint', 'bigint'), maxLength: null };
    case 'timestamp':
      return {
        ...base,
        dataType: pick('timestamptz', 'datetime', 'datetime2'),
        maxLength: null,
        precision: dialect === 'postgres' ? 6 : 3,
      };
    case 'boolean':
      return { ...base, dataType: pick('bool', 'tinyint', 'bit'), maxLength: null };
    case 'string':
      return { ...base, dataType: pick('varchar', 'varchar', 'nvarchar'), maxLength: t.maxLength };
    case 'integer':
      return { ...base, dataType: pick('int8', 'bigint', 'bigint'), maxLength: null };
    case 'number':
      return { ...base, dataType: pick('float8', 'double', 'float'), maxLength: null };
    case 'json':
      return {
        ...base,
        dataType: pick('jsonb', 'json', 'nvarchar'),
        maxLength: dialect === 'mssql' ? -1 : null,
      };
  }
}

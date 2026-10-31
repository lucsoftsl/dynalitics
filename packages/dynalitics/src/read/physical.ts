import { isIntegerColumn } from '../model/physical.js';
import type { ColumnDef, Dialect } from '../model/types.js';

/**
 * Read-side expressions that depend on the REAL column type of a table somebody else created (spec 3.9, 7.2).
 * `expr` is an already quoted column reference or alias; the result is another SQL expression over it.
 * Filters and ordering keep using the raw column so that existing indexes still apply.
 */

/** An expression whose value is the visit instant, so that the dialect's UTC formatting is correct for it. */
export function instantExpr(dialect: Dialect, def: ColumnDef | undefined, expr: string): string {
  const type = def?.physicalType;
  // A naive PostgreSQL timestamp holds the UTC wall clock: say so, so that the later `AT TIME ZONE 'UTC'` is a no-op shift.
  if (dialect === 'postgres' && type === 'timestamp') return `(${expr} AT TIME ZONE 'UTC')`;
  // datetimeoffset keeps its own offset; CONVERT(..., 126) would print it, so move it to UTC first.
  if (dialect === 'mssql' && type === 'datetimeoffset') {
    return `CAST(SWITCHOFFSET(${expr}, '+00:00') AS datetime2)`;
  }
  return expr;
}

/** An expression that the dialect's `isTrue/isFalse` can test. PostgreSQL cannot say `smallint IS TRUE`. */
export function truthExpr(dialect: Dialect, def: ColumnDef | undefined, expr: string): string {
  return dialect === 'postgres' && isIntegerColumn(def) ? `(${expr} = 1)` : expr;
}

import type { ColumnInfo, SqlDialect } from '../dialect/types.js';
import type { SchemaProblem, SchemaWarning } from '../errors.js';
import type { TableRef } from '../model/identifiers.js';
import type { ColumnDef, ColumnModel } from '../model/types.js';
import { isUtcOffset } from './session-timezone.js';
import { checkType, type WarnCode } from './type-families.js';

export interface CompareInput {
  readonly model: ColumnModel;
  readonly dialect: SqlDialect;
  /** MySQL only: `TIMEDIFF(NOW(), UTC_TIMESTAMP())` of the connection (for example '00:00:00'). Needed for TIMESTAMP columns. */
  readonly sessionTimeDiff?: string;
  /** Catalog rows for the table; empty means "not found". */
  readonly columns: readonly ColumnInfo[];
}
export interface CompareResult {
  readonly problems: readonly SchemaProblem[];
  readonly warnings: readonly SchemaWarning[];
}

const MAX_LISTED_COLUMNS = 30;

export const tableArg = (t: TableRef): string =>
  [t.database, t.schema, t.name].filter(Boolean).join('.');

const label = (c: ColumnDef): string =>
  c.role === 'promoted' ? `Custom field "${c.key}"` : `Role "${c.key}"`;

const WARN_TEXT: Readonly<Record<WarnCode, (col: string, info: ColumnInfo) => string>> = {
  naive_timestamp: (col) =>
    `Column "${col}" has no time zone. dynalitics writes and reads it as UTC. If other code writes local times into it, the dashboard will show shifted data.`,
  low_precision_timestamp: (col, info) =>
    `Column "${col}" has coarse precision (${info.dataType}); visit times will be rounded.`,
  json_unindexable: (col) =>
    `Column "${col}" is json: it cannot be indexed or compared efficiently; prefer jsonb.`,
  non_unicode_column: (col) =>
    `Column "${col}" is varchar: it cannot store every Unicode character, so values with emoji or other characters may be altered or fail.`,
  case_insensitive_identity: (col) =>
    `Column "${col}" compares case-insensitively, so ids differing only by case (for example "U_42" and "u_42") are treated as one visitor in new-vs-returning.`,
};

/** '02:00:00' -> '+02:00', '-05:30:00' -> '-05:30', '00:00:00' -> '+00:00'. */
export function offsetOf(timeDiff: string): string {
  const m = /^(-?)(\d{1,3}):(\d{2})/.exec(timeDiff.trim());
  if (m === null) return timeDiff;
  return `${m[1] === '-' ? '-' : '+'}${(m[2] ?? '0').padStart(2, '0')}:${m[3] ?? '00'}`;
}

function timestampWarnings(
  def: ColumnDef,
  info: ColumnInfo,
  dialect: SqlDialect,
  existing: boolean,
  verdictWarn: WarnCode | undefined,
): WarnCode[] {
  if (def.type.kind !== 'timestamp') return verdictWarn === undefined ? [] : [verdictWarn];
  const out: WarnCode[] = verdictWarn === undefined ? [] : [verdictWarn];
  if (
    verdictWarn === undefined &&
    dialect.name !== 'postgres' &&
    info.precision !== null &&
    info.precision < 3
  ) {
    out.push('low_precision_timestamp');
  }
  // The recommended table is written by us in UTC; a table somebody else wrote is the one that can be shifted.
  const naive =
    (dialect.name === 'mysql' && info.dataType === 'datetime') ||
    (dialect.name === 'mssql' && info.dataType === 'datetime2');
  if (existing && naive) out.push('naive_timestamp');
  return out;
}

function lengthSetting(c: ColumnDef): string {
  if (c.role === 'pageVisited') return ' or lower page.maxLength';
  if (c.role === 'promoted') return ` or lower customFields.${c.key}.maxLength`;
  return '';
}

function checkColumn(
  def: ColumnDef,
  info: ColumnInfo,
  dialect: SqlDialect,
  problems: SchemaProblem[],
  warnings: SchemaWarning[],
  ctx: { readonly existing: boolean; readonly sessionTimeDiff: string | undefined },
): void {
  const verdict = checkType(dialect.name, def, info);
  if (!verdict.ok) {
    problems.push({
      code: 'type_mismatch',
      column: def.name,
      message: `${label(def)} (column "${def.name}"): type "${info.dataType}" is not accepted on ${dialect.name}. Accepted: ${verdict.accepted.join(', ')}.`,
    });
    return;
  }
  for (const code of timestampWarnings(def, info, dialect, ctx.existing, verdict.warn)) {
    warnings.push({
      code,
      column: def.name,
      message:
        code === 'low_precision_timestamp' && verdict.warn === undefined
          ? `Column "${def.name}" has coarse precision (${info.dataType}(${info.precision ?? '?'})); visit times will be rounded.`
          : WARN_TEXT[code](def.name, info),
    });
  }
  if (
    dialect.name === 'mysql' &&
    def.role === 'timestamp' &&
    info.dataType === 'timestamp' &&
    ctx.sessionTimeDiff !== undefined &&
    !isUtcOffset(ctx.sessionTimeDiff)
  ) {
    problems.push({
      code: 'timestamp_session_timezone',
      column: def.name,
      message: `Role "timestamp" (column "${def.name}") is a MySQL TIMESTAMP, and this connection's time zone is "${offsetOf(ctx.sessionTimeDiff)}". dynalitics writes UTC. Use a DATETIME column, or make the connection run in UTC (for example SET time_zone = '+00:00' in your pool's init). dynalitics never changes the session itself.`,
    });
  }
  if (
    !ctx.existing &&
    def.type.kind === 'string' &&
    info.maxLength !== null &&
    info.maxLength !== -1 &&
    info.maxLength < def.type.maxLength
  ) {
    problems.push({
      code: 'too_short',
      column: def.name,
      message: `Column "${def.name}" is ${info.dataType}(${info.maxLength}) but dynalitics may write up to ${def.type.maxLength} characters. Widen the column${lengthSetting(def)}.`,
    });
  }
  if (def.nullable && !info.nullable) {
    const stop = def.role === 'promoted' ? `customFields.${def.key}` : `columns.${def.key} = false`;
    problems.push({
      code: 'not_nullable',
      column: def.name,
      message: `${label(def)} (column "${def.name}") is NOT NULL, but dynalitics writes NULL there when consent is not given. Make the column nullable, or stop storing this ${def.role === 'promoted' ? 'field' : 'role'} (${stop}).`,
    });
  }
  if (def.role === 'consent' && info.nullable) {
    warnings.push({
      code: 'nullable_consent',
      column: def.name,
      message: `Column "${def.name}" (consent) allows NULL. Existing NULL values are treated as "no consent".`,
    });
  }
}

/** Compares the catalog with the column model (recommended mode, spec 7.2/7.3). Pure. */
export function compareTable({
  model,
  dialect,
  columns,
  sessionTimeDiff,
}: CompareInput): CompareResult {
  const problems: SchemaProblem[] = [];
  const warnings: SchemaWarning[] = [];
  const qualified = dialect.qualifiedTable(model.table);
  const existing = model.mode === 'existing';

  if (columns.length === 0) {
    return {
      problems: [
        {
          code: 'missing_table',
          message: existing
            ? `Table ${qualified} was not found, or the database user cannot see it. dynalitics never creates tables, and tableMode is "existing", so check the table name (and schema) in the config and that the credential can see the table.`
            : `Table ${qualified} was not found, or the database user cannot see it. dynalitics never creates tables. To get the recommended table, run: npx dynalitics sql --dialect ${dialect.name} --table ${tableArg(model.table)}`,
        },
      ],
      warnings,
    };
  }
  if (columns.some((c) => c.tableType.toUpperCase() !== 'BASE TABLE')) {
    return {
      problems: [
        {
          code: 'not_a_table',
          message: `${qualified} is a view (or other non-table object). dynalitics supports base tables only, because inserts into views are not predictable (see 7.6).`,
        },
      ],
      warnings,
    };
  }

  // PostgreSQL compares quoted names exactly; MySQL and SQL Server are case-insensitive.
  const key = (n: string): string => (dialect.name === 'postgres' ? n : n.toLowerCase());
  const byName = new Map(columns.map((c) => [key(c.name), c]));
  const modelNames = new Set(model.columns.map((c) => key(c.name)));

  for (const def of model.columns) {
    const info = byName.get(key(def.name));
    if (info === undefined) {
      const listed = columns.slice(0, MAX_LISTED_COLUMNS).map((c) => c.name);
      const caseHint =
        dialect.name === 'postgres' &&
        columns.some((c) => c.name.toLowerCase() === def.name.toLowerCase())
          ? ' Quoted names are case-sensitive in PostgreSQL.'
          : '';
      problems.push({
        code: 'missing_column',
        column: def.name,
        message: `${label(def)} is mapped to column "${def.name}", but ${qualified} has no such column. Columns found: ${listed.join(', ')}${columns.length > MAX_LISTED_COLUMNS ? ', ...' : ''}.${caseHint}`,
      });
      continue;
    }
    checkColumn(def, info, dialect, problems, warnings, { existing, sessionTimeDiff });
  }

  for (const info of columns) {
    if (modelNames.has(key(info.name))) continue;
    if (!info.nullable && !info.hasDefault && !info.generated) {
      problems.push({
        code: 'extra_required_column',
        column: info.name,
        message: `Column "${info.name}" is NOT NULL, has no default and is not mapped, so every INSERT would fail. Give it a default or make it nullable.`,
      });
    }
  }
  return { problems, warnings };
}

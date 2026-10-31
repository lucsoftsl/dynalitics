import { DynaliticsConfigError } from '../errors.js';
import { getDialect } from '../dialect/index.js';
import { assertTableForDialect, parseTableRef } from '../model/identifiers.js';
import { buildColumnModel } from '../model/column-model.js';
import type { ColumnModel, Dialect, SchemaConfig } from '../model/types.js';

export interface GenerateOptions {
  dialect: Dialect;
  /** Same shape as the table-related part of the config. Recommended mode only. */
  schema: SchemaConfig;
  /** Default true. */
  indexes?: boolean;
  /** Omit to skip GRANTs. Role names default to the placeholders <writer_role> / <reader_role>. */
  grants?: { writerRole?: string; readerRole?: string };
}

export interface GeneratedSql {
  readonly createTable: string;
  readonly indexes: readonly string[];
  readonly grants: readonly string[];
  /** Everything above as one script with comments, ready to save. Printed, never executed by dynalitics. */
  readonly full: string;
}

export const WRITER_PLACEHOLDER = '<writer_role>';
export const READER_PLACEHOLDER = '<reader_role>';

/** Model-based entry point shared with the startup fix-SQL printer. */
export function renderSql(
  dialect: Dialect,
  model: ColumnModel,
  opts: { indexes?: boolean; grants?: { writerRole?: string; readerRole?: string } } = {},
): GeneratedSql {
  const d = getDialect(dialect);
  const createTable = d.createTableSql(model);
  const indexes = opts.indexes === false ? [] : d.createIndexSql(model);
  const grants =
    opts.grants === undefined
      ? []
      : d.grantSql({
          table: model.table,
          writerRole: opts.grants.writerRole ?? WRITER_PLACEHOLDER,
          readerRole: opts.grants.readerRole ?? READER_PLACEHOLDER,
          ...(model.firstVisitEnabled
            ? {
                writerSelectColumns: [model.identity.userId, model.identity.ip]
                  .filter((c) => c !== undefined)
                  .map((c) => c.name),
              }
            : {}),
        });
  const sections = [
    `-- dynalitics schema for ${dialect}. Generated, review before running. dynalitics itself never runs DDL.`,
    createTable,
    ...(indexes.length === 0
      ? []
      : [
          '',
          '-- Recommended indexes. The last two serve read-time new-vs-returning (one "any earlier row?" probe per visitor).',
          ...indexes,
        ]),
    ...(grants.length === 0
      ? []
      : [
          '',
          '-- Least-privilege grants. Replace the placeholders. Neither role needs UPDATE, DELETE, TRUNCATE, DDL or ownership.',
          ...grants,
        ]),
  ];
  return { createTable, indexes, grants, full: `${sections.join('\n')}\n` };
}

export function generateSql(opts: GenerateOptions): GeneratedSql {
  if (opts.schema.tableMode === 'existing') {
    throw new DynaliticsConfigError([
      'sql generates the recommended table. For a table you already have, map its columns with tableMode "existing"; `sql --grants-only` prints the GRANT statements for it.',
    ]);
  }
  const model = buildColumnModel(opts.schema);
  assertTableForDialect(model.table, opts.dialect);
  return renderSql(opts.dialect, model, {
    ...(opts.indexes === undefined ? {} : { indexes: opts.indexes }),
    ...(opts.grants === undefined ? {} : { grants: opts.grants }),
  });
}

export interface GrantsOptions {
  dialect: Dialect;
  /** Works for any table, including one you already have. Table-level, so no column mapping is needed. */
  table: string | { database?: string; schema?: string; name: string };
  writerRole?: string;
  readerRole?: string;
  /** Identity column names; adds column-level SELECT for the writer (write-time first-visit detection). */
  writerSelectColumns?: readonly string[];
}

export function generateGrants(opts: GrantsOptions): readonly string[] {
  const table = parseTableRef(opts.table);
  assertTableForDialect(table, opts.dialect);
  return getDialect(opts.dialect).grantSql({
    table,
    writerRole: opts.writerRole ?? WRITER_PLACEHOLDER,
    readerRole: opts.readerRole ?? READER_PLACEHOLDER,
    ...(opts.writerSelectColumns === undefined
      ? {}
      : { writerSelectColumns: opts.writerSelectColumns }),
  });
}

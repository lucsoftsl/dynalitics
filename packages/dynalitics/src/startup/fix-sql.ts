import type { SqlDialect } from '../dialect/types.js';
import type { SchemaProblem, SchemaWarning } from '../errors.js';
import type { ColumnModel, Dialect } from '../model/types.js';
import { renderSql } from '../schema/generate.js';
import { tableArg } from './compare.js';

interface FixInput {
  readonly model: ColumnModel;
  readonly dialect: SqlDialect;
  readonly problems: readonly SchemaProblem[];
}

const defaultClause = (dialect: Dialect, table: string, col: string): string =>
  dialect === 'postgres'
    ? `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT <value>;`
    : dialect === 'mysql'
      ? `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT <value>;`
      : `ALTER TABLE ${table} ADD DEFAULT <value> FOR ${col};`;

const commented = (lines: readonly string[]): string[] => lines.map((l) => `-- ${l}`);

function fixesFor(problem: SchemaProblem, { model, dialect }: FixInput): string[] {
  const def = model.columns.find((c) => c.name === problem.column);
  const table = dialect.qualifiedTable(model.table);
  switch (problem.code) {
    case 'missing_table':
      // Only the recommended table can be generated; for the user's own table the name or the grants are wrong.
      return model.mode === 'existing'
        ? [`-- ${problem.message}`]
        : renderSql(dialect.name, model).full.trimEnd().split('\n');
    case 'missing_column':
      if (def === undefined) return [];
      // A mapped column that does not exist in someone else's table is far more likely a typo than a missing column.
      if (model.mode === 'existing') {
        return [
          `-- ${problem.message}`,
          `-- Probably a typo in ${def.role === 'promoted' ? `customFields.${def.key}.column` : `columns.${def.key}`}. Fix the config, not the table.`,
        ];
      }
      return [
        dialect.addColumnSql(model.table, def),
        ...(def.nullable
          ? []
          : [
              `-- "${def.name}" should be NOT NULL: backfill existing rows first, then add the NOT NULL constraint.`,
            ]),
      ];
    case 'type_mismatch':
    case 'too_short':
      return def === undefined
        ? []
        : [
            `-- ${problem.message}`,
            '-- Existing data may not convert, review manually before running:',
            ...commented([dialect.alterTypeSql(model.table, def)]),
          ];
    case 'not_nullable':
      return def === undefined
        ? []
        : [
            `-- ${problem.message}`,
            '-- This changes your existing table, review manually before running:',
            ...commented([dialect.dropNotNullSql(model.table, def)]),
          ];
    case 'extra_required_column': {
      const col = dialect.quoteIdent(problem.column ?? '');
      return [
        `-- ${problem.message}`,
        '-- Choose one (review manually; the first needs the real column type on MySQL and SQL Server):',
        ...commented([
          defaultClause(dialect.name, table, col),
          ...(dialect.name === 'postgres'
            ? [`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL;`]
            : []),
        ]),
      ];
    }
    default:
      return [`-- ${problem.message}`];
  }
}

/** Printed text only. dynalitics never executes any of it. */
export function buildFixSql(input: FixInput): string {
  return input.problems.flatMap((p) => fixesFor(p, input)).join('\n');
}

export function buildSchemaReport(
  input: FixInput & { readonly warnings: readonly SchemaWarning[] },
): string {
  const { model, dialect, problems, warnings } = input;
  const fix = buildFixSql(input);
  const lines = [
    `table ${dialect.qualifiedTable(model.table)} does not match what dynalitics expects (${dialect.name}, tableMode "${model.mode}").`,
    '',
    'Problems:',
    ...problems.map((p, i) => `  ${i + 1}. ${p.message}`),
    ...(warnings.length === 0 ? [] : ['', 'Warnings:', ...warnings.map((w) => `  - ${w.message}`)]),
    '',
    'dynalitics never changes your database. Review the suggestions below and run what applies as a privileged user, then restart. Nothing here has been executed.',
    '',
    ...fix.split('\n').map((l) => (l === '' ? l : `  ${l}`)),
    '',
    model.mode === 'existing'
      ? '(The connection string is never included in this message. Your table is never changed by dynalitics: fix the mapping in the config, or change the table yourself.)'
      : `(The connection string is never included in this message. Generate the full schema with: npx dynalitics sql --dialect ${dialect.name} --table ${tableArg(model.table)})`,
  ];
  return lines.join('\n');
}

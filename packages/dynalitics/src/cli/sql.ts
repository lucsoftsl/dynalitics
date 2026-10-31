import { parseArgs } from 'node:util';
import { runRule } from '../config/validate.js';
import { schemaFileRule } from '../config/schema.js';
import { DynaliticsConfigError } from '../errors.js';
import { buildColumnModel } from '../model/column-model.js';
import type { Dialect, SchemaConfig } from '../model/types.js';
import { generateGrants, generateSql } from '../schema/generate.js';
import type { CliIo } from './io.js';

export const SQL_USAGE = `dynalitics sql --dialect postgres|mysql|mssql --table <name | schema.name | db.schema.name>
               [--config <file.json>]   table-shape settings as JSON (columns, customFields, page, firstVisit)
               [--no-indexes]
               [--grants]               append least-privilege GRANTs (placeholders <writer_role>/<reader_role>)
               [--grants-only]          print ONLY the GRANTs (works for a table you already have)
               [--writer <name>] [--reader <name>]   replace the placeholders (requires --grants or --grants-only)
               [--out <file>] [--force] write to a file; refuses to overwrite without --force
`;

const DIALECTS: readonly string[] = ['postgres', 'mysql', 'mssql'];
const OPTIONS = {
  dialect: { type: 'string' },
  table: { type: 'string' },
  config: { type: 'string' },
  'no-indexes': { type: 'boolean' },
  grants: { type: 'boolean' },
  'grants-only': { type: 'boolean' },
  writer: { type: 'string' },
  reader: { type: 'string' },
  out: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

class UsageError extends Error {}

function loadSchemaFile(path: string, io: CliIo): Omit<SchemaConfig, 'table'> {
  let text: string;
  try {
    text = io.readFile(path);
  } catch {
    throw new UsageError(`Cannot read ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(
      `${path} is not valid JSON. Only JSON is accepted; code is never executed.`,
    );
  }
  // Only table-shape keys are allowed: this is how connection strings and functions are kept out.
  const issues = runRule(schemaFileRule, parsed, 'config file');
  if (issues.length > 0) throw new DynaliticsConfigError(issues);
  return parsed as Omit<SchemaConfig, 'table'>;
}

export function runSql(argv: readonly string[], io: CliIo): number {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    if (values.help === true) {
      io.stdout(SQL_USAGE);
      return 0;
    }
    const dialect = values.dialect;
    if (dialect === undefined || !DIALECTS.includes(dialect)) {
      throw new UsageError('--dialect must be one of: postgres, mysql, mssql.');
    }
    if (values.table === undefined) throw new UsageError('--table is required.');
    const wantsGrants = values.grants === true || values['grants-only'] === true;
    if ((values.writer !== undefined || values.reader !== undefined) && !wantsGrants) {
      throw new UsageError('--writer and --reader need --grants or --grants-only.');
    }
    const file = values.config === undefined ? {} : loadSchemaFile(values.config, io);
    const schema: SchemaConfig = { table: values.table, ...file };
    const roles = {
      ...(values.writer === undefined ? {} : { writerRole: values.writer }),
      ...(values.reader === undefined ? {} : { readerRole: values.reader }),
    };

    let text: string;
    if (values['grants-only'] === true) {
      const identity =
        file.firstVisit?.enabled === true ? buildColumnModel(schema).identity : undefined;
      const columns =
        identity === undefined
          ? undefined
          : [identity.userId, identity.ip].filter((c) => c !== undefined).map((c) => c.name);
      text = `${generateGrants({
        dialect: dialect as Dialect,
        table: values.table,
        ...roles,
        ...(columns === undefined ? {} : { writerSelectColumns: columns }),
      }).join('\n')}\n`;
    } else {
      text = generateSql({
        dialect: dialect as Dialect,
        schema,
        ...(values['no-indexes'] === true ? { indexes: false } : {}),
        ...(values.grants === true ? { grants: roles } : {}),
      }).full;
    }

    if (values.out === undefined) {
      io.stdout(text);
      return 0;
    }
    if (io.exists(values.out) && values.force !== true) {
      throw new UsageError(`Refusing to overwrite ${values.out}; pass --force to replace it.`);
    }
    io.writeFile(values.out, text, values.force === true);
    io.stderr(`Wrote ${values.out}\n`);
    return 0;
  } catch (err) {
    return reportError(err, io);
  }
}

export function reportError(err: unknown, io: CliIo): number {
  if (err instanceof DynaliticsConfigError) io.stderr(`${err.issues.join('\n')}\n`);
  else if (err instanceof UsageError) io.stderr(`${err.message}\n`);
  else if (
    err instanceof TypeError &&
    (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
  ) {
    io.stderr(`${err.message}\n\n${SQL_USAGE}`);
  } else io.stderr(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

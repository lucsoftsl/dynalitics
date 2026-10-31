import { randomBytes } from 'node:crypto';
import { resolveConfig, validateConfig, type ResolvedConfig } from './config/schema.js';
import { getDialect } from './dialect/index.js';
import type { ColumnInfo, SqlDialect } from './dialect/types.js';
import {
  isDriverError,
  type Driver,
  type DriverAdapter,
  type DriverOptions,
} from './driver/types.js';
import { DynaliticsConnectionError, DynaliticsSchemaError, type SchemaProblem } from './errors.js';
import { registerInternals } from './internals.js';
import { consoleLogger, safeLogger, type Logger } from './logger.js';
import { buildColumnModel } from './model/column-model.js';
import { adoptPhysical, type LengthAdoption } from './model/physical.js';
import type { ColumnModel, Dialect } from './model/types.js';
import { createPipeline } from './queue/pipeline.js';
import {
  createRedactor,
  sanitizeError,
  secretsFromConnectionString,
  type Redactor,
} from './redact.js';
import { createReporter } from './report.js';
import { compareTable } from './startup/compare.js';
import { buildFixSql, buildSchemaReport } from './startup/fix-sql.js';
import { inspectPrivileges, type CredentialKind } from './startup/privileges.js';
import { probeSessionTimeDiff } from './startup/session-timezone.js';
import { unmappedNotice } from './startup/unmapped-notice.js';
import { buildRow } from './track/build-row.js';
import { createFirstVisit } from './track/first-visit.js';
import type {
  Credential,
  Dynalitics,
  DynaliticsConfig,
  DynaliticsStats,
  TrackResult,
} from './types.js';

export interface CreateDeps {
  readonly createDriver: (adapter: DriverAdapter, options: DriverOptions) => Promise<Driver>;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

const realDeps: CreateDeps = {
  createDriver: (adapter, options) => adapter.createDriver(options),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

const STARTUP_QUERY_TIMEOUT_MS = 10_000;
const SINGLE_CREDENTIAL_WARNING =
  "dynalitics is using ONE database credential for both writing and reading. Anyone who can use the web process's credential can therefore read the personal data (ip, email, username, userId) it writes. Use separate writer and reader credentials: `npx dynalitics sql --grants-only --dialect <dialect> --table <table>` prints the GRANT statements.";

const secretsOf = (c: Credential | undefined): string[] =>
  c !== undefined && 'connectionString' in c ? secretsFromConnectionString(c.connectionString) : [];

function asConnectionError(
  err: unknown,
  what: string,
  redact: Redactor,
): DynaliticsConnectionError {
  if (err instanceof DynaliticsConnectionError) return err;
  const cause =
    isDriverError(err)
      ? (err.safeCause ?? sanitizeError(err, redact))
      : sanitizeError(err, redact);
  return new DynaliticsConnectionError(`${what}: ${cause.message}`, cause);
}

interface Structure {
  /** Where the catalog found the table: used for every later statement when the config gave no schema (F-36). */
  readonly schema: string | undefined;
  readonly columns: readonly ColumnInfo[];
}

/** MySQL: a TIMESTAMP role column makes the session time zone matter (spec 3.9). Nothing is asked otherwise. */
async function sessionTimeDiffFor(
  model: ColumnModel,
  columns: readonly ColumnInfo[],
  dialect: SqlDialect,
  drivers: readonly Driver[],
  redact: Redactor,
): Promise<string | undefined> {
  const ts = model.columns.find((c) => c.role === 'timestamp');
  const real = columns.find((c) => c.name.toLowerCase() === ts?.name.toLowerCase());
  if (dialect.name !== 'mysql' || real?.dataType !== 'timestamp') return undefined;
  try {
    return await probeSessionTimeDiff(drivers, STARTUP_QUERY_TIMEOUT_MS);
  } catch (err) {
    throw asConnectionError(err, 'Could not check the session time zone', redact);
  }
}

async function checkStructure(
  inspector: Driver,
  used: readonly Driver[],
  hasReader: boolean,
  model: ColumnModel,
  dialect: SqlDialect,
  logger: Logger,
  redact: Redactor,
): Promise<Structure> {
  let rows;
  try {
    rows = await inspector.query(dialect.introspectSql(model.table), {
      timeoutMs: STARTUP_QUERY_TIMEOUT_MS,
    });
  } catch (err) {
    throw asConnectionError(err, 'Could not read the table structure', redact);
  }
  const columns = rows.map((r) => dialect.mapColumnRow(r));
  const sessionTimeDiff = await sessionTimeDiffFor(model, columns, dialect, used, redact);
  const result = compareTable({
    model,
    dialect,
    columns,
    ...(sessionTimeDiff === undefined ? {} : { sessionTimeDiff }),
  });
  let problems: readonly SchemaProblem[] = result.problems;
  if (!hasReader && columns.length === 0) {
    const table = dialect.qualifiedTable(model.table);
    problems = [
      {
        code: 'identity_not_discoverable',
        message:
          model.mode === 'existing'
            ? `The writer credential cannot see the columns of ${table} (or the table does not exist), so the structure cannot be checked. Add a reader credential that can see the table, and check the table name in the config.`
            : `The writer credential cannot see the columns of ${table} (or the table does not exist), so the structure cannot be checked. Add a reader credential, or set validateOnStart: 'skip'. To get the recommended table, run: npx dynalitics sql --dialect ${dialect.name} --table ${model.table.name}`,
      },
    ];
  }
  if (problems.length > 0) {
    const input = { model, dialect, problems, warnings: result.warnings };
    throw new DynaliticsSchemaError(
      buildSchemaReport(input),
      problems,
      result.warnings,
      buildFixSql(input),
    );
  }
  for (const w of result.warnings) logger.warn(w.message);
  return { schema: columns[0]?.schema, columns };
}

/** Same as createDynalitics but with injectable I/O, for tests. */
export async function createDynaliticsWith(
  config: DynaliticsConfig,
  deps: CreateDeps,
): Promise<Dynalitics> {
  const cfg: ResolvedConfig = resolveConfig(validateConfig(config));
  let model = buildColumnModel(cfg.schema);
  const dialect = getDialect(cfg.dialect);
  const { writer: writerCred, reader: readerCred, single } = cfg.credentials;

  const redact = createRedactor([
    ...secretsOf(writerCred),
    ...secretsOf(readerCred),
    ...(cfg.ip.salt === undefined ? [] : [cfg.ip.salt]),
  ]);
  const logger = safeLogger(cfg.logger ?? consoleLogger, redact);
  const reporter = createReporter(cfg.onError, redact, deps.now);

  if (single && !cfg.acknowledgeSingleCredential) logger.warn(SINGLE_CREDENTIAL_WARNING);

  const opened: Driver[] = [];
  const closeAll = async (): Promise<void> => {
    await Promise.allSettled([...new Set(opened)].map((d) => d.close()));
  };
  const open = async (cred: Credential, max: number): Promise<Driver> => {
    try {
      const d = await deps.createDriver(cfg.adapter, {
        credential: cred,
        max,
        connectTimeoutMs: cfg.connectTimeoutMs,
        redact,
      });
      opened.push(d);
      return d;
    } catch (err) {
      throw asConnectionError(err, 'Could not set up the database driver', redact);
    }
  };

  let writerDriver: Driver | undefined;
  let readerDriver: Driver | undefined;
  let adopted: readonly LengthAdoption[] = [];
  try {
    if (writerCred !== undefined) writerDriver = await open(writerCred, cfg.poolSize.writer);
    if (single) readerDriver = writerDriver;
    else if (readerCred !== undefined) readerDriver = await open(readerCred, cfg.poolSize.reader);

    if (cfg.validateOnStart === 'skip') {
      logger.warn(
        'validateOnStart is "skip": the table structure and privileges were NOT checked.',
      );
    } else {
      for (const d of new Set([writerDriver, readerDriver])) {
        if (d === undefined) continue;
        try {
          await d.query({ sql: 'SELECT 1', params: [] }, { timeoutMs: cfg.connectTimeoutMs });
        } catch (err) {
          throw asConnectionError(err, 'Could not connect to the database', redact);
        }
      }
      const inspector = readerDriver ?? writerDriver;
      if (inspector !== undefined) {
        const used = [...new Set([writerDriver, readerDriver])].filter(
          (d): d is Driver => d !== undefined,
        );
        const found = await checkStructure(
          inspector,
          used,
          readerDriver !== undefined,
          model,
          dialect,
          logger,
          redact,
        );
        const real = adoptPhysical(model, found.columns, dialect.name);
        model = real.model;
        adopted = real.adopted;
        if (found.schema !== undefined && model.table.schema === undefined) {
          // Introspection and INSERT/SELECT must look at the same table, not at whatever search_path resolves later.
          model = { ...model, table: { ...model.table, schema: found.schema } };
        }
      }
      const checks: [Driver | undefined, CredentialKind][] = single
        ? [[writerDriver, 'single']]
        : [
            [writerDriver, 'writer'],
            [readerDriver, 'reader'],
          ];
      for (const [driver, kind] of checks) {
        if (driver === undefined) continue;
        const r = await inspectPrivileges({
          driver,
          dialect,
          table: model.table,
          kind,
          firstVisitEnabled: model.firstVisitEnabled,
        });
        if (r.warning !== undefined) logger.warn(r.warning);
      }
    }
  } catch (err) {
    await closeAll();
    throw err;
  }

  logger.info(`using table ${dialect.qualifiedTable(model.table)} (tableMode "${model.mode}")`);
  for (const a of adopted) {
    logger.info(
      `column "${a.column}" holds at most ${a.real} characters, less than the configured ${a.configured}; longer values are ${cfg.limits.oversize === 'reject' ? 'rejected' : 'cut to fit'}.`,
    );
  }
  const notice = unmappedNotice(model);
  if (notice !== undefined) logger.info(notice);

  const firstVisit =
    model.firstVisitEnabled && writerDriver !== undefined
      ? createFirstVisit({
          cacheSize: cfg.firstVisit.cacheSize,
          processKey: randomBytes(32),
          maxParams: dialect.limits.maxParams,
          lookup: async (kind, values) => {
            const rows = await writerDriver.query(dialect.firstVisitLookup(model, kind, values), {
              timeoutMs: STARTUP_QUERY_TIMEOUT_MS,
            });
            return new Set(rows.map((r) => String(r['v'])));
          },
        })
      : undefined;

  const pipeline =
    writerDriver === undefined
      ? undefined
      : createPipeline({
          driver: writerDriver,
          dialect,
          model,
          queue: cfg.queue,
          firstVisit,
          report: (info) => reporter.report(info),
          sleep: (ms) => deps.sleep(ms),
          random: () => deps.random(),
          now: () => deps.now().getTime(),
          requestTimeoutMs: STARTUP_QUERY_TIMEOUT_MS,
        });

  let rejected = 0;
  const pageColumn = model.columns.find((c) => c.role === 'pageVisited')?.type;
  const rowConfig = {
    // The real column may be shorter than page.maxLength (existing tables): never build a value that cannot be stored.
    page: {
      ...cfg.page,
      maxLength: pageColumn?.kind === 'string' ? pageColumn.maxLength : cfg.page.maxLength,
    },
    ip: cfg.ip,
    limits: cfg.limits,
    consentDefault: cfg.consentDefault,
  };
  let closing: ReturnType<Dynalitics['close']> | undefined;

  const dyn: Dynalitics = {
    model,
    table: model.table,
    capabilities: { canWrite: pipeline !== undefined, canRead: readerDriver !== undefined },

    async track(visit): Promise<TrackResult> {
      try {
        if (pipeline === undefined)
          return { status: 'rejected', issues: ['no writer credential configured'] };
        const built = buildRow({ model, dialect, cfg: rowConfig, visit, now: deps.now() });
        built.notes.forEach((n) => reporter.note(n));
        if (!built.ok) {
          rejected++;
          reporter.note({
            code: 'invalid_visit',
            message: `visit rejected: ${built.issues.join('; ')}`,
          });
          return { status: 'rejected', issues: built.issues };
        }
        return await pipeline.enqueue({ values: built.values, identity: built.identity });
      } catch (err) {
        rejected++;
        reporter.report({
          code: 'internal',
          message: 'unexpected error while tracking a visit',
          cause: sanitizeError(err, redact),
        });
        return { status: 'rejected', issues: ['internal error'] };
      }
    },

    async flush(opts) {
      return pipeline === undefined
        ? { written: 0, failed: 0, timedOut: false }
        : pipeline.flush(opts);
    },

    close(opts) {
      closing ??= (async () => {
        const res =
          pipeline === undefined
            ? { written: 0, failed: 0, timedOut: false }
            : await pipeline.close(opts);
        await closeAll();
        return res;
      })();
      return closing;
    },

    stats(): Readonly<DynaliticsStats> {
      const s = pipeline?.stats();
      return {
        queued: s?.queued ?? 0,
        written: s?.written ?? 0,
        droppedFull: s?.droppedFull ?? 0,
        rejected,
        failed: s?.failed ?? 0,
        queueLength: s?.queueLength ?? 0,
        lruSize: firstVisit?.size() ?? 0,
        lastErrorAt: reporter.lastErrorAt(),
      };
    },
  };
  registerInternals(dyn, {
    reader: readerDriver,
    dialect,
    model,
    ipMode: cfg.ip.mode,
    redact,
    report: (info) => reporter.report(info),
    logger,
    now: deps.now,
  });
  return dyn;
}

/**
 * Connects, validates the table (never changes it) and returns a tracker.
 * Throws DynaliticsConfigError, DynaliticsConnectionError or DynaliticsSchemaError (never with connection details).
 */
export function createDynalitics(config: DynaliticsConfig): Promise<Dynalitics> {
  return createDynaliticsWith(config, realDeps);
}

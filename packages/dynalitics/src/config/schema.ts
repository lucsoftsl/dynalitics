import { ADAPTER_API_VERSION, type DriverAdapter } from '../driver/types.js';
import { DynaliticsConfigError } from '../errors.js';
import type { Logger } from '../logger.js';
import { assertTableForDialect, parseTableRef } from '../model/identifiers.js';
import type { Dialect, IpMode, SchemaConfig } from '../model/types.js';
import type { Credential, DynaliticsConfig, ErrorInfo, Visit } from '../types.js';
import {
  anyObject,
  bool,
  custom,
  fn,
  int,
  obj,
  oneOf,
  rec,
  req,
  runRule,
  str,
  type Issues,
  type Rule,
} from './validate.js';

const ROLES = [
  'timestamp',
  'consent',
  'pageVisited',
  'ip',
  'userId',
  'username',
  'email',
  'custom',
  'isFirstVisit',
  'id',
] as const;
const MIN_SALT = 16;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const credentialRule: Rule = (v, path, issues) => {
  if (!isObj(v)) return void issues.push(`${path}: expected an object`);
  const hasCs = Object.hasOwn(v, 'connectionString');
  const hasPool = Object.hasOwn(v, 'pool');
  if (hasCs && hasPool)
    return void issues.push(`${path}: provide exactly one of connectionString or pool`);
  if (!hasCs && !hasPool) return void issues.push(`${path}: provide connectionString or pool`);
  obj({ connectionString: str({ min: 1 }), pool: anyObject })(v, path, issues);
};

const connectionRule: Rule = (v, path, issues) => {
  if (!isObj(v)) return void issues.push(`${path}: expected an object`);
  const single = Object.hasOwn(v, 'connectionString') || Object.hasOwn(v, 'pool');
  const split = Object.hasOwn(v, 'writer') || Object.hasOwn(v, 'reader');
  if (single && split) {
    return void issues.push(
      `${path}: use either a single credential (connectionString or pool) or { writer, reader }, not both`,
    );
  }
  if (single) return credentialRule(v, path, issues);
  if (!split)
    return void issues.push(`${path}: provide connectionString, pool, or { writer, reader }`);
  obj({ writer: credentialRule, reader: credentialRule })(v, path, issues);
};

const DIALECTS: readonly Dialect[] = ['postgres', 'mysql', 'mssql'];
const ADAPTER_HINT = 'expected an adapter from dynalitics-postgres, dynalitics-mysql or dynalitics-mssql';

/** Spec 5.2 (v0.5): structural check, so an adapter built against another copy of dynalitics still passes. */
const adapterRule: Rule = (v, path, issues) => {
  if (!isObj(v)) return void issues.push(`${path}: ${ADAPTER_HINT}`);
  const { apiVersion, dialect, createDriver, packageName } = v;
  if (typeof createDriver !== 'function' || !DIALECTS.includes(dialect as Dialect))
    return void issues.push(`${path}: ${ADAPTER_HINT}`);
  if (apiVersion !== ADAPTER_API_VERSION) {
    const name = typeof packageName === 'string' ? packageName : 'the adapter';
    issues.push(
      `${path}: ${name} implements adapter API ${String(apiVersion)}, this dynalitics needs ${ADAPTER_API_VERSION}`,
    );
  }
};

const dialectOf = (c: Record<string, unknown>): Dialect | undefined => {
  const a = c['adapter'];
  return isObj(a) && DIALECTS.includes(a['dialect'] as Dialect) ? (a['dialect'] as Dialect) : undefined;
};

const tableRule: Rule = (v, path, issues) => {
  if (typeof v === 'string') return str({ min: 1 })(v, path, issues);
  if (isObj(v))
    return obj({ database: str(), schema: str(), name: req(str({ min: 1 })) })(v, path, issues);
  issues.push(`${path}: expected a string or { schema?, name }`);
};

const columnsRule = obj(
  Object.fromEntries(
    ROLES.map((role) => [
      role,
      custom((v, path, issues) => {
        if (v !== false && typeof v !== 'string')
          issues.push(`${path}: expected a column name or false`);
      }),
    ]),
  ),
);

const customFieldRule = obj({
  type: req(oneOf(['string', 'integer', 'number', 'boolean'])),
  maxLength: int({ min: 1, max: 1024 }),
  personal: bool,
  column: custom((v, path, issues) => {
    if (v !== true && typeof v !== 'string') issues.push(`${path}: expected true or a column name`);
  }),
  breakdown: bool,
  keepWhenDenied: bool,
});

const notYet =
  (what: string): Rule =>
  (_v, path, issues) =>
    void issues.push(`${path}: ${what} is not supported yet (planned for phase 2)`);

const configRule = obj({
  adapter: req(adapterRule),
  connection: req(connectionRule),
  acknowledgeSingleCredential: bool,
  poolSize: int({ min: 1, max: 20 }),
  connectTimeoutMs: int({ min: 100, max: 120_000 }),
  table: req(tableRule),
  tableMode: oneOf(['recommended', 'existing']),
  columns: columnsRule,
  customFields: rec(customFieldRule),
  extraColumns: notYet('extraColumns'),
  page: obj({ keepQuery: bool, maxLength: int({ min: 1, max: 700 }), normalize: fn }),
  ip: obj({
    mode: oneOf(['raw', 'hash', 'truncate']),
    salt: str(),
    ipv4Prefix: int({ min: 8, max: 32 }),
    ipv6Prefix: int({ min: 16, max: 128 }),
  }),
  consent: obj({ default: fn }),
  firstVisit: obj({ enabled: bool, cacheSize: int({ min: 1, max: 5_000_000 }) }),
  queue: obj({
    maxSize: int({ min: 1, max: 1_000_000 }),
    batchSize: int({ min: 1, max: 1000 }),
    flushIntervalMs: int({ min: 10, max: 600_000 }),
    backpressure: oneOf(['drop', 'block']),
    maxBlockMs: int({ min: 1, max: 600_000 }),
    retry: obj({
      attempts: int({ min: 1, max: 10 }),
      baseDelayMs: int({ min: 1, max: 60_000 }),
      maxDelayMs: int({ min: 1, max: 600_000 }),
    }),
  }),
  limits: obj({
    customMaxKeys: int({ min: 1, max: 100 }),
    customMaxBytes: int({ min: 16, max: 65_536 }),
    oversize: oneOf(['truncate', 'reject']),
  }),
  validateOnStart: oneOf(['strict', 'skip']),
  onError: fn,
  logger: custom((v, path, issues) => {
    if (!isObj(v))
      return void issues.push(`${path}: expected an object with info, warn and error functions`);
    obj({ info: req(fn), warn: req(fn), error: req(fn) })(v, path, issues);
  }),
});

/** Rule for the JSON file accepted by `dynalitics sql --config`: table-shape settings only, no secrets, no functions. */
export const schemaFileRule: Rule = obj({
  tableMode: oneOf(['recommended', 'existing']),
  columns: columnsRule,
  customFields: rec(customFieldRule),
  page: obj({ maxLength: int({ min: 1, max: 700 }) }),
  firstVisit: obj({ enabled: bool }),
});

function crossChecks(c: Record<string, unknown>, issues: Issues): void {
  if (c['tableMode'] === 'existing' && c['validateOnStart'] === 'skip') {
    issues.push(
      'config.validateOnStart: "skip" is only allowed with tableMode "recommended"; an existing table is always checked at startup',
    );
  }
  const ip = c['ip'];
  if (isObj(ip) && ip['mode'] === 'hash') {
    const salt = ip['salt'];
    if (salt === undefined) issues.push('config.ip.salt is required when ip.mode is "hash"');
    else if (typeof salt === 'string' && salt.length < MIN_SALT) {
      issues.push(`config.ip.salt must be at least ${MIN_SALT} characters`);
    }
  }
  const table = c['table'];
  const dialect = dialectOf(c);
  if ((typeof table === 'string' || isObj(table)) && dialect !== undefined) {
    try {
      const ref = parseTableRef(table as Parameters<typeof parseTableRef>[0]);
      assertTableForDialect(ref, dialect);
    } catch (e) {
      if (e instanceof DynaliticsConfigError)
        issues.push(...e.issues.map((m) => `config.table: ${m}`));
      else throw e;
    }
  }
}

/** Shape and cross-field validation. Throws one DynaliticsConfigError listing every issue. */
export function validateConfig(input: unknown): DynaliticsConfig {
  if (!isObj(input)) throw new DynaliticsConfigError(['config: expected an object']);
  const issues = runRule(configRule, input, 'config');
  crossChecks(input, issues);
  if (issues.length > 0) throw new DynaliticsConfigError(issues);
  return input as unknown as DynaliticsConfig;
}

export interface ResolvedConfig {
  readonly adapter: DriverAdapter;
  readonly dialect: Dialect;
  readonly credentials: {
    readonly single: boolean;
    readonly writer?: Credential;
    readonly reader?: Credential;
  };
  readonly acknowledgeSingleCredential: boolean;
  readonly poolSize: { readonly writer: number; readonly reader: number };
  readonly connectTimeoutMs: number;
  readonly schema: SchemaConfig;
  readonly page: {
    readonly keepQuery: boolean;
    readonly maxLength: number;
    readonly normalize: ((path: string) => string) | undefined;
  };
  readonly ip: {
    readonly mode: IpMode;
    readonly salt: string | undefined;
    readonly ipv4Prefix: number;
    readonly ipv6Prefix: number;
  };
  readonly consentDefault: ((visit: Readonly<Visit>) => boolean) | undefined;
  readonly firstVisit: { readonly enabled: boolean; readonly cacheSize: number };
  readonly queue: {
    readonly maxSize: number;
    readonly batchSize: number;
    readonly flushIntervalMs: number;
    readonly backpressure: 'drop' | 'block';
    readonly maxBlockMs: number;
    readonly retry: {
      readonly attempts: number;
      readonly baseDelayMs: number;
      readonly maxDelayMs: number;
    };
  };
  readonly limits: {
    readonly customMaxKeys: number;
    readonly customMaxBytes: number;
    readonly oversize: 'truncate' | 'reject';
  };
  readonly validateOnStart: 'strict' | 'skip';
  readonly onError: ((info: ErrorInfo) => void) | undefined;
  readonly logger: Logger | undefined;
}

function resolveCredentials(
  connection: DynaliticsConfig['connection'],
): ResolvedConfig['credentials'] {
  if ('connectionString' in connection || 'pool' in connection) {
    const cred = connection;
    return { single: true, writer: cred, reader: cred };
  }
  const split = connection;
  return {
    single: false,
    ...(split.writer === undefined ? {} : { writer: split.writer }),
    ...(split.reader === undefined ? {} : { reader: split.reader }),
  };
}

/** Applies defaults (spec 4.3). Pure: returns a new object, never mutates the config. */
export function resolveConfig(c: DynaliticsConfig): ResolvedConfig {
  return {
    adapter: c.adapter,
    dialect: c.adapter.dialect,
    credentials: resolveCredentials(c.connection),
    acknowledgeSingleCredential: c.acknowledgeSingleCredential === true,
    poolSize: { writer: c.poolSize ?? 4, reader: c.poolSize ?? 2 },
    connectTimeoutMs: c.connectTimeoutMs ?? 10_000,
    schema: {
      table: c.table,
      ...(c.tableMode === undefined ? {} : { tableMode: c.tableMode }),
      ...(c.columns === undefined ? {} : { columns: c.columns }),
      ...(c.customFields === undefined ? {} : { customFields: c.customFields }),
      page: { maxLength: c.page?.maxLength ?? 512 },
      firstVisit: { enabled: c.firstVisit?.enabled === true },
    },
    page: {
      keepQuery: c.page?.keepQuery === true,
      maxLength: c.page?.maxLength ?? 512,
      normalize: c.page?.normalize,
    },
    ip: {
      mode: c.ip?.mode ?? 'truncate',
      salt: c.ip?.salt,
      ipv4Prefix: c.ip?.ipv4Prefix ?? 24,
      ipv6Prefix: c.ip?.ipv6Prefix ?? 48,
    },
    consentDefault: c.consent?.default,
    firstVisit: {
      enabled: c.firstVisit?.enabled === true,
      cacheSize: c.firstVisit?.cacheSize ?? 50_000,
    },
    queue: {
      maxSize: c.queue?.maxSize ?? 10_000,
      batchSize: c.queue?.batchSize ?? 200,
      flushIntervalMs: c.queue?.flushIntervalMs ?? 1000,
      backpressure: c.queue?.backpressure ?? 'drop',
      maxBlockMs: c.queue?.maxBlockMs ?? 2000,
      retry: {
        attempts: c.queue?.retry?.attempts ?? 3,
        baseDelayMs: c.queue?.retry?.baseDelayMs ?? 200,
        maxDelayMs: c.queue?.retry?.maxDelayMs ?? 5000,
      },
    },
    limits: {
      customMaxKeys: c.limits?.customMaxKeys ?? 20,
      customMaxBytes: c.limits?.customMaxBytes ?? 4096,
      oversize: c.limits?.oversize ?? 'truncate',
    },
    validateOnStart: c.validateOnStart ?? 'strict',
    onError: c.onError,
    logger: c.logger,
  };
}

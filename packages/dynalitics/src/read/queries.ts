import type { CompiledQuery, SqlDialect } from '../dialect/types.js';
import type { ColumnModel, Role, SqlValue } from '../model/types.js';
import type { Interval } from '../protocol.js';
import type { Dimension, NvrPlan } from './capabilities.js';
import type { Cursor } from './params.js';
import { instantExpr, truthExpr } from './physical.js';

export interface ScopeValue {
  readonly name: string;
  readonly value: SqlValue;
}
export interface Env {
  readonly dialect: SqlDialect;
  readonly model: ColumnModel;
  /** Row scope (spec 10.1, F-08): `AND <column> = <bound value>` on EVERY reference to the table, probes included. */
  readonly scope: readonly ScopeValue[];
}
export interface Range {
  readonly from: Date;
  readonly to: Date;
}

/** Collects bound parameters in order and hands out the dialect's placeholder for each. */
class Params {
  readonly values: SqlValue[] = [];
  constructor(private readonly dialect: SqlDialect) {}
  add(v: SqlValue): string {
    this.values.push(v);
    return this.dialect.placeholder(this.values.length);
  }
  date(d: Date): string {
    return this.add(this.dialect.timestampParam(d));
  }
}

function names(env: Env) {
  const def = (role: Role) => env.model.columns.find((x) => x.role === role);
  const dialect = env.dialect.name;
  const q = (role: Role): string | undefined => {
    const c = env.model.columns.find((x) => x.role === role);
    return c === undefined ? undefined : env.dialect.quoteIdent(c.name);
  };
  const must = (role: Role): string => {
    const c = q(role);
    if (c === undefined) throw new Error(`required column for role ${role} is missing`);
    return c;
  };
  return {
    table: env.dialect.qualifiedTable(env.model.table),
    ts: must('timestamp'),
    consent: must('consent'),
    page: must('pageVisited'),
    id: q('id'),
    ip: q('ip'),
    user: q('userId'),
    username: q('username'),
    email: q('email'),
    custom: q('custom'),
    fv: q('isFirstVisit'),
    /** The visit instant for display and bucketing (the raw column is still used for filters and ordering). */
    inst: (expr: string): string => instantExpr(dialect, def('timestamp'), expr),
    /** A boolean-role column as something `isTrue/isFalse` accept (integer consent columns, PostgreSQL). */
    truth: (role: Role, expr: string): string => truthExpr(dialect, def(role), expr),
  };
}

const finish = (p: Params, sql: string): CompiledQuery => ({ sql, params: p.values });

/** ` AND [alias.]col = ?` for every configured scope column, values bound. Empty string when unscoped. */
function scoped(env: Env, p: Params, alias = ''): string {
  return env.scope
    .map((s) => ` AND ${alias}${env.dialect.quoteIdent(s.name)} = ${p.add(s.value)}`)
    .join('');
}

/** `ts >= from AND ts < to` plus scope, for the table reference named by `alias` ('' = unaliased). */
function inRange(env: Env, p: Params, ts: string, r: Range, alias = ''): string {
  return `${alias}${ts} >= ${p.date(r.from)} AND ${alias}${ts} < ${p.date(r.to)}${scoped(env, p, alias)}`;
}

export function visitsSeries(env: Env, r: Range & { interval: Interval }): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const bucket = env.dialect.read.bucket(n.inst(n.ts), r.interval);
  return finish(
    p,
    `SELECT bucket, ${env.dialect.read.count} AS visits FROM (SELECT ${bucket} AS bucket FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x GROUP BY bucket ORDER BY bucket`,
  );
}

function dimensionExpr(env: Env, dim: Dimension): string {
  const n = names(env);
  const read = env.dialect.read;
  switch (dim.kind) {
    case 'consent':
      return `CASE WHEN ${read.isTrue(n.truth('consent', n.consent))} THEN 'true' ELSE 'false' END`;
    case 'isFirstVisit':
      if (n.fv === undefined) throw new Error('isFirstVisit column is not mapped');
      return `CASE WHEN ${n.fv} IS NULL THEN NULL WHEN ${read.isTrue(n.truth('isFirstVisit', n.fv))} THEN 'true' ELSE 'false' END`;
    case 'json':
      if (n.custom === undefined) throw new Error('custom column is not mapped');
      return read.jsonKey(n.custom, dim.key);
    case 'promoted': {
      if (dim.column === undefined || dim.fieldType === undefined) {
        throw new Error('promoted dimension without a column');
      }
      const quoted = env.dialect.quoteIdent(dim.column.name);
      return read.castText(
        dim.fieldType === 'boolean' ? truthExpr(env.dialect.name, dim.column, quoted) : quoted,
        dim.fieldType,
      );
    }
  }
}

export const BREAKDOWN_TOP = 10;

export function breakdownTop(env: Env, dim: Dimension, r: Range): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  return finish(
    p,
    `SELECT ${read.top(BREAKDOWN_TOP)}v, ${read.count} AS n FROM (SELECT ${dimensionExpr(env, dim)} AS v FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x WHERE v IS NOT NULL GROUP BY v ORDER BY n DESC, v${read.limit(BREAKDOWN_TOP)}`,
  );
}

export function breakdownSeries(
  env: Env,
  dim: Dimension,
  r: Range & { interval: Interval },
  values: readonly string[],
): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const inner = `SELECT ${read.bucket(n.inst(n.ts), r.interval)} AS bucket, ${dimensionExpr(env, dim)} AS v FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}`;
  const only =
    values.length === 0
      ? 'v IS NULL'
      : `v IS NULL OR v IN (${values.map((v) => p.add(v)).join(', ')})`;
  return finish(
    p,
    `SELECT bucket, v, ${read.count} AS n FROM (${inner}) x WHERE ${only} GROUP BY bucket, v`,
  );
}

export function topTotal(env: Env, r: Range): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  return finish(
    p,
    `SELECT ${env.dialect.read.count} AS n FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}`,
  );
}

export function topPages(env: Env, r: Range, limit: number): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  return finish(
    p,
    `SELECT ${read.top(limit)}page, ${read.count} AS n FROM (SELECT ${n.page} AS page FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x GROUP BY page ORDER BY n DESC, page${read.limit(limit)}`,
  );
}

export function consentSeries(env: Env, r: Range & { interval: Interval }): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  return finish(
    p,
    `SELECT bucket, SUM(g) AS granted, ${read.count} AS total FROM (SELECT ${read.bucket(n.inst(n.ts), r.interval)} AS bucket, CASE WHEN ${read.isTrue(n.truth('consent', n.consent))} THEN 1 ELSE 0 END AS g FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x GROUP BY bucket`,
  );
}

type ComputedPlan = Extract<NvrPlan, { source: 'computed' }>;
type ColumnPlan = Extract<NvrPlan, { source: 'column' }>;

/** Q1 of spec 10.11: totals and identified visits per bucket. */
export function nvrTotals(
  env: Env,
  r: Range & { interval: Interval },
  plan: ComputedPlan,
): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const identified = [
    plan.user === undefined ? undefined : `${env.dialect.quoteIdent(plan.user.name)} IS NOT NULL`,
    plan.ip === undefined ? undefined : `${env.dialect.quoteIdent(plan.ip.name)} IS NOT NULL`,
  ]
    .filter((x): x is string => x !== undefined)
    .join(' OR ');
  return finish(
    p,
    `SELECT bucket, ${read.count} AS total, SUM(identified) AS identified FROM (SELECT ${read.bucket(n.inst(n.ts), r.interval)} AS bucket, CASE WHEN ${read.isTrue(n.truth('consent', n.consent))} AND (${identified}) THEN 1 ELSE 0 END AS identified FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x GROUP BY bucket`,
  );
}

/**
 * Q2/Q3 of spec 10.11: identities whose first row in the range has no earlier row anywhere. One index probe per
 * identity. The probe carries the scope too, so rows of another tenant never make a visitor "returning".
 */
export function nvrNew(
  env: Env,
  r: Range & { interval: Interval },
  plan: ComputedPlan,
  kind: 'u' | 'i',
): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const col = kind === 'u' ? plan.user : plan.ip;
  if (col === undefined)
    throw new Error(`no ${kind === 'u' ? 'user id' : 'ip'} column for new-vs-returning`);
  const ident = env.dialect.quoteIdent(col.name);
  const userNull = kind === 'i' && n.user !== undefined ? `${n.user} IS NULL AND ` : '';
  const inner = `SELECT ${ident} AS ident, MIN(${n.ts}) AS first_ts FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)} AND ${read.isTrue(n.truth('consent', n.consent))} AND ${userNull}${ident} IS NOT NULL GROUP BY ${ident}`;
  const probe = `SELECT 1 FROM ${n.table} p WHERE p.${ident} = m.ident AND p.${n.ts} < ${p.date(r.from)}${scoped(env, p, 'p.')}`;
  return finish(
    p,
    `SELECT bucket, ${read.count} AS n FROM (SELECT ${read.bucket(n.inst('m.first_ts'), r.interval)} AS bucket FROM (${inner}) m WHERE NOT EXISTS (${probe})) y GROUP BY bucket`,
  );
}

/** Opt-in source: the stored write-time column. */
export function nvrColumn(
  env: Env,
  r: Range & { interval: Interval },
  plan: ColumnPlan,
): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const fv = env.dialect.quoteIdent(plan.column.name);
  return finish(
    p,
    `SELECT bucket, ${read.count} AS total, SUM(nw) AS new_count, SUM(rt) AS returning_count FROM (SELECT ${read.bucket(n.inst(n.ts), r.interval)} AS bucket, CASE WHEN ${read.isTrue(n.truth('isFirstVisit', fv))} THEN 1 ELSE 0 END AS nw, CASE WHEN ${read.isFalse(n.truth('isFirstVisit', fv))} THEN 1 ELSE 0 END AS rt FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x GROUP BY bucket`,
  );
}

/** Per-row "is this the identity's first row?" for the page of recent visits (spec 10.11, last paragraph). */
function firstFlag(env: Env, p: Params, plan: NvrPlan): string {
  const n = names(env);
  const read = env.dialect.read;
  if (!plan.available) return 'NULL';
  if (plan.source === 'column') {
    const fv = `r.${env.dialect.quoteIdent(plan.column.name)}`;
    return `CASE WHEN ${fv} IS NULL THEN NULL WHEN ${read.isTrue(n.truth('isFirstVisit', fv))} THEN 1 ELSE 0 END`;
  }
  const earlier = (col: string): string => {
    const tie = n.id === undefined ? '' : ` OR (p.${n.ts} = r.${n.ts} AND p.${n.id} < r.${n.id})`;
    return `CASE WHEN NOT EXISTS (SELECT 1 FROM ${n.table} p WHERE p.${col} = r.${col} AND (p.${n.ts} < r.${n.ts}${tie})${scoped(env, p, 'p.')}) THEN 1 ELSE 0 END`;
  };
  const branches: string[] = [];
  const consent = read.isTrue(n.truth('consent', `r.${n.consent}`));
  if (plan.user !== undefined) {
    const u = env.dialect.quoteIdent(plan.user.name);
    branches.push(`WHEN ${consent} AND r.${u} IS NOT NULL THEN ${earlier(u)}`);
  }
  if (plan.ip !== undefined) {
    const ip = env.dialect.quoteIdent(plan.ip.name);
    const noUser =
      plan.user === undefined ? '' : ` AND r.${env.dialect.quoteIdent(plan.user.name)} IS NULL`;
    branches.push(`WHEN ${consent}${noUser} AND r.${ip} IS NOT NULL THEN ${earlier(ip)}`);
  }
  return `CASE ${branches.join(' ')} ELSE NULL END`;
}

/** Promoted custom-field columns, in a stable order shared with the row mapper. */
export function promotedColumns(env: Env): { key: string; name: string }[] {
  return [...env.model.customFields.values()]
    .filter((f) => f.column !== undefined)
    .map((f) => ({ key: f.key, name: f.column?.name ?? '' }));
}

export function recentVisits(
  env: Env,
  r: Range & { limit: number; cursor: Cursor | undefined },
  plan: NvrPlan,
): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const col = (c: string | undefined, alias: string): string =>
    c === undefined ? `NULL AS ${alias}` : `r.${c} AS ${alias}`;
  // The select list is built first: its probes' parameters come before the WHERE clause's, as in the text.
  const select = [
    col(n.id, 'rid'),
    `${read.tsText(n.inst(`r.${n.ts}`))} AS ts_text`,
    `r.${n.page} AS page`,
    `CASE WHEN ${read.isTrue(n.truth('consent', `r.${n.consent}`))} THEN 1 ELSE 0 END AS consent_flag`,
    col(n.ip, 'ip_v'),
    col(n.user, 'user_v'),
    col(n.username, 'name_v'),
    col(n.email, 'email_v'),
    col(n.custom, 'custom_v'),
    ...promotedColumns(env).map((c, i) => col(env.dialect.quoteIdent(c.name), `pf${i}`)),
    `${firstFlag(env, p, plan)} AS first_flag`,
  ].join(', ');
  const top = read.top(r.limit + 1);
  let where = inRange(env, p, n.ts, r, 'r.');
  if (r.cursor !== undefined && n.id !== undefined) {
    const at = p.date(r.cursor.ts);
    where += ` AND (r.${n.ts} < ${at} OR (r.${n.ts} = ${p.date(r.cursor.ts)} AND r.${n.id} < ${p.add(r.cursor.id)}))`;
  }
  const order = n.id === undefined ? `r.${n.ts} DESC` : `r.${n.ts} DESC, r.${n.id} DESC`;
  return finish(
    p,
    `SELECT ${top}${select} FROM ${n.table} r WHERE ${where} ORDER BY ${order}${read.limit(r.limit + 1)}`,
  );
}

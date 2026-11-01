import type { CompiledQuery, SqlDialect } from '../dialect/types.js';
import type { ColumnModel, Role, SqlValue } from '../model/types.js';
import type { Interval } from '../protocol.js';
import type { Dimension, NvrPlan } from './capabilities.js';
import type { Cursor } from './params.js';
import { instantExpr, truthExpr } from './physical.js';
import type { SearchField } from './search/fields.js';
import type { Clause, TextMatch } from './search/parse.js';

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
/** A parsed explorer query (spec 18.2) and the fields bare terms search. Values are bound, never inlined. */
export interface SearchFilter {
  readonly clauses: readonly Clause[];
  readonly searchable: readonly SearchField[];
}
export interface Range {
  readonly from: Date;
  readonly to: Date;
  /** Explorer only: restricts every statement built for this range to the matching rows. */
  readonly filter?: SearchFilter | undefined;
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
    status: q('status'),
    reason: q('errorReason'),
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

/** `ts >= from AND ts < to` plus scope and the explorer filter, for the table reference named by `alias` ('' = unaliased). */
function inRange(env: Env, p: Params, ts: string, r: Range, alias = ''): string {
  // Parameters are added in text order: MySQL's `?` markers are positional (spec 5.1).
  const range = `${alias}${ts} >= ${p.date(r.from)} AND ${alias}${ts} < ${p.date(r.to)}${scoped(env, p, alias)}`;
  return r.filter === undefined ? range : `${range}${filterSql(env, p, r.filter, alias)}`;
}

// --- explorer filter (spec 18.2) ---------------------------------------------------------------------------------

/** LIKE metacharacters of all three dialects ('[' is one on SQL Server), escaped with '!' (F-39 forbids a backslash). */
const likeEscape = (v: string): string => v.replace(/[!%_[]/g, (c) => `!${c}`);

function likePattern(m: Extract<TextMatch, { value: string }>): string {
  const v = likeEscape(m.value);
  return m.kind === 'prefix' ? `${v}%` : m.kind === 'suffix' ? `%${v}` : `%${v}%`;
}

/** The field as text (what LOWER/LIKE and facets work on). */
function fieldText(env: Env, f: SearchField, alias: string): string {
  return dimensionExpr(env, f.dim, alias);
}

function textPredicate(env: Env, p: Params, f: SearchField, m: TextMatch, alias: string): string {
  const expr = fieldText(env, f, alias);
  if (m.kind === 'exists') return `${expr} IS NOT NULL`;
  if (m.kind === 'exact') return `LOWER(${expr}) = ${p.add(m.value)}`;
  return `LOWER(${expr}) LIKE ${p.add(likePattern(m))} ESCAPE '!'`;
}

function booleanPredicate(env: Env, f: SearchField, value: boolean, alias: string): string {
  const read = env.dialect.read;
  const d = f.dim;
  const col = (c: ColumnDefLike): string => `${alias}${env.dialect.quoteIdent(c.name)}`;
  const test = (expr: string): string => (value ? read.isTrue(expr) : read.isFalse(expr));
  switch (d.kind) {
    case 'consent': {
      const c = env.model.columns.find((x) => x.role === 'consent');
      if (c === undefined) throw new Error('consent column is not mapped');
      // NULL consent counts as denied (3.2), so `consent:false` is "not true".
      const truth = truthExpr(env.dialect.name, c, col(c));
      return value ? read.isTrue(truth) : `NOT (${caseOf(read.isTrue(truth))} = 1)`;
    }
    case 'isFirstVisit':
    case 'promoted': {
      if (d.column === undefined) throw new Error('boolean field without a column');
      return test(truthExpr(env.dialect.name, d.column, col(d.column)));
    }
    case 'json':
    case 'page':
    case 'statusClass':
      return `${fieldText(env, f, alias)} = '${value ? 'true' : 'false'}'`;
  }
}
type ColumnDefLike = { readonly name: string };
const caseOf = (pred: string): string => `CASE WHEN ${pred} THEN 1 ELSE 0 END`;

function numberPredicate(
  env: Env,
  p: Params,
  f: SearchField,
  c: Extract<Clause, { type: 'number' }>,
  alias: string,
): string {
  const d = f.dim;
  let expr: string;
  if (d.kind === 'promoted' && d.column !== undefined)
    expr = `${alias}${env.dialect.quoteIdent(d.column.name)}`;
  else if (d.kind === 'json' && d.column !== undefined)
    expr = env.dialect.read.jsonNumber(`${alias}${env.dialect.quoteIdent(d.column.name)}`, d.key);
  else throw new Error('number field without a column');
  return `${expr} ${c.op} ${p.add(c.value)}`;
}

function clauseSql(env: Env, p: Params, f: SearchFilter, c: Clause, alias: string): string {
  let pred: string;
  switch (c.type) {
    case 'term': {
      const pattern = `%${likeEscape(c.value)}%`;
      const any = f.searchable.map(
        (s) => `LOWER(${fieldText(env, s, alias)}) LIKE ${p.add(pattern)} ESCAPE '!'`,
      );
      pred = any.length === 0 ? '1 = 0' : any.join(' OR ');
      break;
    }
    case 'text':
      pred = textPredicate(env, p, c.field, c.match, alias);
      break;
    case 'boolean':
      pred = booleanPredicate(env, c.field, c.value, alias);
      break;
    case 'number':
      pred = numberPredicate(env, p, c.field, c, alias);
      break;
  }
  // NULL-safe negation: rows where the field is missing match `-x` (spec 18.2).
  return c.negate ? `${caseOf(`(${pred})`)} = 0` : `(${pred})`;
}

/** ` AND (...)` per clause, or '' for an empty query. */
function filterSql(env: Env, p: Params, f: SearchFilter, alias: string): string {
  return f.clauses.map((c) => ` AND ${clauseSql(env, p, f, c, alias)}`).join('');
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

/** A dimension as text. `alias` ('' or 'r.') qualifies every column reference. */
function dimensionExpr(env: Env, dim: Dimension, alias = ''): string {
  const n = names(env);
  const read = env.dialect.read;
  switch (dim.kind) {
    case 'page':
      return `${alias}${n.page}`;
    case 'consent':
      return `CASE WHEN ${read.isTrue(n.truth('consent', `${alias}${n.consent}`))} THEN 'true' ELSE 'false' END`;
    case 'isFirstVisit': {
      if (n.fv === undefined) throw new Error('isFirstVisit column is not mapped');
      const fv = `${alias}${n.fv}`;
      return `CASE WHEN ${fv} IS NULL THEN NULL WHEN ${read.isTrue(n.truth('isFirstVisit', fv))} THEN 'true' ELSE 'false' END`;
    }
    case 'json':
      if (n.custom === undefined) throw new Error('custom column is not mapped');
      return read.jsonKey(`${alias}${n.custom}`, dim.key);
    case 'statusClass': {
      if (dim.column === undefined) throw new Error('status column is not mapped');
      return statusClassExpr(`${alias}${env.dialect.quoteIdent(dim.column.name)}`);
    }
    case 'promoted': {
      if (dim.column === undefined || dim.fieldType === undefined) {
        throw new Error('promoted dimension without a column');
      }
      const quoted = `${alias}${env.dialect.quoteIdent(dim.column.name)}`;
      return read.castText(
        dim.fieldType === 'boolean' ? truthExpr(env.dialect.name, dim.column, quoted) : quoted,
        dim.fieldType,
      );
    }
  }
}

/** '1xx'..'5xx' from a status column; NULL stays NULL. Same text in every dialect. */
function statusClassExpr(col: string): string {
  return `CASE WHEN ${col} IS NULL THEN NULL WHEN ${col} >= 500 THEN '5xx' WHEN ${col} >= 400 THEN '4xx' WHEN ${col} >= 300 THEN '3xx' WHEN ${col} >= 200 THEN '2xx' ELSE '1xx' END`;
}

export const BREAKDOWN_TOP = 10;

export function breakdownTop(
  env: Env,
  dim: Dimension,
  r: Range,
  top = BREAKDOWN_TOP,
): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  return finish(
    p,
    `SELECT ${read.top(top)}v, ${read.count} AS n FROM (SELECT ${dimensionExpr(env, dim)} AS v FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x WHERE v IS NOT NULL GROUP BY v ORDER BY n DESC, v${read.limit(top)}`,
  );
}

/** Rows in range whose dimension value is NULL (explorer facets, spec 18.3). */
export function nullCount(env: Env, dim: Dimension, r: Range): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  return finish(
    p,
    `SELECT ${env.dialect.read.count} AS n FROM (SELECT ${dimensionExpr(env, dim)} AS v FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)}) x WHERE v IS NULL`,
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
    col(n.status, 'status_v'),
    col(n.reason, 'reason_v'),
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

// --- errors (spec 20.4) --------------------------------------------------------------------------------------------

const CLIENT = (s: string): string => `CASE WHEN ${s} >= 400 AND ${s} < 500 THEN 1 ELSE 0 END`;
const SERVER = (s: string): string => `CASE WHEN ${s} >= 500 THEN 1 ELSE 0 END`;

function statusColumn(env: Env): string {
  const s = names(env).status;
  if (s === undefined) throw new Error('status column is not mapped');
  return s;
}

/** Per bucket: rows with a status, 4xx and 5xx. Rows without a status (older rows) are not counted. */
export function errorsSeries(env: Env, r: Range & { interval: Interval }): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const s = statusColumn(env);
  return finish(
    p,
    `SELECT bucket, ${read.count} AS total, SUM(c4) AS c4, SUM(c5) AS c5 FROM (SELECT ${read.bucket(n.inst(n.ts), r.interval)} AS bucket, ${CLIENT(s)} AS c4, ${SERVER(s)} AS c5 FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)} AND ${s} IS NOT NULL) x GROUP BY bucket`,
  );
}

/** The pages with the most 4xx + 5xx responses. */
export function errorPages(env: Env, r: Range, limit: number): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const s = statusColumn(env);
  return finish(
    p,
    `SELECT ${read.top(limit)}page, ${read.count} AS n, SUM(c5) AS c5 FROM (SELECT ${n.page} AS page, ${SERVER(s)} AS c5 FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)} AND ${s} >= 400) x GROUP BY page ORDER BY n DESC, page${read.limit(limit)}`,
  );
}

/** The commonest (errorReason, status) pairs among 4xx + 5xx responses. A NULL reason is its own row. */
export function errorReasons(env: Env, r: Range, limit: number): CompiledQuery {
  const n = names(env);
  const p = new Params(env.dialect);
  const read = env.dialect.read;
  const s = statusColumn(env);
  const reason = n.reason ?? 'NULL';
  return finish(
    p,
    `SELECT ${read.top(limit)}rsn, st, ${read.count} AS n FROM (SELECT ${reason} AS rsn, ${s} AS st FROM ${n.table} WHERE ${inRange(env, p, n.ts, r)} AND ${s} >= 400) x GROUP BY rsn, st ORDER BY n DESC, st DESC, rsn${read.limit(limit)}`,
  );
}

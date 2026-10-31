import type { SqlDialect } from '../dialect/types.js';
import type { ColumnDef, ColumnModel, SqlValue } from '../model/types.js';
import type { ErrorCode, Visit } from '../types.js';
import { buildCustom, type CustomLimits } from './custom.js';
import { applyIpMode, normalizeIp, type IpConfig } from './ip.js';
import { cleanString, fitString, isPlainObject, stripQuery } from './limits.js';

export interface RowConfig {
  readonly page: {
    readonly keepQuery: boolean;
    readonly maxLength: number;
    readonly normalize?: ((path: string) => string) | undefined;
  };
  readonly ip: IpConfig;
  readonly limits: CustomLimits;
  readonly consentDefault: ((visit: Readonly<Visit>) => boolean) | undefined;
}
export interface Identity {
  readonly kind: 'u' | 'i';
  readonly value: string;
}
export interface Note {
  readonly code: ErrorCode;
  readonly message: string;
  readonly key?: string;
}
export type BuildResult =
  | {
      readonly ok: true;
      /** Aligned with model.insertColumns. */
      readonly values: SqlValue[];
      readonly consent: boolean;
      readonly identity: Identity | null;
      readonly notes: readonly Note[];
    }
  | { readonly ok: false; readonly issues: readonly string[]; readonly notes: readonly Note[] };

interface Input {
  readonly model: ColumnModel;
  readonly dialect: SqlDialect;
  readonly cfg: RowConfig;
  readonly visit: Visit;
  readonly now: Date;
}

interface Consent {
  readonly value: boolean;
  readonly issue?: string;
  readonly note?: Note;
}

function resolveConsent(visit: Readonly<Record<string, unknown>>, cfg: RowConfig): Consent {
  const given = visit['consent'];
  if (typeof given === 'boolean') return { value: given };
  if (given !== undefined && given !== null) {
    // Never coerced, never trusted: the visit is kept as "no consent" so counts stay right (F-31), and reported.
    return {
      value: false,
      note: {
        code: 'invalid_visit',
        message: 'consent must be a boolean (it is never coerced): treated as "no consent"',
      },
    };
  }
  if (cfg.consentDefault === undefined) {
    return {
      value: false,
      note: {
        code: 'consent_missing',
        message: 'no consent given and no consent.default configured: treated as "no consent"',
      },
    };
  }
  try {
    const resolved: unknown = cfg.consentDefault(visit as unknown as Visit);
    if (typeof resolved === 'boolean') return { value: resolved };
  } catch {
    // fall through: a throwing resolver is treated as "no consent"
  }
  return {
    value: false,
    note: {
      code: 'consent_resolver_failed',
      message: 'consent.default threw or returned a non-boolean: treated as "no consent"',
    },
  };
}

type Fitted = { readonly value: string | null; readonly note?: Note } | { readonly issue: string };

/** Optional text field: absent/empty -> null; wrong type or too long (reject policy) -> issue. */
function textField(name: string, raw: unknown, max: number, cfg: RowConfig): Fitted {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { issue: `${name} must be a string` };
  const cleaned = cleanString(raw);
  if (cleaned === '') return { value: null };
  const fitted = fitString(cleaned, max, cfg.limits.oversize);
  return fitted === null ? { issue: `${name} exceeds ${max} characters` } : { value: fitted };
}

/** Accepts strings and finite SAFE integers; everything else is not a user id (visit kept, field NULL, reported). */
function userIdField(raw: unknown, max: number, cfg: RowConfig): Fitted {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw === 'number' && Number.isSafeInteger(raw))
    return textField('userId', String(raw), max, cfg);
  if (typeof raw === 'string') return textField('userId', raw, max, cfg);
  return {
    value: null,
    note: {
      code: 'invalid_user_id',
      message: 'userId must be a string or a safe integer and was not stored',
    },
  };
}

const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MATRIX_PARAMS = /;[^/?#]*/g;

/**
 * Page hygiene (F-14): an absolute URL is reduced to its path (scheme, userinfo and host never reach the table), a
 * path must start with "/", matrix parameters such as ;jsessionid are removed, and the host may template the path.
 */
function pageField(raw: unknown, cfg: RowConfig, notes: Note[]): Fitted {
  const NOT_A_PATH = { issue: 'pageVisited must be a path starting with "/"' };
  if (typeof raw !== 'string') return { issue: 'pageVisited must be a non-empty string' };
  let path = cleanString(raw).trim();
  if (ABSOLUTE_URL.test(path)) {
    try {
      const url = new URL(path);
      path = url.pathname + (cfg.page.keepQuery ? url.search + url.hash : '');
    } catch {
      return NOT_A_PATH;
    }
  }
  if (!path.startsWith('/')) return NOT_A_PATH;
  path = (cfg.page.keepQuery ? path : stripQuery(path)).replace(MATRIX_PARAMS, '').trim();
  if (path === '') return { issue: 'pageVisited must be a non-empty string' };
  if (cfg.page.normalize !== undefined) {
    try {
      const mapped: unknown = cfg.page.normalize(path);
      if (typeof mapped === 'string' && cleanString(mapped).trim().startsWith('/'))
        path = cleanString(mapped).trim();
      else throw new Error('normalize must return a path starting with "/"');
    } catch {
      notes.push({
        code: 'invalid_visit',
        message:
          'page.normalize threw or returned an invalid path; the cleaned path was stored instead',
      });
    }
  }
  const fitted = fitString(path, cfg.page.maxLength, cfg.limits.oversize);
  return fitted === null
    ? { issue: `pageVisited exceeds ${cfg.page.maxLength} characters` }
    : { value: fitted };
}

const maxOf = (c: ColumnDef): number => (c.type.kind === 'string' ? c.type.maxLength : 0);

/**
 * Pure: turns one visit into one row (spec 8.1). Never mutates its input and never throws for bad input;
 * problems come back as `issues` (reject) or `notes` (keep the visit, report a detail).
 */
export function buildRow({ model, dialect, cfg, visit, now }: Input): BuildResult {
  if (!isPlainObject(visit)) return { ok: false, issues: ['visit must be an object'], notes: [] };
  const raw = visit as Readonly<Record<string, unknown>>;
  const notes: Note[] = [];
  const issues: string[] = [];

  const consent = resolveConsent(raw, cfg);
  if (consent.issue !== undefined) issues.push(consent.issue);
  if (consent.note !== undefined) notes.push(consent.note);
  const granted = consent.value;

  const page = pageField(raw['pageVisited'], cfg, notes);
  if ('issue' in page) issues.push(page.issue);

  const custom = buildCustom(model, raw['custom'], granted, cfg.limits);
  notes.push(...custom.notes);
  if (!custom.ok) issues.push(...custom.issues);

  const values: SqlValue[] = [];
  let identity: Identity | null = null;
  for (const c of model.insertColumns) {
    let value: SqlValue = null;
    switch (c.role) {
      case 'timestamp':
        value = dialect.timestampParam(now);
        break;
      case 'consent':
        value = granted;
        break;
      case 'pageVisited':
        value = 'value' in page ? page.value : null;
        break;
      case 'ip':
        if (granted && raw['ip'] !== undefined && raw['ip'] !== null) {
          const norm = typeof raw['ip'] === 'string' ? normalizeIp(raw['ip']) : null;
          if (norm === null)
            notes.push({
              code: 'invalid_ip',
              message: 'ip is not a valid IP address and was not stored',
            });
          else value = applyIpMode(norm, cfg.ip);
        }
        break;
      case 'userId':
      case 'username':
      case 'email': {
        if (!granted) break;
        const f =
          c.role === 'userId'
            ? userIdField(raw[c.role], maxOf(c), cfg)
            : textField(c.role, raw[c.role], maxOf(c), cfg);
        if ('issue' in f) issues.push(f.issue);
        else {
          value = f.value;
          if (f.note !== undefined) notes.push(f.note);
        }
        break;
      }
      case 'custom':
        value = custom.ok ? custom.json : null;
        break;
      case 'promoted':
        value = custom.ok ? (custom.promoted.get(c.key) ?? null) : null;
        break;
      default:
        break; // isFirstVisit starts NULL; the writer fills it when write-time detection is enabled
    }
    values.push(value);
  }

  if (issues.length > 0) return { ok: false, issues, notes };

  if (granted && model.firstVisitEnabled) {
    const at = (col: ColumnDef | undefined): string | null => {
      const i = col === undefined ? -1 : model.insertColumns.indexOf(col);
      const v = i === -1 ? null : values[i];
      return typeof v === 'string' ? v : null;
    };
    const u = at(model.identity.userId);
    const ip = at(model.identity.ip);
    identity = u !== null ? { kind: 'u', value: u } : ip !== null ? { kind: 'i', value: ip } : null;
  }
  return { ok: true, values, consent: granted, identity, notes };
}

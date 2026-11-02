import { DynaliticsConfigError } from '../errors.js';
import { identifierMessage, isCustomKey, isIdentifier, parseTableRef } from './identifiers.js';
import type {
  ColumnDef,
  ColumnModel,
  CustomFieldDef,
  LogicalType,
  ResolvedCustomField,
  Role,
  SchemaConfig,
} from './types.js';
import { OPT_IN_ROLES, OPTIONAL_STORED_ROLES } from './types.js';

const DEFAULT_PAGE_LENGTH = 512;
const MAX_PAGE_LENGTH = 700;
const DEFAULT_CUSTOM_LENGTH = 128;
const MAX_CUSTOM_LENGTH = 1024;
const REQUIRED: readonly Role[] = ['timestamp', 'consent', 'pageVisited'];

interface RoleSpec {
  readonly name: string;
  readonly type: (pageLength: number) => LogicalType;
  readonly nullable: boolean;
  readonly personal: boolean;
}

const str = (maxLength: number) => (): LogicalType => ({ kind: 'string', maxLength });

/** Recommended-table defaults, in DDL order (spec 3.3). */
const ROLE_SPECS: readonly (readonly [Role, RoleSpec])[] = [
  ['id', { name: 'id', type: () => ({ kind: 'id' }), nullable: false, personal: false }],
  [
    'timestamp',
    { name: 'visited_at', type: () => ({ kind: 'timestamp' }), nullable: false, personal: false },
  ],
  [
    'consent',
    { name: 'consent', type: () => ({ kind: 'boolean' }), nullable: false, personal: false },
  ],
  [
    'pageVisited',
    {
      name: 'page_visited',
      type: (len) => ({ kind: 'string', maxLength: len }),
      nullable: false,
      personal: false,
    },
  ],
  ['ip', { name: 'ip_address', type: str(64), nullable: true, personal: true }],
  ['userId', { name: 'user_id', type: str(128), nullable: true, personal: true }],
  ['username', { name: 'username', type: str(128), nullable: true, personal: true }],
  ['email', { name: 'email', type: str(320), nullable: true, personal: true }],
  [
    'isFirstVisit',
    { name: 'is_first_visit', type: () => ({ kind: 'boolean' }), nullable: true, personal: true },
  ],
  ['custom', { name: 'custom', type: () => ({ kind: 'json' }), nullable: true, personal: false }],
  // Opt-in (OPT_IN_ROLES): request facts, not personal data, so they are kept on denied rows too (SECURITY.md).
  [
    'status',
    { name: 'status_code', type: () => ({ kind: 'integer' }), nullable: true, personal: false },
  ],
  ['errorReason', { name: 'error_reason', type: str(64), nullable: true, personal: false }],
];

/** `true` means "the default name"; a string is the name; false/undefined is "not given". */
const nameOf = (override: string | boolean | undefined, spec: RoleSpec): string | undefined =>
  override === true ? spec.name : typeof override === 'string' ? override : undefined;

function resolveTable(schema: SchemaConfig, issues: string[]): ColumnModel['table'] {
  try {
    return parseTableRef(schema.table);
  } catch (e) {
    issues.push(...(e instanceof DynaliticsConfigError ? e.issues : [String(e)]));
    return { name: 'invalid' };
  }
}

function resolveRoleColumns(
  schema: SchemaConfig,
  firstVisitEnabled: boolean,
  pageLength: number,
  issues: string[],
): ColumnDef[] {
  const overrides = schema.columns ?? {};
  const out: ColumnDef[] = [];
  for (const [role, spec] of ROLE_SPECS) {
    const override = overrides[role];
    if (override === false && REQUIRED.includes(role)) {
      issues.push(
        `columns.${role} is required and cannot be false (timestamp, consent and pageVisited must be stored).`,
      );
      continue;
    }
    if (role === 'isFirstVisit') {
      if (!firstVisitEnabled) {
        if (typeof override === 'string' || override === true) {
          issues.push(
            'columns.isFirstVisit is mapped but firstVisit.enabled is false. Enable write-time first-visit detection or unmap the column.',
          );
        }
        continue;
      }
      if (override === false) {
        issues.push('firstVisit.enabled needs columns.isFirstVisit; it cannot be false.');
        continue;
      }
    }
    if (override === false) continue;
    if (OPT_IN_ROLES.includes(role) && override === undefined) continue;
    const name = nameOf(override, spec) ?? spec.name;
    if (!isIdentifier(name)) {
      issues.push(identifierMessage(name, `columns.${role}`));
      continue;
    }
    out.push({
      role,
      key: role,
      name,
      type: spec.type(pageLength),
      nullable: spec.nullable,
      personal: spec.personal,
      dbGenerated: role === 'id',
    });
  }
  return out;
}

const REQUIRED_MESSAGE = (role: Role): string =>
  `columns.${role} is required when tableMode is "existing" (timestamp, consent and pageVisited must be mapped).`;

/**
 * tableMode "existing": `columns` is an explicit mapping. A role that is not listed (or is false) is unmapped and its
 * data is not stored. Only the three required roles are mandatory. Physical types are checked at startup (7.2).
 */
function resolveExistingRoleColumns(
  schema: SchemaConfig,
  firstVisitEnabled: boolean,
  pageLength: number,
  issues: string[],
): ColumnDef[] {
  const overrides = schema.columns ?? {};
  const out: ColumnDef[] = [];
  for (const [role, spec] of ROLE_SPECS) {
    const override = nameOf(overrides[role], spec);
    if (override === undefined) {
      if (REQUIRED.includes(role)) issues.push(REQUIRED_MESSAGE(role));
      continue;
    }
    if (role === 'isFirstVisit' && !firstVisitEnabled) {
      issues.push(
        'columns.isFirstVisit is mapped but firstVisit.enabled is false. Enable write-time first-visit detection or unmap the column.',
      );
      continue;
    }
    if (!isIdentifier(override)) {
      issues.push(identifierMessage(override, `columns.${role}`));
      continue;
    }
    out.push({
      role,
      key: role,
      name: override,
      type: spec.type(pageLength),
      nullable: spec.nullable,
      personal: spec.personal,
      dbGenerated: role === 'id',
    });
  }
  return out;
}

function promotedType(def: CustomFieldDef, maxLength: number): LogicalType {
  return def.type === 'string' ? { kind: 'string', maxLength } : { kind: def.type };
}

function resolveCustomFields(
  schema: SchemaConfig,
  hasJsonColumn: boolean,
  issues: string[],
): { fields: Map<string, ResolvedCustomField>; promoted: ColumnDef[] } {
  const fields = new Map<string, ResolvedCustomField>();
  const promoted: ColumnDef[] = [];
  for (const [key, def] of Object.entries(schema.customFields ?? {})) {
    if (!isCustomKey(key)) {
      issues.push(
        `${JSON.stringify(key)} is not a valid custom field key. Allowed: ^[A-Za-z_][A-Za-z0-9_]{0,63}$ (not __proto__, constructor or prototype).`,
      );
      continue;
    }
    const maxLength = def.maxLength ?? DEFAULT_CUSTOM_LENGTH;
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_CUSTOM_LENGTH) {
      issues.push(`customFields.${key}.maxLength must be an integer 1..${MAX_CUSTOM_LENGTH}.`);
      continue;
    }
    const personal = def.personal ?? true;
    if (def.keepWhenDenied === true && personal) {
      issues.push(
        `customFields.${key}.keepWhenDenied requires personal: false (a personal field is never stored without consent).`,
      );
      continue;
    }
    if (def.breakdown === true && personal) {
      issues.push(`customFields.${key}.breakdown requires personal: false.`);
      continue;
    }
    if (def.geo === 'country' && (def.type !== 'string' || personal || def.breakdown !== true)) {
      issues.push(
        `customFields.${key}.geo: 'country' requires type: 'string', personal: false and breakdown: true.`,
      );
      continue;
    }
    if (def.geo === 'country' && [...fields.values()].some((f) => f.geo === 'country')) {
      issues.push(`customFields.${key}.geo: only one custom field can be geo: 'country'.`);
      continue;
    }
    let column: ColumnDef | undefined;
    if (def.column !== undefined) {
      const name = def.column === true ? key : def.column;
      if (!isIdentifier(name)) {
        issues.push(identifierMessage(name, `customFields.${key}.column`));
        continue;
      }
      column = {
        role: 'promoted',
        key,
        name,
        type: promotedType(def, maxLength),
        nullable: true,
        personal,
        dbGenerated: false,
      };
      promoted.push(column);
    } else if (!hasJsonColumn) {
      issues.push(
        `customFields.${key} is not promoted to a column and no JSON column is mapped. Set customFields.${key}.column or map columns.custom.`,
      );
      continue;
    }
    fields.set(key, {
      key,
      type: def.type,
      maxLength,
      personal,
      breakdown: def.breakdown === true,
      keepWhenDenied: def.keepWhenDenied === true,
      ...(def.geo === 'country' ? { geo: 'country' as const } : {}),
      ...(column === undefined ? {} : { column }),
    });
  }
  return { fields, promoted };
}

function findDuplicateNames(columns: readonly ColumnDef[], issues: string[]): void {
  const seen = new Map<string, ColumnDef>();
  for (const c of columns) {
    const k = c.name.toLowerCase();
    const prev = seen.get(k);
    if (prev !== undefined) {
      issues.push(
        `${label(prev)} and ${label(c)} both map to "${c.name}"; each role needs its own column (names compare case-insensitively).`,
      );
    } else {
      seen.set(k, c);
    }
  }
}

const label = (c: ColumnDef): string =>
  c.role === 'promoted' ? `customFields.${c.key}` : `columns.${c.key}`;

/**
 * Pure and deterministic: the single source of truth that the generator, row builder, startup validator
 * and (later) the read queries all consume. Never mutates its input. Throws DynaliticsConfigError listing all issues.
 */
export function buildColumnModel(schema: SchemaConfig): ColumnModel {
  const issues: string[] = [];
  const existing = schema.tableMode === 'existing';
  const table = resolveTable(schema, issues);
  const pageLength = schema.page?.maxLength ?? DEFAULT_PAGE_LENGTH;
  if (!Number.isInteger(pageLength) || pageLength < 1 || pageLength > MAX_PAGE_LENGTH) {
    issues.push(`page.maxLength must be an integer 1..${MAX_PAGE_LENGTH}.`);
  }
  const firstVisitEnabled = schema.firstVisit?.enabled === true;
  const roleColumns = (existing ? resolveExistingRoleColumns : resolveRoleColumns)(
    schema,
    firstVisitEnabled,
    pageLength,
    issues,
  );
  const hasJson = roleColumns.some((c) => c.role === 'custom');
  const { fields, promoted } = resolveCustomFields(schema, hasJson, issues);
  const columns = [...roleColumns, ...promoted];
  findDuplicateNames(columns, issues);

  const byRole = (role: Role): ColumnDef | undefined => columns.find((c) => c.role === role);
  const userId = byRole('userId');
  const ip = byRole('ip');
  if (existing) {
    if (
      firstVisitEnabled &&
      (byRole('isFirstVisit') === undefined || (userId === undefined && ip === undefined))
    ) {
      issues.push(
        'firstVisit.enabled needs columns.isFirstVisit and at least one of columns.userId, columns.ip.',
      );
    }
  } else if (firstVisitEnabled && userId === undefined && ip === undefined) {
    issues.push('firstVisit.enabled needs at least one of columns.userId, columns.ip.');
  }
  if (issues.length > 0) throw new DynaliticsConfigError(issues);

  return {
    table,
    mode: existing ? 'existing' : 'recommended',
    columns,
    insertColumns: columns.filter((c) => !c.dbGenerated),
    unmappedRoles: OPTIONAL_STORED_ROLES.filter((r) => byRole(r) === undefined),
    customFields: fields,
    identity: { ...(userId === undefined ? {} : { userId }), ...(ip === undefined ? {} : { ip }) },
    firstVisitEnabled,
  };
}

import type { ColumnDef, ColumnModel, IpMode } from '../model/types.js';
import type { NewVsReturningBasis, UnavailableReason } from '../protocol.js';

/** 'page' exists only for the explorer (spec 18.3); `buildDimensions` never offers it as a breakdown. */
export type DimensionKind = 'page' | 'consent' | 'isFirstVisit' | 'json' | 'promoted';
export interface Dimension {
  readonly key: string;
  readonly kind: DimensionKind;
  readonly column?: ColumnDef;
  readonly fieldType?: 'string' | 'integer' | 'number' | 'boolean';
}

export type NvrPlan =
  | {
      readonly available: true;
      readonly source: 'computed';
      readonly basis: NewVsReturningBasis;
      readonly approximate: boolean;
      readonly user: ColumnDef | undefined;
      readonly ip: ColumnDef | undefined;
    }
  | {
      readonly available: true;
      readonly source: 'column';
      readonly basis: NewVsReturningBasis;
      readonly approximate: true;
      readonly column: ColumnDef;
    }
  | { readonly available: false; readonly reason: UnavailableReason; readonly message: string };

export interface NvrOptions {
  readonly enabled: boolean;
  readonly source: 'computed' | 'column';
  readonly ipIdentity: 'auto' | 'always' | 'never';
}

export const UNAVAILABLE_MESSAGES: Readonly<Record<UnavailableReason, string>> = {
  no_identity_column:
    'New vs returning needs a user id or IP address column, and neither is configured.',
  identity_not_reliable:
    'New vs returning needs a user id column or untruncated IP addresses. Only truncated IP addresses are stored, and they cannot identify a visitor.',
  disabled_by_host: 'New vs returning is switched off for this dashboard.',
  column_not_mapped:
    'New vs returning is set to use the stored first-visit column, but write-time first-visit detection is not enabled.',
};

const unavailable = (reason: UnavailableReason): NvrPlan => ({
  available: false,
  reason,
  message: UNAVAILABLE_MESSAGES[reason],
});

/** Decides how (and whether) new-vs-returning can be answered for this table and configuration (spec 8.5.1). */
export function planNewVsReturning(model: ColumnModel, ipMode: IpMode, opts: NvrOptions): NvrPlan {
  if (!opts.enabled) return unavailable('disabled_by_host');
  if (opts.source === 'column') {
    const column = model.columns.find((c) => c.role === 'isFirstVisit');
    if (column === undefined || !model.firstVisitEnabled) return unavailable('column_not_mapped');
    return {
      available: true,
      source: 'column',
      basis: 'user_id_then_ip',
      approximate: true,
      column,
    };
  }
  const user = model.identity.userId;
  const ip = model.identity.ip;
  const ipAllowed =
    ip !== undefined &&
    (opts.ipIdentity === 'always' || (opts.ipIdentity === 'auto' && ipMode !== 'truncate'));
  if (user === undefined && !ipAllowed) {
    return unavailable(
      ip === undefined || opts.ipIdentity === 'never'
        ? 'no_identity_column'
        : 'identity_not_reliable',
    );
  }
  const basis: NewVsReturningBasis =
    user !== undefined && ipAllowed ? 'user_id_then_ip' : user !== undefined ? 'user_id' : 'ip';
  return {
    available: true,
    source: 'computed',
    basis,
    approximate: ipAllowed,
    user,
    ip: ipAllowed ? ip : undefined,
  };
}

/** Dimensions a request may name for `breakdown` (spec 10.7). Personal columns can never appear here. */
export function buildDimensions(model: ColumnModel): ReadonlyMap<string, Dimension> {
  const out = new Map<string, Dimension>();
  out.set('consent', { key: 'consent', kind: 'consent' });
  const fv = model.columns.find((c) => c.role === 'isFirstVisit');
  if (fv !== undefined && model.firstVisitEnabled)
    out.set('isFirstVisit', { key: 'isFirstVisit', kind: 'isFirstVisit', column: fv });
  const json = model.columns.find((c) => c.role === 'custom');
  for (const f of model.customFields.values()) {
    if (!f.breakdown || f.personal) continue;
    if (f.column !== undefined)
      out.set(f.key, { key: f.key, kind: 'promoted', column: f.column, fieldType: f.type });
    else if (json !== undefined) out.set(f.key, { key: f.key, kind: 'json', column: json });
  }
  return out;
}

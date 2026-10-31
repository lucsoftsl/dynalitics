import type { ColumnModel } from '../../model/types.js';
import type { SearchFieldInfo, SearchFieldType } from '../../protocol.js';
import type { Dimension } from '../capabilities.js';

/** One entry of the explorer allow-list (spec 18.1). Built from the column model, never from a request. */
export interface SearchField {
  readonly key: string;
  readonly type: SearchFieldType;
  /** Bare terms match this field. */
  readonly search: boolean;
  /** Usable in the field sidebar and as `split`. */
  readonly facet: boolean;
  /** How the field is read; shares the breakdown machinery (10.7). */
  readonly dim: Dimension;
}

export const MAX_FACETS = 8;

const TYPE_OF: Readonly<Record<'string' | 'integer' | 'number' | 'boolean', SearchFieldType>> = {
  string: 'text',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
};

/**
 * Personal columns (ip, userId, username, email), the id, the raw custom column and `personal: true` custom fields are
 * never added: a query naming them gets the same `unknown_field` as a typo (spec 18.4).
 */
export function buildSearchFields(model: ColumnModel): ReadonlyMap<string, SearchField> {
  const out = new Map<string, SearchField>();
  out.set('page', {
    key: 'page',
    type: 'text',
    search: true,
    facet: true,
    dim: { key: 'page', kind: 'page' },
  });
  out.set('consent', {
    key: 'consent',
    type: 'boolean',
    search: false,
    facet: true,
    dim: { key: 'consent', kind: 'consent' },
  });
  const fv = model.columns.find((c) => c.role === 'isFirstVisit');
  if (fv !== undefined && model.firstVisitEnabled) {
    out.set('isFirstVisit', {
      key: 'isFirstVisit',
      type: 'boolean',
      search: false,
      facet: true,
      dim: { key: 'isFirstVisit', kind: 'isFirstVisit', column: fv },
    });
  }
  const json = model.columns.find((c) => c.role === 'custom');
  for (const f of model.customFields.values()) {
    if (f.personal || out.has(f.key)) continue;
    const dim: Dimension | undefined =
      f.column !== undefined
        ? { key: f.key, kind: 'promoted', column: f.column, fieldType: f.type }
        : json !== undefined
          ? { key: f.key, kind: 'json', column: json, fieldType: f.type }
          : undefined;
    if (dim === undefined) continue;
    const type = TYPE_OF[f.type];
    out.set(f.key, { key: f.key, type, search: type === 'text', facet: f.breakdown, dim });
  }
  return out;
}

/** The facet fields in allow-list order, capped (spec 18.5: at most 1 + MAX_FACETS statements per request). */
export function facetFields(fields: ReadonlyMap<string, SearchField>): SearchField[] {
  return [...fields.values()].filter((f) => f.facet).slice(0, MAX_FACETS);
}

export function fieldInfo(fields: ReadonlyMap<string, SearchField>): SearchFieldInfo[] {
  const facets = new Set(facetFields(fields).map((f) => f.key));
  return [...fields.values()].map((f) => ({
    key: f.key,
    type: f.type,
    search: f.search,
    facet: facets.has(f.key),
  }));
}

import { isIdentifier } from '../model/identifiers.js';

export interface ScopeEntry {
  column: string;
  value: string | number | boolean;
}
export type ScopeOption = 'none' | ScopeEntry | readonly ScopeEntry[];

const MAX_ENTRIES = 8;
const MAX_STRING = 256;

/** Validates the `scope` option. Column names go through the strict identifier check; values are always bound. */
export function parseScope(option: unknown): { entries: readonly ScopeEntry[]; issues: string[] } {
  const issues: string[] = [];
  if (option === 'none') return { entries: [], issues };
  const list = Array.isArray(option) ? (option as unknown[]) : [option];
  if (list.length === 0 || list.length > MAX_ENTRIES) {
    issues.push(
      `options.scope: expected "none", an entry, or 1..${MAX_ENTRIES} entries of { column, value }`,
    );
    return { entries: [], issues };
  }
  const entries: ScopeEntry[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const path = Array.isArray(option) ? `options.scope[${i}]` : 'options.scope';
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push(`${path}: expected "none" or { column, value }`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== 'column' && key !== 'value') issues.push(`${path}.${key}: unknown key`);
    }
    const { column, value } = entry;
    if (!isIdentifier(column)) {
      issues.push(
        `${path}.column: must be a plain column name (letters, digits, underscore; at most 63 characters)`,
      );
    } else if (seen.has(column.toLowerCase())) {
      issues.push(`${path}.column: "${column}" is listed twice`);
    } else {
      seen.add(column.toLowerCase());
    }
    const okValue =
      (typeof value === 'string' && value.length <= MAX_STRING) ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean';
    if (!okValue)
      issues.push(
        `${path}.value: expected a string (max ${MAX_STRING} characters), a finite number or a boolean`,
      );
    if (isIdentifier(column) && okValue) entries.push({ column, value });
  });
  return { entries: issues.length === 0 ? entries : [], issues };
}

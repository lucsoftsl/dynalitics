import type { ColumnModel, ResolvedCustomField } from '../model/types.js';
import type { SqlValue } from '../model/types.js';
import { cleanString, fitString, isPlainObject, type Oversize } from './limits.js';

export interface CustomLimits {
  readonly customMaxKeys: number;
  readonly customMaxBytes: number;
  readonly oversize: Oversize;
}
export interface CustomNote {
  readonly code: 'unknown_custom_field';
  readonly key: string;
  readonly message: string;
}
export type CustomResult =
  | {
      readonly ok: true;
      /** The JSON column value (null when nothing to store). */
      readonly json: string | null;
      /** Values for promoted columns, by field key. */
      readonly promoted: ReadonlyMap<string, SqlValue>;
      readonly notes: readonly CustomNote[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
      readonly notes: readonly CustomNote[];
    };

function coerce(
  field: ResolvedCustomField,
  raw: unknown,
  oversize: Oversize,
): { ok: true; value: SqlValue } | { ok: false; issue: string } {
  const bad = (): { ok: false; issue: string } => ({
    ok: false,
    issue: `custom.${field.key} must be a ${field.type}`,
  });
  switch (field.type) {
    case 'string': {
      if (typeof raw !== 'string') return bad();
      const fitted = fitString(cleanString(raw), field.maxLength, oversize);
      return fitted === null
        ? { ok: false, issue: `custom.${field.key} exceeds ${field.maxLength} characters` }
        : { ok: true, value: fitted };
    }
    case 'integer':
      return Number.isSafeInteger(raw) ? { ok: true, value: raw as number } : bad();
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? { ok: true, value: raw } : bad();
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : bad();
  }
}

/**
 * Validates and splits custom values. Only DECLARED keys are ever read (via Object.hasOwn), so keys such as
 * __proto__ or constructor can never reach the output or touch a prototype.
 */
export function buildCustom(
  model: ColumnModel,
  provided: unknown,
  consent: boolean,
  limits: CustomLimits,
): CustomResult {
  const promoted = new Map<string, SqlValue>();
  if (provided === undefined || provided === null)
    return { ok: true, json: null, promoted, notes: [] };
  if (!isPlainObject(provided))
    return { ok: false, issues: ['custom must be an object'], notes: [] };

  const keys = Object.keys(provided);
  if (keys.length > limits.customMaxKeys) {
    return {
      ok: false,
      issues: [`custom has ${keys.length} keys; the limit is ${limits.customMaxKeys}`],
      notes: [],
    };
  }
  const notes: CustomNote[] = keys
    .filter((k) => !model.customFields.has(k))
    .map((k) => {
      const shown = cleanString(k).slice(0, 64);
      return {
        code: 'unknown_custom_field',
        key: shown,
        message: `custom field "${shown}" is not declared in customFields and was dropped`,
      };
    });

  const json: Record<string, SqlValue> = {};
  const issues: string[] = [];
  for (const field of model.customFields.values()) {
    // Strict (F-03): without consent only fields that explicitly opt in (keepWhenDenied) are even looked at.
    if (!consent && !field.keepWhenDenied) continue;
    const raw = Object.hasOwn(provided, field.key) ? provided[field.key] : undefined;
    if (raw === undefined || raw === null) continue;
    const result = coerce(field, raw, limits.oversize);
    if (!result.ok) {
      issues.push(result.issue);
      continue;
    }
    if (field.column === undefined) json[field.key] = result.value;
    else promoted.set(field.key, result.value);
  }
  if (issues.length > 0) return { ok: false, issues, notes };

  const text = Object.keys(json).length === 0 ? null : JSON.stringify(json);
  if (text !== null && Buffer.byteLength(text, 'utf8') > limits.customMaxBytes) {
    return {
      ok: false,
      issues: [`custom data is larger than ${limits.customMaxBytes} bytes`],
      notes,
    };
  }
  return { ok: true, json: text, promoted, notes };
}

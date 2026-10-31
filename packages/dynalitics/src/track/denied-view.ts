import type { ColumnModel, CustomValue } from '../model/types.js';
import { isPlainObject } from './limits.js';

/**
 * What any host code (for example a `compute` function of a `personal: false` extra column) may see when consent was
 * denied (spec 3.6, 8.2). It deliberately has no ip, userId, username or email, and only the custom fields that
 * opted in with `keepWhenDenied`.
 */
export interface DeniedVisitView {
  readonly pageVisited: string;
  readonly consent: false;
  readonly custom: Readonly<Record<string, CustomValue>>;
}

const isScalar = (v: unknown): v is CustomValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));

/** Builds the reduced view from an already-validated page and the raw custom data. Total: never throws. */
export function deniedView(
  model: ColumnModel,
  pageVisited: string,
  custom: unknown,
): DeniedVisitView {
  // null-prototype object: a "__proto__" or "constructor" key can never reach a real prototype
  const kept: Record<string, CustomValue> = Object.create(null) as Record<string, CustomValue>;
  if (isPlainObject(custom)) {
    for (const field of model.customFields.values()) {
      if (!field.keepWhenDenied || !Object.hasOwn(custom, field.key)) continue;
      const value = custom[field.key];
      if (isScalar(value)) kept[field.key] = value;
    }
  }
  return Object.freeze({ pageVisited, consent: false as const, custom: Object.freeze(kept) });
}

import type { MetaData } from '../protocol.js';
import { parseInstant } from './format.js';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Shape check at the trust boundary: /api/meta drives the whole UI (SPEC 10.9 rule 9). */
export function parseMeta(data: unknown): MetaData | null {
  if (!isObject(data) || data['version'] !== 2) return null;
  if (typeof data['now'] !== 'string' || Number.isNaN(parseInstant(data['now']))) return null;
  const { limits, defaults, widgets, fields, features } = data;
  if (![limits, defaults, widgets, fields, features].every(isObject)) return null;
  const lim = limits as Record<string, unknown>;
  const def = defaults as Record<string, unknown>;
  const numbers = [
    lim['maxRangeDays'],
    lim['topPagesMax'],
    lim['recentMax'],
    lim['newVsReturningMaxRangeDays'],
    def['rangeDays'],
    def['topPagesLimit'],
    def['recentLimit'],
  ];
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const w = widgets as Record<string, unknown>;
  if (
    !['visitsOverTime', 'topPages', 'consentRate', 'newVsReturning', 'recentVisits'].every((k) =>
      isObject(w[k]),
    )
  )
    return null;
  return {
    ...(data as unknown as MetaData),
    breakdowns: Array.isArray(data['breakdowns'])
      ? (data['breakdowns'] as MetaData['breakdowns'])
      : [],
  };
}

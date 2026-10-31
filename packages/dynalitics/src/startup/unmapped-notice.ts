import type { ColumnModel, Role } from '../model/types.js';

/** What an unmapped optional role means for the dashboard (spec 3.2). Empty when nothing is unmapped. */
export function unmappedEffects(model: ColumnModel): string[] {
  const off = (role: Role): boolean => model.unmappedRoles.includes(role);
  const effects: string[] = [];
  if (off('ip') && off('userId')) {
    effects.push('new-vs-returning is unavailable (no identity column)');
  } else if (off('ip')) {
    effects.push('new-vs-returning uses the user id only');
  } else if (off('userId')) {
    effects.push('new-vs-returning needs the ip column with an ip.mode other than "truncate"');
  }
  const hidden = (['username', 'email'] as const).filter(off);
  if (hidden.length > 0) effects.push(`recent-visits shows null for ${hidden.join(' and ')}`);
  if (off('id')) {
    effects.push(
      'recent-visits returns one page (no cursor) and rows with equal timestamps have no defined order',
    );
  }
  return effects;
}

export function unmappedNotice(model: ColumnModel): string | undefined {
  if (model.unmappedRoles.length === 0) return undefined;
  const effects = unmappedEffects(model);
  return `these roles are not mapped to a column, so this data is NOT stored: ${model.unmappedRoles.join(', ')}.${
    effects.length === 0 ? '' : ` Effects on the dashboard: ${effects.join('; ')}.`
  }`;
}

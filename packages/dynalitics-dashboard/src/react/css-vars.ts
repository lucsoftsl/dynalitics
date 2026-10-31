import type { CSSProperties } from 'react';

/** Inline style that carries only our own numbers as CSS custom properties (e.g. `--r`, `--i`). */
export function cssVars(vars: Readonly<Record<string, string | number>>): CSSProperties {
  return vars;
}

export const cx = (
  ...parts: readonly (string | false | null | undefined)[]
): string | undefined => {
  const out = parts.filter(Boolean).join(' ');
  return out === '' ? undefined : out;
};

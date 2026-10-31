import { useCallback, useEffect, useState } from 'react';
import type { ThemeSetting } from './types.js';

const STORAGE_KEY = 'dynalitics-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeState {
  /** Value for `data-theme`; undefined lets the stylesheet follow the OS. */
  readonly attr: 'light' | 'dark' | undefined;
  readonly isDark: boolean;
  /** Only the `system` setting shows a toggle; `light` and `dark` are fixed by the host. */
  readonly canToggle: boolean;
  readonly toggle: () => void;
}

function readStored(): 'light' | 'dark' | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Server and first client render are identical (no attribute, the CSS follows the OS); the stored
 * choice and the OS preference are read in effects, so there is no hydration mismatch.
 */
export function useTheme(setting: ThemeSetting): ThemeState {
  const [choice, setChoice] = useState<'light' | 'dark' | null>(null);
  const [osDark, setOsDark] = useState(false);

  useEffect(() => {
    if (setting !== 'system') return;
    setChoice(readStored());
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(DARK_QUERY);
    setOsDark(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setOsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setting]);

  const effective: 'light' | 'dark' =
    setting === 'system' ? (choice ?? (osDark ? 'dark' : 'light')) : setting;
  const toggle = useCallback(() => {
    const next = effective === 'dark' ? 'light' : 'dark';
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage blocked: the choice just does not persist */
    }
  }, [effective]);

  return {
    attr: setting === 'system' ? (choice ?? undefined) : setting,
    isDark: effective === 'dark',
    canToggle: setting === 'system',
    toggle,
  };
}

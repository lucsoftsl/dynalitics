import type { ReactNode } from 'react';
/** Ranges of the date selector; the server offers the ones within its `maxRangeDays`. */
export type RangeKey = '24h' | '7d' | '30d' | '90d';

/** `error` means /api/meta could not be read (not authorised, unreachable, unexpected reply). */
export type MetaStatus = 'loading' | 'ready' | 'error';

export type ThemeSetting = 'light' | 'dark' | 'system';

/** Extra fetch options for every request, e.g. an `Authorization` header (never logged or stored). */
export type GetRequestInit = () => RequestInit | Promise<RequestInit>;

export interface ProviderProps {
  /**
   * Same-origin path prefix of the dynalitics read endpoint, e.g. `/admin/analytics`. `''` or `/` mean
   * the site root. Anything that is not a plain path (for example an absolute URL) is treated as the root.
   */
  endpoint?: string;
  /** Called before every request. Headers and `credentials` returned here are merged into the request. */
  getRequestInit?: GetRequestInit;
  /** `system` (default) follows the OS and shows a theme button; `light` and `dark` fix the theme. */
  theme?: ThemeSetting;
  /** BCP 47 tag for number and date formatting. Labels stay English and times stay UTC. */
  locale?: string;
  /** Range shown first (if the server offers it); defaults to the server's default (7d). */
  defaultRange?: RangeKey;
  /** Called when the user picks another range, e.g. to mirror it in your router. */
  onRangeChange?: (range: RangeKey) => void;
  /** Replacement for `fetch` (advanced, and used by tests). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called by the "Reload page" button; defaults to `location.reload()`. */
  reloadPage?: () => void;
  className?: string;
  children?: ReactNode;
}

export interface DashboardProps extends Omit<ProviderProps, 'children'> {
  /** `main` (default) or `region`, when your page already has a main landmark. */
  landmark?: 'main' | 'region';
}

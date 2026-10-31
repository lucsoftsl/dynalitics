// dynalitics-dashboard/react: React components for the dynalitics read endpoint (docs/REACT.md).
// react and react-dom are optional peer dependencies; the stylesheet is `dynalitics-dashboard/react/styles.css`.
export { DynaliticsDashboard } from './DynaliticsDashboard.js';
export { DynaliticsProvider } from './provider.js';
export { useDynalitics } from './use-dynalitics.js';
export type { DynaliticsState } from './use-dynalitics.js';
export { RangeSelector } from './RangeSelector.js';
export { VisitsOverTime } from './panels/VisitsOverTime.js';
export { TopPages } from './panels/TopPages.js';
export { NewVsReturning } from './panels/NewVsReturning.js';
export { ConsentRate } from './panels/ConsentRate.js';
export { RecentVisits } from './panels/RecentVisits.js';
export type {
  DashboardProps,
  GetRequestInit,
  ProviderProps,
  RangeKey,
  ThemeSetting,
} from './types.js';

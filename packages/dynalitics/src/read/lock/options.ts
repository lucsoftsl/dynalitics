import { fn, int, req, str } from '../../config/validate.js';
import { BASE_PATH_PATTERN } from './base-path.js';

/**
 * Option rules owned by the lock layer. handler.ts spreads them into the one options rule (same key order, same
 * messages as before the extraction); `pii.reveal` is the lock's, `pii.maskUserId` is the database side's.
 */
export const lockOptionRules = {
  authorize: req(fn),
  basePath: str({
    min: 1,
    max: 200,
    pattern: BASE_PATH_PATTERN,
    hint: "must be '/' or segments like /admin/analytics (no '//', no '.', no query)",
  }),
  authorizeTimeoutMs: int({ min: 100, max: 60_000 }),
  dashboardHtml: str({ min: 1 }),
};

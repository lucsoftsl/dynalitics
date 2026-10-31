// basePath rules (QA F-07, F-17). The lock layer owns them: they decide what the page is told to call.

/** '/' or one or more non-empty segments, optionally with ONE trailing slash. No '//' (a protocol-relative URL). */
export const BASE_PATH_PATTERN = /^(\/|(\/[A-Za-z0-9_-]+)+\/?)$/;
export const isValidBasePath = (p: string): boolean => BASE_PATH_PATTERN.test(p);

/** What the client prepends to '/api/...': '' for the root, no trailing slash, so it never builds //api/meta. */
export const normalizeBasePath = (p: string): string => (p === '/' ? '' : p.replace(/\/$/, ''));

/**
 * Routes are exact matches on canonical paths only (F-17): no '//', '.', '%', ';', '?' or trailing slash. Letter case
 * is not decided here: '/API/meta' is canonical but is not a route, so the database side answers not_found.
 */
export const CANONICAL_PATH = /^(\/|(\/[A-Za-z0-9_-]+)+)$/;

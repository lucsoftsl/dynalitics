import type { AuthResult, Authorize, DynaliticsRequest } from '../types.js';

/** What authorize() said, read strictly. */
export interface Auth {
  readonly allowed: boolean;
  /** `revealPii === true` on an allowing result. Only one of the three reveal conditions (see gate.ts). */
  readonly revealPii: boolean;
  /** The host returned something other than true, false or { allowed: boolean }. Refused and reported. */
  readonly invalid: boolean;
}

/** Strict: only the boolean true or { allowed: true } grants access, only revealPii === true reveals. */
export function normalizeAuth(result: unknown): Auth {
  if (typeof result === 'boolean') return { allowed: result, revealPii: false, invalid: false };
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const r = result as Exclude<AuthResult, boolean>;
    if (typeof r.allowed === 'boolean') {
      return { allowed: r.allowed, revealPii: r.allowed && r.revealPii === true, invalid: false };
    }
  }
  return { allowed: false, revealPii: false, invalid: true };
}

export type AuthOutcome =
  | { readonly kind: 'decided'; readonly auth: Auth }
  /** authorize() threw, rejected or did not settle before the deadline. Always refused with 500, never 200. */
  | { readonly kind: 'failed' };

/** Always first, even for unknown paths. A hung authorize() must not hold the socket open forever. */
export async function authorizeWithDeadline(
  authorize: Authorize,
  request: DynaliticsRequest,
  timeoutMs: number,
): Promise<AuthOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('authorize timed out')), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([Promise.resolve().then(() => authorize(request)), deadline]);
    return { kind: 'decided', auth: normalizeAuth(result) };
  } catch {
    return { kind: 'failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

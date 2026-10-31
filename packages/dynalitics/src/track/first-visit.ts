import { createHmac } from 'node:crypto';
import type { Identity } from './build-row.js';

export interface FirstVisitDeps {
  readonly cacheSize: number;
  /** Random per process: keeps the LRU free of raw identifiers. */
  readonly processKey: Buffer;
  readonly maxParams: number;
  readonly lookup: (kind: 'u' | 'i', values: readonly string[]) => Promise<ReadonlySet<string>>;
}

export interface FirstVisit {
  /** true = first seen, false = seen before, null = unknown (no identity, or the lookup failed). */
  resolve(
    ids: readonly (Identity | null)[],
    onLookupFailed?: (err: unknown) => void,
  ): Promise<(boolean | null)[]>;
  /** Call only after the rows were inserted successfully. */
  commit(ids: readonly (Identity | null)[]): void;
  size(): number;
  debugKeys(): IterableIterator<string>;
}

/** Opt-in write-time detection (spec 8.5.2): bounded LRU of hashed identities plus a database lookup. */
export function createFirstVisit(deps: FirstVisitDeps): FirstVisit {
  const lru = new Map<string, true>();
  const keyOf = (id: Identity): string =>
    createHmac('sha256', deps.processKey)
      .update(`${id.kind}\0${id.value}`)
      .digest('hex')
      .slice(0, 32);

  const touch = (key: string): void => {
    lru.delete(key);
    lru.set(key, true);
    if (lru.size > deps.cacheSize) {
      const oldest = lru.keys().next();
      if (oldest.done !== true) lru.delete(oldest.value);
    }
  };

  async function lookupAll(
    pending: ReadonlyMap<string, Identity>,
    onFailed?: (err: unknown) => void,
  ): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>();
    for (const kind of ['u', 'i'] as const) {
      const entries = [...pending].filter(([, id]) => id.kind === kind);
      for (let at = 0; at < entries.length; at += deps.maxParams) {
        const chunk = entries.slice(at, at + deps.maxParams);
        try {
          const found = await deps.lookup(
            kind,
            chunk.map(([, id]) => id.value),
          );
          for (const [key, id] of chunk) out.set(key, !found.has(id.value));
        } catch (err) {
          onFailed?.(err);
          for (const [key] of chunk) out.set(key, null);
        }
      }
    }
    return out;
  }

  return {
    async resolve(ids, onLookupFailed) {
      const keys = ids.map((id) => (id === null ? null : keyOf(id)));
      const pending = new Map<string, Identity>();
      ids.forEach((id, n) => {
        const key = keys[n];
        if (id !== null && key !== null && key !== undefined && !lru.has(key)) pending.set(key, id);
      });
      const decided =
        pending.size === 0
          ? new Map<string, boolean | null>()
          : await lookupAll(pending, onLookupFailed);
      const used = new Set<string>();
      return ids.map((id, n) => {
        const key = keys[n];
        if (id === null || key === null || key === undefined) return null;
        if (lru.has(key) || used.has(key)) return false;
        used.add(key);
        return decided.get(key) ?? null;
      });
    },
    commit(ids) {
      for (const id of ids) if (id !== null) touch(keyOf(id));
    },
    size: () => lru.size,
    debugKeys: () => lru.keys(),
  };
}

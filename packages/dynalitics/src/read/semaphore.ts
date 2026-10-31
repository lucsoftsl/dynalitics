export interface Semaphore {
  /** Resolves to a release function, or null if no slot became free within `timeoutMs`. */
  acquire(timeoutMs: number): Promise<(() => void) | null>;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiters: ((release: (() => void) | null) => void)[] = [];

  const release = (): void => {
    const next = waiters.shift();
    if (next === undefined) active -= 1;
    else next(release); // hand the slot straight to the next waiter
  };

  return {
    acquire(timeoutMs) {
      if (active < max) {
        active += 1;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        const waiter = (r: (() => void) | null): void => {
          clearTimeout(timer);
          resolve(r);
        };
        waiters.push(waiter);
      });
    },
  };
}

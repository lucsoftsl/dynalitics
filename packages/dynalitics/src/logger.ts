import type { Redactor } from './redact.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/* eslint-disable no-console -- the default logger is the one place that writes to the console */
export const consoleLogger: Logger = {
  info: (msg) => console.info(`[dynalitics] ${msg}`),
  warn: (msg) => console.warn(`[dynalitics] ${msg}`),
  error: (msg) => console.error(`[dynalitics] ${msg}`),
};
/* eslint-enable no-console */

/** Redacts every message and swallows logger exceptions, so logging can never leak a secret or break the host. */
export function safeLogger(inner: Logger, redact: Redactor): Logger {
  const wrap =
    (fn: (msg: string) => void) =>
    (msg: string): void => {
      try {
        fn(redact(msg));
      } catch {
        // a broken logger must not break tracking
      }
    };
  return {
    info: wrap((m) => inner.info(m)),
    warn: wrap((m) => inner.warn(m)),
    error: wrap((m) => inner.error(m)),
  };
}

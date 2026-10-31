import type { Redactor } from './redact.js';
import type { ErrorInfo } from './types.js';
import type { Note } from './track/build-row.js';

const WINDOW_MS = 60_000;
const MAX_KEYS = 256;

export interface Reporter {
  /** Immediate, safe: redacts, swallows exceptions thrown by the host's onError. */
  report(info: ErrorInfo): void;
  /** Throttled to once per minute per code+key; the next emission carries the suppressed count. */
  note(note: Note): void;
  lastErrorAt(): string | null;
}

export function createReporter(
  onError: ((info: ErrorInfo) => void) | undefined,
  redact: Redactor,
  now: () => Date,
): Reporter {
  const windows = new Map<string, { at: number; suppressed: number }>();
  let last: string | null = null;

  const emit = (info: ErrorInfo): void => {
    last = now().toISOString();
    if (onError === undefined) return;
    try {
      onError({ ...info, message: redact(info.message) });
    } catch {
      // the host's callback must never break tracking
    }
  };

  return {
    report: emit,
    note(n) {
      const key = `${n.code}:${n.key ?? ''}`;
      const t = now().getTime();
      const w = windows.get(key);
      if (w !== undefined && t - w.at < WINDOW_MS) {
        w.suppressed += 1;
        return;
      }
      if (windows.size >= MAX_KEYS) windows.clear(); // bounded memory under hostile key churn
      windows.set(key, { at: t, suppressed: 0 });
      emit({
        code: n.code,
        message: n.message,
        ...(w !== undefined && w.suppressed > 0 ? { count: w.suppressed } : {}),
      });
    },
    lastErrorAt: () => last,
  };
}

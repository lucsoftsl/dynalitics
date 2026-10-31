import type { SqlDialect } from '../dialect/types.js';
import { isDriverError, type Driver } from '../driver/types.js';
import type { SafeCause } from '../errors.js';
import type { ColumnModel, SqlValue } from '../model/types.js';
import type { Identity } from '../track/build-row.js';
import type { FirstVisit } from '../track/first-visit.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { ErrorInfo, FlushResult, TrackResult } from '../types.js';

export interface QueuedRow {
  readonly values: readonly SqlValue[];
  readonly identity: Identity | null;
}
export interface PipelineDeps {
  readonly driver: Driver;
  readonly dialect: SqlDialect;
  readonly model: ColumnModel;
  readonly queue: ResolvedConfig['queue'];
  readonly firstVisit: FirstVisit | undefined;
  readonly report: (info: ErrorInfo) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
  readonly requestTimeoutMs: number;
}
export interface PipelineStats {
  queued: number;
  written: number;
  failed: number;
  droppedFull: number;
  queueLength: number;
}
export interface Pipeline {
  enqueue(row: QueuedRow): Promise<TrackResult>;
  flush(opts?: { timeoutMs?: number }): Promise<FlushResult>;
  close(opts?: { timeoutMs?: number }): Promise<FlushResult>;
  stats(): PipelineStats;
}

const causeOf = (err: unknown): SafeCause =>
  isDriverError(err) && err.safeCause !== undefined
    ? err.safeCause
    : { name: 'Error', message: 'unexpected error' };

const CIRCUIT_START_MS = 1_000;
const CIRCUIT_MAX_MS = 60_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const REPORT_EVERY_MS = 1_000;

interface Waiter {
  readonly row: QueuedRow;
  readonly resolve: (r: TrackResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}
interface FlushWaiter {
  readonly target: number;
  readonly done: () => void;
}

/**
 * Bounded in-memory queue with batched multi-row INSERTs (spec 9). One batch is in flight at a time, so write-time
 * first-visit resolution is race-free within one process.
 */
export function createPipeline(deps: PipelineDeps): Pipeline {
  const { driver, dialect, model, queue } = deps;
  const items: QueuedRow[] = [];
  const waiters: Waiter[] = [];
  const flushWaiters: FlushWaiter[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<FlushResult> | undefined;
  let accepted = 0;
  let settled = 0;
  let written = 0;
  let failed = 0;
  let droppedFull = 0;
  let unreported = 0;
  let lastReport = Number.NEGATIVE_INFINITY;
  // Circuit breaker for batch-wide failures (permission, missing object, read-only): stop hammering the database.
  let circuitUntil = 0;
  let cooldownMs = 0;

  const fvIndex = model.insertColumns.findIndex((c) => c.role === 'isFirstVisit');
  const maxBatch = Math.max(
    1,
    Math.min(
      queue.batchSize,
      Math.floor(dialect.limits.maxParams / model.insertColumns.length),
      dialect.limits.maxRowsPerInsert,
    ),
  );

  const settle = (n: number): void => {
    settled += n;
    for (const w of flushWaiters.splice(0)) {
      if (settled >= w.target) w.done();
      else flushWaiters.push(w);
    }
  };

  const reportDrops = (force = false): void => {
    if (unreported === 0 || (!force && deps.now() - lastReport < REPORT_EVERY_MS)) return;
    lastReport = deps.now();
    deps.report({
      code: 'queue_full',
      message: 'the dynalitics queue is full; new events are being dropped',
      count: unreported,
      dropped: unreported,
    });
    unreported = 0;
  };

  const admitWaiters = (): void => {
    while (waiters.length > 0 && items.length < queue.maxSize) {
      const w = waiters.shift();
      if (w === undefined) break;
      if (w.timer !== undefined) clearTimeout(w.timer);
      items.push(w.row);
      accepted++;
      w.resolve({ status: 'queued' });
    }
  };

  const backoff = (attempt: number): number =>
    Math.floor(
      deps.random() *
        Math.min(queue.retry.maxDelayMs, queue.retry.baseDelayMs * 2 ** (attempt - 1)),
    );

  const insert = (rows: readonly QueuedRow[]): Promise<readonly unknown[]> =>
    driver.query(
      dialect.buildInsert(
        model,
        rows.map((r) => r.values),
      ),
      { timeoutMs: deps.requestTimeoutMs },
    );

  function failureReport(err: unknown, dropped: number): ErrorInfo {
    const cause = causeOf(err);
    const denied = isDriverError(err) && err.permission;
    const hint = denied
      ? ` The writer credential needs INSERT on ${dialect.qualifiedTable(model.table)} (and USAGE on its identity sequence for PostgreSQL serial columns).`
      : '';
    return {
      code: 'insert_failed',
      message: `could not write ${dropped} event(s) to the database.${hint}`,
      dropped,
      cause,
    };
  }

  async function writeBatch(batch: readonly QueuedRow[]): Promise<void> {
    let rows = batch;
    const resolver = deps.firstVisit;
    if (resolver !== undefined && fvIndex !== -1) {
      const flags = await resolver.resolve(
        batch.map((r) => r.identity),
        (err) =>
          deps.report({
            code: 'lookup_failed',
            message:
              'write-time first-visit lookup failed; is_first_visit is NULL for affected rows. It needs SELECT on the identity columns for the writer; see sql --grants',
            cause: causeOf(err),
          }),
      );
      rows = batch.map((r, n) => ({
        ...r,
        values: r.values.map((v, i) => (i === fvIndex ? (flags[n] ?? null) : v)),
      }));
    }
    let lastErr: unknown;
    let transient = false;
    for (let attempt = 1; attempt <= queue.retry.attempts; attempt++) {
      try {
        await insert(rows);
        written += rows.length;
        resolver?.commit(rows.map((r) => r.identity));
        cooldownMs = 0;
        circuitUntil = 0;
        return;
      } catch (err) {
        lastErr = err;
        transient = driver.isTransient(err);
        if (!transient) break;
        if (attempt < queue.retry.attempts) await deps.sleep(backoff(attempt));
      }
    }
    const rowSpecific = isDriverError(lastErr) && lastErr.data;
    if (transient || rows.length === 1 || !rowSpecific) {
      failed += rows.length;
      const info = failureReport(lastErr, rows.length);
      if (!transient && !rowSpecific) {
        cooldownMs = cooldownMs === 0 ? CIRCUIT_START_MS : Math.min(CIRCUIT_MAX_MS, cooldownMs * 2);
        circuitUntil = deps.now() + cooldownMs;
        deps.report({
          ...info,
          message: `${info.message} This error affects every row, so pausing writes for ${Math.round(cooldownMs / 1000)}s.`,
        });
      } else {
        deps.report(info);
      }
      return;
    }
    // A permanent error: isolate the poison row(s) by retrying row by row, once.
    let lost = 0;
    for (const row of rows) {
      try {
        await insert([row]);
        written += 1;
        resolver?.commit([row.identity]);
      } catch (err) {
        lost += 1;
        lastErr = err;
      }
    }
    if (lost > 0) {
      failed += lost;
      deps.report(failureReport(lastErr, lost));
    }
  }

  async function drain(): Promise<void> {
    while (items.length > 0) {
      const batch = items.splice(0, maxBatch);
      admitWaiters();
      if (deps.now() < circuitUntil) {
        failed += batch.length; // circuit open: counted, not sent
        settle(batch.length);
        continue;
      }
      try {
        await writeBatch(batch);
      } catch (err) {
        failed += batch.length;
        deps.report(failureReport(err, batch.length));
      }
      settle(batch.length);
    }
  }

  function kick(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (running !== undefined) return;
    running = drain().finally(() => {
      running = undefined;
      if (items.length > 0) schedule();
    });
  }

  function schedule(): void {
    if (items.length >= queue.batchSize) return kick();
    if (timer !== undefined || items.length === 0) return;
    timer = setTimeout(kick, queue.flushIntervalMs);
    timer.unref?.();
  }

  function flush(opts?: { timeoutMs?: number }): Promise<FlushResult> {
    const target = accepted;
    const startWritten = written;
    const startFailed = failed;
    if (items.length > 0) kick();
    return new Promise<FlushResult>((resolve) => {
      const finish = (timedOut: boolean): FlushResult => ({
        written: written - startWritten,
        failed: failed - startFailed,
        timedOut,
      });
      if (settled >= target) return resolve(finish(false));
      const t = setTimeout(
        () => resolve(finish(true)),
        opts?.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS,
      );
      t.unref?.();
      flushWaiters.push({
        target,
        done: () => {
          clearTimeout(t);
          resolve(finish(false));
        },
      });
    });
  }

  return {
    enqueue(row) {
      if (closed) return Promise.resolve({ status: 'dropped', reason: 'closed' });
      if (items.length < queue.maxSize) {
        items.push(row);
        accepted++;
        schedule();
        return Promise.resolve({ status: 'queued' });
      }
      // 'block' mode too: past maxSize waiting callers, drop at once so pending calls (each retaining its visit)
      // cannot grow with the request rate (F-16).
      if (queue.backpressure === 'drop' || waiters.length >= queue.maxSize) {
        droppedFull++;
        unreported++;
        reportDrops();
        return Promise.resolve({ status: 'dropped', reason: 'queue_full' });
      }
      return new Promise<TrackResult>((resolve) => {
        const waiter: Waiter = { row, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          droppedFull++;
          unreported++;
          reportDrops();
          resolve({ status: 'dropped', reason: 'block_timeout' });
        }, queue.maxBlockMs);
        waiter.timer.unref?.();
        waiters.push(waiter);
      });
    },
    flush,
    close(opts) {
      closing ??= (async () => {
        closed = true;
        for (const w of waiters.splice(0)) {
          if (w.timer !== undefined) clearTimeout(w.timer);
          w.resolve({ status: 'dropped', reason: 'closed' });
        }
        const res = await flush({ timeoutMs: opts?.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS });
        const remaining = items.splice(0).length;
        if (remaining > 0) {
          failed += remaining;
          settle(remaining);
          deps.report({
            code: 'insert_failed',
            message: `${remaining} queued event(s) were not written before close() timed out`,
            dropped: remaining,
          });
        }
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        reportDrops(true);
        return { written: res.written, failed: res.failed + remaining, timedOut: res.timedOut };
      })();
      return closing;
    },
    stats: () => ({ queued: accepted, written, failed, droppedFull, queueLength: items.length }),
  };
}

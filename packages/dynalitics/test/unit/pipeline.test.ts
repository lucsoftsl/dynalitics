import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPipeline, type PipelineDeps } from '../../src/queue/pipeline.js';
import { getDialect } from '../../src/dialect/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { ErrorInfo } from '../../src/types.js';
import {
  batchWideError,
  fakeDriver,
  permanentError,
  permissionError,
  transientError,
  type FakeDriver,
} from '../helpers/fake-driver.js';

const model = buildColumnModel({ table: 'public.events' });
const row = (n: number) => ({
  values: ['2026-01-01T00:00:00.000Z', true, `/p${n}`, null, null, null, null, null],
  identity: null,
});

function setup(over: Partial<PipelineDeps['queue']> = {}, driver: FakeDriver = fakeDriver()) {
  const reports: ErrorInfo[] = [];
  const sleeps: number[] = [];
  const deps: PipelineDeps = {
    driver,
    dialect: getDialect('postgres'),
    model,
    queue: {
      maxSize: 10,
      batchSize: 3,
      flushIntervalMs: 1000,
      backpressure: 'drop',
      maxBlockMs: 500,
      retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      ...over,
    },
    firstVisit: undefined,
    report: (i) => void reports.push(i),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    now: () => Date.now(),
    requestTimeoutMs: 1000,
  };
  return { p: createPipeline(deps), driver, reports, sleeps };
}
const pagesOf = (d: FakeDriver) =>
  d.calls.flatMap((c) =>
    c.params.filter((x): x is string => typeof x === 'string' && x.startsWith('/p')),
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('batching', () => {
  test('rows below batchSize wait for the flush interval, then go out in one multi-row INSERT', async () => {
    const { p, driver } = setup();
    expect(await p.enqueue(row(1))).toEqual({ status: 'queued' });
    await p.enqueue(row(2));
    expect(driver.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]?.sql).toMatch(/^INSERT INTO "public"\."events"/);
    expect(pagesOf(driver)).toEqual(['/p1', '/p2']);
    expect(p.stats().written).toBe(2);
  });

  test('reaching batchSize flushes immediately and splits into batches of batchSize', async () => {
    const { p, driver } = setup();
    for (let n = 1; n <= 7; n++) await p.enqueue(row(n));
    await p.flush();
    const sizes = driver.calls.map((c) => (c.sql.match(/\(\$/g) ?? []).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(sizes.reduce((x, y) => x + y, 0)).toBe(7);
    expect(pagesOf(driver)).toEqual(['/p1', '/p2', '/p3', '/p4', '/p5', '/p6', '/p7']);
  });

  test('batch size respects the dialect parameter limit (SQL Server: 2100 params)', async () => {
    const d = fakeDriver();
    const reports: ErrorInfo[] = [];
    const p = createPipeline({
      driver: d,
      dialect: getDialect('mssql'),
      model,
      queue: {
        maxSize: 5000,
        batchSize: 1000,
        flushIntervalMs: 1000,
        backpressure: 'drop',
        maxBlockMs: 1,
        retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
      firstVisit: undefined,
      report: (i) => void reports.push(i),
      sleep: () => Promise.resolve(),
      random: () => 0,
      now: () => 0,
      requestTimeoutMs: 1000,
    });
    for (let n = 0; n < 600; n++) await p.enqueue(row(n));
    await p.flush();
    expect(Math.max(...d.calls.map((c) => c.params.length))).toBeLessThanOrEqual(2100);
    expect(p.stats().written).toBe(600);
  });
});

describe('backpressure', () => {
  test('drop: when full the NEW event is dropped, counted and reported (coalesced)', async () => {
    const { p, reports } = setup({ maxSize: 2, batchSize: 100 });
    await p.enqueue(row(1));
    await p.enqueue(row(2));
    expect(await p.enqueue(row(3))).toEqual({ status: 'dropped', reason: 'queue_full' });
    await p.enqueue(row(4));
    expect(p.stats()).toMatchObject({ droppedFull: 2, queueLength: 2 });
    expect(reports.filter((r) => r.code === 'queue_full')).toHaveLength(1);
    await p.flush();
  });

  test('drop: the queued events are the OLD ones and they are still written', async () => {
    const { p, driver } = setup({ maxSize: 2, batchSize: 100 });
    await p.enqueue(row(1));
    await p.enqueue(row(2));
    await p.enqueue(row(3));
    await p.flush();
    expect(pagesOf(driver)).toEqual(['/p1', '/p2']);
  });

  test('block: track waits for space and is then queued', async () => {
    const { p, driver } = setup({
      maxSize: 2,
      batchSize: 100,
      backpressure: 'block',
      maxBlockMs: 5000,
    });
    await p.enqueue(row(1));
    await p.enqueue(row(2));
    const third = p.enqueue(row(3));
    let settled = false;
    void third.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); // the flush interval drains the queue and admits the waiter
    expect(await third).toEqual({ status: 'queued' });
    await p.flush();
    expect(pagesOf(driver)).toEqual(['/p1', '/p2', '/p3']);
  });

  test('block: gives up after maxBlockMs and drops with block_timeout', async () => {
    const slow = fakeDriver(() => new Promise(() => undefined));
    const { p } = setup({ maxSize: 1, batchSize: 1, backpressure: 'block', maxBlockMs: 500 }, slow);
    await p.enqueue(row(1));
    await vi.advanceTimersByTimeAsync(0); // batch 1 is now in flight and never completes
    await p.enqueue(row(2)); // fills the queue
    const third = p.enqueue(row(3));
    await vi.advanceTimersByTimeAsync(500);
    expect(await third).toEqual({ status: 'dropped', reason: 'block_timeout' });
  });
});

describe('retry and failure handling', () => {
  test('transient errors are retried with exponential backoff and full jitter, then succeed', async () => {
    let n = 0;
    const d = fakeDriver(() => {
      if (n++ < 2) throw transientError();
      return [];
    });
    const { p, sleeps, reports } = setup({}, d);
    await p.enqueue(row(1));
    await p.flush();
    expect(d.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]); // random() = 1 -> the full delay
    expect(p.stats()).toMatchObject({ written: 1, failed: 0 });
    expect(reports).toEqual([]);
  });

  test('transient errors beyond the attempts drop the batch and report insert_failed with a count', async () => {
    const d = fakeDriver(() => {
      throw transientError();
    });
    const { p, reports } = setup({}, d);
    await p.enqueue(row(1));
    await p.enqueue(row(2));
    await p.flush();
    expect(d.calls).toHaveLength(3);
    expect(p.stats()).toMatchObject({ written: 0, failed: 2 });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ code: 'insert_failed', dropped: 2 });
    expect(reports[0]?.cause).toEqual({
      name: 'Error',
      code: 'ECONNRESET',
      message: 'connection reset',
    });
  });

  test('a permanent error retries row by row once, so one poison row costs one event', async () => {
    const d = fakeDriver((q) => {
      if (q.params.includes('/p2')) throw permanentError();
      return [];
    });
    const { p, reports } = setup({}, d);
    for (const n of [1, 2, 3]) await p.enqueue(row(n));
    await p.flush();
    expect(p.stats()).toMatchObject({ written: 2, failed: 1 });
    expect(d.calls).toHaveLength(1 + 3);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ code: 'insert_failed', dropped: 1 });
  });

  test('permission errors get an actionable hint (from the error class, not from message text)', async () => {
    const d = fakeDriver(() => {
      throw permissionError();
    });
    const { p, reports } = setup({}, d);
    await p.enqueue(row(1));
    await p.flush();
    expect(reports[0]?.message).toContain(
      'The writer credential needs INSERT on "public"."events"',
    );
  });
});

describe('flush and close', () => {
  test('flush waits for everything queued, returns counts, and never rejects', async () => {
    const { p } = setup();
    await p.enqueue(row(1));
    await p.enqueue(row(2));
    expect(await p.flush()).toEqual({ written: 2, failed: 0, timedOut: false });
    expect(await p.flush()).toEqual({ written: 0, failed: 0, timedOut: false });
  });

  test('flush honours timeoutMs', async () => {
    const stuck = fakeDriver(() => new Promise(() => undefined));
    const { p } = setup({}, stuck);
    await p.enqueue(row(1));
    const r = p.flush({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await r).toMatchObject({ timedOut: true });
  });

  test('close flushes, then refuses new events; it is idempotent', async () => {
    const { p, driver } = setup();
    await p.enqueue(row(1));
    const first = p.close();
    const second = p.close();
    expect(second).toBe(first);
    expect(await first).toEqual({ written: 1, failed: 0, timedOut: false });
    expect(await p.close()).toEqual({ written: 1, failed: 0, timedOut: false });
    expect(await p.enqueue(row(2))).toEqual({ status: 'dropped', reason: 'closed' });
    expect(pagesOf(driver)).toEqual(['/p1']);
  });

  test('close releases blocked producers and counts events it could not flush as failed', async () => {
    const stuck = fakeDriver(() => new Promise(() => undefined));
    const { p, reports } = setup(
      { maxSize: 2, batchSize: 1, backpressure: 'block', maxBlockMs: 10_000 },
      stuck,
    );
    await p.enqueue(row(1));
    await vi.advanceTimersByTimeAsync(0);
    await p.enqueue(row(2));
    await p.enqueue(row(3));
    const blocked = p.enqueue(row(4));
    const closing = p.close({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await blocked).toEqual({ status: 'dropped', reason: 'closed' });
    const res = await closing;
    expect(res.timedOut).toBe(true);
    expect(res.failed).toBe(2);
    expect(reports.some((r) => r.code === 'insert_failed' && r.dropped === 2)).toBe(true);
  });

  test('the flush timer does not keep the process alive', async () => {
    const { p } = setup();
    await p.enqueue(row(1));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await p.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('F-04: batch-wide failures do not hammer the database', () => {
  test('a permission error fails the batch ONCE (no row-by-row retries)', async () => {
    const d = fakeDriver(() => {
      throw batchWideError('permission denied for table events');
    });
    const { p, reports } = setup({ maxSize: 2000, batchSize: 200 }, d);
    for (let n = 0; n < 1000; n++) await p.enqueue(row(n));
    await p.flush();
    // at most one statement per batch that actually reached the database, never 1000 + batches
    expect(d.calls.length).toBeLessThanOrEqual(5);
    expect(p.stats().failed).toBe(1000);
    expect(reports.some((r) => r.code === 'insert_failed')).toBe(true);
  });

  test('after a batch-wide failure the circuit opens: later batches are dropped without touching the database, then it retries after the cool-down', async () => {
    let healthy = false;
    const d = fakeDriver(() => {
      if (!healthy) throw batchWideError('relation "events" does not exist');
      return [];
    });
    const { p, reports } = setup({ maxSize: 100, batchSize: 1 }, d);
    await p.enqueue(row(1));
    await p.flush();
    expect(d.calls).toHaveLength(1);
    await p.enqueue(row(2)); // circuit open
    await p.enqueue(row(3));
    await p.flush();
    expect(d.calls).toHaveLength(1);
    expect(p.stats().failed).toBe(3);
    expect(reports.filter((r) => r.message.includes('pausing writes'))).toHaveLength(1);

    healthy = true;
    await vi.advanceTimersByTimeAsync(1100); // first cool-down is 1 s
    await p.enqueue(row(4));
    await p.flush();
    expect(d.calls).toHaveLength(2);
    expect(p.stats().written).toBe(1);
    await p.enqueue(row(5)); // healthy again: the circuit stayed closed
    await p.flush();
    expect(p.stats().written).toBe(2);
  });

  test('the cool-down grows exponentially up to 60 s while the database keeps failing', async () => {
    const d = fakeDriver(() => {
      throw batchWideError('permission denied');
    });
    const { p } = setup({ maxSize: 100, batchSize: 1 }, d);
    const gaps: number[] = [];
    for (let round = 0; round < 8; round++) {
      await p.enqueue(row(round));
      await p.flush();
      const before = d.calls.length;
      let waited = 0;
      while (waited < 70_000) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
        await p.enqueue(row(1000 + round));
        await p.flush();
        if (d.calls.length > before) break;
      }
      gaps.push(waited);
    }
    expect(gaps[0]!).toBeLessThanOrEqual(1500);
    expect(gaps[2]!).toBeGreaterThan(gaps[0]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(61_000);
  });

  test('row-specific (data/constraint) errors still isolate the poison row', async () => {
    const d = fakeDriver((q) => {
      if (q.params.includes('/p2')) throw permanentError();
      return [];
    });
    const { p } = setup({}, d);
    for (const n of [1, 2, 3]) await p.enqueue(row(n));
    await p.flush();
    expect(p.stats()).toMatchObject({ written: 2, failed: 1 });
  });
});

describe('F-16: block mode bounds the number of waiting callers', () => {
  test('beyond maxSize waiters, track() is dropped immediately instead of retaining another pending call', async () => {
    const stuck = fakeDriver(() => new Promise(() => undefined));
    const { p } = setup(
      { maxSize: 2, batchSize: 1, backpressure: 'block', maxBlockMs: 60_000 },
      stuck,
    );
    const results = [];
    for (let n = 0; n < 50; n++) results.push(p.enqueue(row(n)));
    await vi.advanceTimersByTimeAsync(0);
    const settled = await Promise.race([
      Promise.all(results.slice(5)), // everything past (1 in flight + 2 queued + 2 waiting) resolves at once
      new Promise((r) => setTimeout(() => r('still pending'), 1)),
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).not.toBe('still pending');
    expect(settled).toEqual(Array(45).fill({ status: 'dropped', reason: 'queue_full' }));
    expect(p.stats().droppedFull).toBe(45);
  });
});

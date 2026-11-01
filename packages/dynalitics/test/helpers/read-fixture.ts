import type { CompiledQuery, Row } from '../../src/dialect/types.js';
import { getDialect } from '../../src/dialect/index.js';
import { registerInternals } from '../../src/internals.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { Dialect, IpMode, SchemaConfig } from '../../src/model/types.js';
import { createRedactor } from '../../src/redact.js';
import type { Dynalitics, ErrorInfo } from '../../src/types.js';
import { fakeDriver, type FakeDriver } from './fake-driver.js';

export const NOW = new Date('2026-10-30T12:05:00.000Z');

export type Answers = Partial<{
  visits: Row[];
  top: Row[];
  topTotal: Row[];
  consent: Row[];
  totals: Row[];
  newUser: Row[];
  newIp: Row[];
  newColumn: Row[];
  recent: Row[];
  breakdownTop: Row[];
  breakdownSeries: Row[];
  errorsSeries: Row[];
  errorPages: Row[];
  errorReasons: Row[];
}>;

/** A fake reader that answers by recognising which builder produced the SQL. */
export function answerFor(a: Answers): (q: CompiledQuery) => Row[] {
  return (q) => {
    const s = q.sql;
    if (s.includes('AS ts_text')) return a.recent ?? [];
    if (s.includes('AS rsn')) return a.errorReasons ?? [];
    if (s.includes('SUM(c4) AS c4')) return a.errorsSeries ?? [];
    if (s.includes('SUM(c5) AS c5')) return a.errorPages ?? [];
    if (s.includes('AS identified')) return a.totals ?? [];
    if (s.includes('AS new_count')) return a.newColumn ?? [];
    if (s.includes('first_ts'))
      return s.includes('"user_id" IS NOT NULL GROUP BY "user_id"') &&
        !s.includes('"user_id" IS NULL AND')
        ? (a.newUser ?? [])
        : (a.newIp ?? []);
    if (s.includes('AS granted')) return a.consent ?? [];
    if (s.includes('ORDER BY n DESC, v')) return a.breakdownTop ?? [];
    if (s.includes('SELECT bucket, v, COUNT')) return a.breakdownSeries ?? [];
    if (s.startsWith('SELECT COUNT(*) AS n FROM')) return a.topTotal ?? [];
    if (s.includes('AS page FROM')) return a.top ?? [];
    if (s.includes('AS visits')) return a.visits ?? [];
    return [];
  };
}

export interface ReadFixture {
  dyn: Dynalitics;
  driver: FakeDriver;
  errors: ErrorInfo[];
  logs: string[];
  sql: () => string[];
}

export function readFixture(
  answers: Answers = {},
  schema: Partial<SchemaConfig> = {},
  opts: { ipMode?: IpMode; noReader?: boolean; dialect?: Dialect } = {},
): ReadFixture {
  const model = buildColumnModel({
    table: 'public.events',
    customFields: {
      plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
      campaign: { type: 'string', maxLength: 64 },
    },
    ...schema,
  });
  const driver = fakeDriver(answerFor(answers));
  const errors: ErrorInfo[] = [];
  const logs: string[] = [];
  const dyn = {
    capabilities: { canWrite: false, canRead: opts.noReader !== true },
    model,
    table: model.table,
    track: () => Promise.resolve({ status: 'rejected', issues: [] }),
    flush: () => Promise.resolve({ written: 0, failed: 0, timedOut: false }),
    close: () => Promise.resolve({ written: 0, failed: 0, timedOut: false }),
    stats: () => ({}),
  } as unknown as Dynalitics;
  registerInternals(dyn, {
    reader: opts.noReader === true ? undefined : driver,
    dialect: getDialect(opts.dialect ?? 'postgres'),
    model,
    ipMode: opts.ipMode ?? 'raw',
    redact: createRedactor([]),
    report: (i) => void errors.push(i),
    logger: {
      info: (m) => void logs.push(`info: ${m}`),
      warn: (m) => void logs.push(`warn: ${m}`),
      error: (m) => void logs.push(`error: ${m}`),
    },
    now: () => NOW,
  });
  return { dyn, driver, errors, logs, sql: () => driver.calls.map((c) => c.sql) };
}

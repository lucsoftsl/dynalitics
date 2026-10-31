import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  capNote,
  CAVEAT,
  CONSENT_SUB,
  EMPTY,
  ERROR_COPY,
  HINT_LONG,
  HINT_SHORT,
  NO_VALUE_NOTE,
  SSO_HINT,
  UNKNOWN_DEF,
} from '../../src/react/copy.js';

// The fixed copy lives twice: in src/ui (the HTML dashboard) and in src/react/copy.ts. If Dan changes a
// sentence, this test fails until the React copy follows, so the two dashboards never say different things.
const UI = join(import.meta.dirname, '../../src/ui');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)],
  );
const source = files(UI)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const must = (text: string): void => {
  expect(source, `missing in src/ui: ${text}`).toContain(text);
};

describe('copy parity with the HTML dashboard', () => {
  test('error copy per failure kind', () => {
    for (const c of Object.values(ERROR_COPY)) for (const t of [c.stamp, c.title, c.body]) must(t);
  });
  test('hints, notes and explanations', () => {
    for (const t of [
      SSO_HINT,
      HINT_LONG,
      HINT_SHORT,
      UNKNOWN_DEF,
      CAVEAT,
      NO_VALUE_NOTE,
      capNote(1),
    ])
      must(t);
    must('Showing the last ${cap} days: this widget is capped at ${cap} days.');
    expect(capNote(31)).toBe('Showing the last 31 days: this widget is capped at 31 days.');
    must(CONSENT_SUB('${f.num(totals.denied)}'));
  });
  test('empty states', () => {
    for (const e of Object.values(EMPTY)) {
      must(e.title);
      must(e.body);
    }
  });
});

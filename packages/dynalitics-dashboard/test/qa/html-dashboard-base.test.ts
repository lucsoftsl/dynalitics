// @vitest-environment jsdom
// QA-REVIEW-2 question 2: can the HTML dashboard be made to talk to another origin, and what would it send?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { normalizeBase, type FetchFn } from '../../src/ui/api.js';
import { startDashboard } from '../../src/ui/dashboard.js';
import { mockFetch } from '../fixtures/api.js';

const TEMPLATE = readFileSync(join(import.meta.dirname, '../../src/ui/template.html'), 'utf8');

function mountWithBase(base: string): { calls: { url: string; init: RequestInit | undefined }[] } {
  const body = /<body>([\s\S]*)<\/body>/.exec(TEMPLATE)?.[1] ?? '';
  document.body.innerHTML = body
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/\{\{version\}\}/g, 'test');
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const inner = mockFetch('ok');
  const spy: FetchFn = (input, init) => {
    calls.push({ url: input, init });
    return inner(input, init);
  };
  startDashboard({ base, fetchFn: spy, locale: 'en-GB', reloadPage: () => undefined });
  return { calls };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 25));
};
beforeEach(() => history.replaceState(null, '', '/'));

describe('normalizeBase (src/ui/api.ts)', () => {
  test.each(['/admin/analytics', '/a', '/a_b-c/d'])('%j stays a same-origin path prefix', (raw) => {
    expect(normalizeBase(raw)).toBe(raw);
  });
  test.each([
    '//evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/a b',
    '/a?x',
    '/..%2f',
    '\\\\evil',
    null,
    undefined,
    '',
  ])('%j becomes the page root', (raw) => {
    expect(normalizeBase(raw as string)).toBe('');
  });
  // KNOWN DEFECT (QA-REVIEW-2 F-02): '//host' without a dot, and '/a//b', pass the pattern. React's safeEndpoint
  // works around it; the HTML dashboard does not use that guard. test.fails flips to red when fixed.
  test.fails.each(['//evil', '//localhost', '//10', '///x', '/a//b', '//a/'])(
    '%j must become the page root (it currently survives)',
    (raw) => {
      expect(normalizeBase(raw)).not.toContain('//');
    },
  );
});

describe('what the HTML page would actually send to a protocol-relative base', () => {
  test('requests to //evil carry credentials "same-origin" (so no cookies cross-origin), redirect manual, only an accept header', async () => {
    const { calls } = mountWithBase('//evil');
    await settle();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith('//evil/api/')).toBe(true); // the defect: the URL leaves the origin
      expect(c.init?.credentials).toBe('same-origin'); // ...but the browser then sends NO cookies there
      expect(c.init?.redirect).toBe('manual');
      expect(Object.keys((c.init?.headers ?? {}) as object)).toEqual(['accept']); // no Authorization, no request-init hook exists
      expect(c.init?.body).toBeUndefined();
    }
  });
});

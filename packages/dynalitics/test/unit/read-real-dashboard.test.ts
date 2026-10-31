import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createHandler } from '../../src/read/handler.js';
import { readFixture } from '../helpers/read-fixture.js';

const built = resolve(__dirname, '../../../dynalitics-dashboard/dist/dashboard.html');

// Uses the real build output of the dashboard package when it exists (run `npm run build` first); skipped otherwise.
describe.skipIf(!existsSync(built))('the real built dashboard page is served correctly', () => {
  const html = existsSync(built) ? readFileSync(built, 'utf8') : '';
  const serve = async (basePath?: string) => {
    const f = readFixture();
    const handler = createHandler(f.dyn, {
      authorize: () => true,
      scope: 'none',
      dashboardHtml: html,
      ...(basePath === undefined ? {} : { basePath }),
    });
    return handler.handle({ method: 'GET', path: '/', query: {}, headers: {}, raw: {} });
  };

  test('both placeholders are filled, every inline script/style carries the nonce, and the CSP names that nonce', async () => {
    const res = await serve();
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('%%');
    const nonce = /nonce="([^"]+)"/.exec(res.body)?.[1] ?? '';
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const tags = res.body.match(/<(script|style)\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
    expect(res.headers['Content-Security-Policy']).toContain(`script-src 'nonce-${nonce}'`);
    expect(res.headers['Content-Security-Policy']).toContain(`style-src 'nonce-${nonce}'`);
  });

  test('the default base path reaches the page as the EMPTY string; a mounted one as the normalised path', async () => {
    expect((await serve()).body).toMatch(/<meta name="dynalitics-base" content="">/);
    expect((await serve('/admin/analytics/')).body).toMatch(
      /<meta name="dynalitics-base" content="\/admin\/analytics">/,
    );
  });
});

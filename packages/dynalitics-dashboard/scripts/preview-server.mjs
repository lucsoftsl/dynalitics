// Dev/preview server: serves the built page + typed mock API with the handler's real CSP.
// Not shipped. Scenarios are encoded in the base path: /s/<scenario>/  (e.g. /s/ok/, /s/forbidden/).
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { buildDashboardHtml } from './build-html.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadMock() {
  const out = join(await mkdtemp(join(tmpdir(), 'dyn-mock-')), 'api.mjs');
  await build({
    entryPoints: [join(root, 'test/fixtures/api.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  });
  return import(pathToFileURL(out).href);
}

export async function startPreview(port = 0) {
  const mock = await loadMock();
  const { html } = await buildDashboardHtml();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/s\/([a-z-]+)(\/.*)?$/.exec(url.pathname);
    if (!m) {
      res.writeHead(404).end('use /s/<scenario>/');
      return;
    }
    const scenario = m[1];
    const rest = m[2] ?? '/';
    if (rest === '/' || rest === '') {
      const nonce = randomBytes(16).toString('base64url');
      const page = html
        .replaceAll('%%DYNALITICS_NONCE%%', nonce)
        .replaceAll('%%DYNALITICS_BASE%%', `/s/${scenario}`);
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        })
        .end(page);
      return;
    }
    const api = /^\/api\/(.+)$/.exec(rest);
    if (!api) {
      res.writeHead(404).end();
      return;
    }
    const reply = mock.mockReply(scenario, api[1], url.searchParams);
    if (reply.drop) {
      req.socket.destroy();
      return;
    }
    setTimeout(() => {
      res.writeHead(reply.status, {
        'content-type': reply.text ? 'text/html' : 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(reply.text ?? JSON.stringify(reply.body));
    }, reply.delayMs ?? 0);
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return {
    server,
    port: server.address().port,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startPreview(Number(process.env.PORT ?? 4173));
  console.log(
    `preview: http://127.0.0.1:${port}/s/ok/  (scenarios: ok empty forbidden unreachable timeout slow ...)`,
  );
}

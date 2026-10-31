// Dev/preview server for the React dashboard: the BUILT package (dist/react, run `npm run build` first) mounted
// on a page, plus the typed mock API of test/fixtures/api.ts, served under a strict CSP. Not shipped.
// Scenarios are encoded in the path like scripts/preview-server.mjs: /s/ok/, /s/forbidden/, ...
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// No inline scripts or styles, no third parties. Inline style ATTRIBUTES are blocked, CSSOM writes are not:
// React sets styles through CSSOM on the client, which is what makes this CSP workable.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'";

async function loadMock() {
  const out = join(await mkdtemp(join(tmpdir(), 'dyn-react-mock-')), 'api.mjs');
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

export async function startReactPreview(port = 0) {
  if (!existsSync(join(root, 'dist/react/index.js')))
    throw new Error('dist/react is missing: run `npm run build` first');
  const mock = await loadMock();
  const bundle = await build({
    entryPoints: [join(root, 'scripts/preview-react-entry.mjs')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const js = bundle.outputFiles[0].text;
  const css = readFileSync(join(root, 'dist/react/dashboard.css'), 'utf8');
  const page =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>dynalitics (react preview)</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/page.css"><link rel="stylesheet" href="/assets/dashboard.css"></head>' +
    '<body><div id="root"></div><script src="/assets/main.js"></script></body></html>';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/assets/main.js')
      return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    // The host page's own CSS: the HTML dashboard owns <body>, a React component never does.
    if (url.pathname === '/assets/page.css')
      return void res.writeHead(200, { 'content-type': 'text/css' }).end('body { margin: 0; }');
    if (url.pathname === '/assets/dashboard.css')
      return void res.writeHead(200, { 'content-type': 'text/css' }).end(css);
    const m = /^\/s\/([a-z-]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return void res.writeHead(404).end('use /s/<scenario>/');
    const scenario = m[1];
    const rest = m[2] ?? '/';
    if (rest === '/' || rest === '') {
      return void res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': CSP,
        })
        .end(page);
    }
    const api = /^\/api\/(.+)$/.exec(rest);
    if (!api) return void res.writeHead(404).end();
    const reply = mock.mockReply(scenario, api[1], url.searchParams);
    if (reply.drop) return void req.socket.destroy();
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
  const { port } = await startReactPreview(Number(process.env.PORT ?? 4174));
  console.log(
    `react preview: http://127.0.0.1:${port}/s/ok/  (add ?theme=dark; scenarios: ok empty forbidden ...)`,
  );
}

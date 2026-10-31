import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorResponse } from './http.js';
import type { DynaliticsHandler, DynaliticsRequest, DynaliticsResponse } from './types.js';

function relativePath(pathname: string, basePath: string): string {
  // Express strips its mount path before we see req.url; a bare Node server or a Fetch route does not.
  if (basePath !== '' && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    return pathname.slice(basePath.length) || '/';
  }
  return pathname || '/';
}

function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) grouped.set(k, [...(grouped.get(k) ?? []), v]);
  // fromEntries defines own properties, so a "__proto__" key can never touch a prototype
  return Object.fromEntries([...grouped].map(([k, v]) => [k, v.length === 1 ? (v[0] ?? '') : v]));
}

/**
 * Express strips its mount path before we see req.url and records it in req.baseUrl. When that is set the prefix has
 * already been removed ONCE, so stripping it again would let /admin/analytics/admin/analytics/api/meta through (F-17).
 */
const mountedBy = (req: IncomingMessage): boolean => {
  const base = (req as { baseUrl?: unknown }).baseUrl;
  return typeof base === 'string' && base !== '';
};

/** Works as plain `http.createServer(listener)` handler and as Express middleware (`app.use(base, listener)`). */
export function toNodeListener(
  handler: DynaliticsHandler,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      let out: DynaliticsResponse;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const headers: Record<string, string | readonly string[] | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
        const request: DynaliticsRequest = {
          method: (req.method ?? 'GET').toUpperCase(),
          path: relativePath(url.pathname, mountedBy(req) ? '' : handler.basePath),
          query: queryOf(url.searchParams),
          headers,
          raw: req,
        };
        out = await handler.handle(request);
      } catch {
        out = errorResponse('internal');
      }
      res.writeHead(out.status, { ...out.headers });
      res.end(out.body);
    })();
  };
}

/** For Next.js route handlers and any Fetch-API runtime: `export const GET = toFetchHandler(handler)`. */
export function toFetchHandler(
  handler: DynaliticsHandler,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let out: DynaliticsResponse;
    try {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      out = await handler.handle({
        method: request.method.toUpperCase(),
        path: relativePath(url.pathname, handler.basePath),
        query: queryOf(url.searchParams),
        headers,
        raw: request,
      });
    } catch {
      out = errorResponse('internal');
    }
    return new Response(out.body, { status: out.status, headers: { ...out.headers } });
  };
}

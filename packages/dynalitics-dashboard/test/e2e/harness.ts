// Real-database harness for the dashboard e2e run (scripts/e2e-real.mjs). Dev tooling only: it imports the server
// package's sources and the integration fixtures, so it must never be reachable from src/ (a test guards that).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createDynalitics, createDynaliticsWith } from '../../../dynalitics/src/create.js';
import { adapterDriverFactory } from '../../../dynalitics/test/helpers/adapters.js';
import type { Dialect } from '../../../dynalitics/src/model/types.js';
import { createHandler, toNodeListener } from '../../../dynalitics/src/read/index.js';
import type { DynaliticsHandler } from '../../../dynalitics/src/read/types.js';
import { createRedactor } from '../../../dynalitics/src/redact.js';
import type { Dynalitics, TrackResult, Visit } from '../../../dynalitics/src/types.js';
import {
  ADAPTERS,
  norm,
  setupFixture,
  type Fixture,
} from '../../../dynalitics/test/integration/support.js';

const createDriver = await adapterDriverFactory();
import type { DbRow } from './oracle.js';

const customFields = {
  plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
} as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SeedStep {
  readonly label: string;
  /** Milliseconds before "now" at which the row is written (through the real track()). */
  readonly ago: number;
  readonly visit: Visit;
}

const long = `/${'x'.repeat(400)}/end`;
const alice = {
  userId: 'u_alice',
  username: 'alice',
  email: 'alice@example.com',
  ip: '198.51.100.10',
} as const;
const bob = {
  userId: 'u_bob',
  username: 'bob',
  email: 'bob@example.com',
  ip: '198.51.100.20',
} as const;
const carol = {
  userId: 'u_carol',
  username: 'carol',
  email: 'carol@example.com',
  ip: '198.51.100.30',
} as const;
const dave = {
  userId: 'u_dave',
  username: 'dave',
  email: 'dave@example.com',
  ip: '198.51.100.40',
} as const;
const mallory = {
  userId: 'u_mallory',
  username: '<b>mallory</b>',
  email: 'mallory@example.com',
  ip: '203.0.113.66',
} as const;

const v = (
  pageVisited: string,
  who: Partial<Visit> = {},
  consent = true,
  plan?: string,
): Visit => ({
  pageVisited,
  consent,
  ...(consent ? who : {}),
  ...(plan ? { custom: { plan } } : {}),
});

/** Seed plan. Older rows exist so that "returning" and the 31-day cap are real. */
export const SEED: readonly SeedStep[] = [
  { label: 'alice first', ago: 40 * DAY, visit: v('/pricing', alice, true, 'pro') },
  { label: 'bob first', ago: 40 * DAY, visit: v('/', bob, true, 'free') },
  {
    label: 'ip-only first (old)',
    ago: 35 * DAY,
    visit: v('/docs', { ip: '192.0.2.77' }, true, 'free'),
  },
  { label: 'carol first', ago: 20 * DAY, visit: v('/pricing', carol, true, 'team') },
  { label: 'alice again', ago: 10 * DAY, visit: v('/docs/getting-started', alice, true, 'pro') },
  { label: 'bob', ago: 3 * DAY, visit: v('/pricing', bob, true, 'free') },
  { label: 'dave first', ago: 3 * DAY - 2 * HOUR, visit: v('/blog/launch', dave, true, 'pro') },
  { label: 'declined 1', ago: 3 * DAY - 3 * HOUR, visit: v('/', {}, false) },
  { label: 'declined 2', ago: 3 * DAY - 4 * HOUR, visit: v('/pricing', {}, false) },
  { label: 'ip-only again', ago: 2 * DAY, visit: v('/docs', { ip: '192.0.2.77' }, true, 'free') },
  { label: 'ip-only new', ago: 2 * DAY - HOUR, visit: v('/docs', { ip: '192.0.2.88' }, true) },
  { label: 'carol', ago: 2 * DAY - 2 * HOUR, visit: v('/pricing', carol, true, 'team') },
  { label: 'alice', ago: DAY + 2 * HOUR, visit: v('/pricing', alice, true, 'pro') },
  {
    label: 'hostile img',
    ago: DAY + HOUR,
    visit: v('/<img src=x onerror=alert(1)>', mallory, true, 'free'),
  },
  {
    label: 'hostile javascript:',
    ago: 26 * HOUR,
    visit: v('javascript:alert(document.domain)', mallory),
  },
  {
    label: 'eve first',
    ago: 20 * HOUR,
    visit: v('/pricing', { userId: 'u_eve', ip: '203.0.113.5' }, true, 'pro'),
  },
  { label: 'dave again', ago: 10 * HOUR, visit: v('/pricing', dave, true, 'pro') },
  { label: 'declined 3', ago: 5 * HOUR, visit: v('/', {}, false) },
  { label: 'alice home', ago: 2 * HOUR, visit: v('/', alice) },
  { label: 'long path', ago: HOUR, visit: v(long, bob, true, 'free') },
  { label: 'rtl path', ago: HOUR / 2, visit: v('/‮evil/gpj.exe', carol) },
];

/** Sixteen more consented visits by four more users, so "recent visits" spans more than one page of 25. */
const FILLER: readonly SeedStep[] = Array.from({ length: 16 }, (_, i) => ({
  label: `filler ${i}`,
  ago: 6 * DAY - i * 2 * HOUR - 17 * 60_000,
  visit: v(
    `/docs/page-${i % 3}`,
    { userId: `u_f${i % 4}`, ip: `203.0.113.${100 + (i % 4)}`, email: `f${i % 4}@example.org` },
    true,
    ['pro', 'free', 'team'][i % 3],
  ),
}));

export interface Mount {
  readonly path: string;
  readonly note: string;
}

export interface Harness {
  readonly dialect: Dialect;
  readonly port: number;
  readonly table: string;
  /** Wall clock at seeding; every seeded row is `now - ago`. */
  readonly now: number;
  readonly trackResults: readonly { label: string; result: TrackResult }[];
  readonly mounts: readonly Mount[];
  readonly logs: string[];
  /** Requests that reached the sign-in page: a followed redirect would show up here. */
  readonly stats: { loginHits: number };
  rows(): Promise<DbRow[]>;
  /** Stops the server, drops tables and roles, and returns the names of anything that is still there. */
  close(): Promise<string[]>;
}

const asString = (x: unknown): string | null =>
  typeof x === 'string' || typeof x === 'number' || typeof x === 'bigint' ? String(x) : null;

export function toDbRow(raw: Record<string, unknown>): DbRow {
  const n = norm(raw);
  const custom = n['custom'] as { plan?: string } | null;
  return {
    id: String(n['id']),
    ts: Date.parse(String(n['visited_at'])),
    consent: n['consent'] === true,
    page: String(n['page_visited']),
    userId: asString(n['user_id']),
    ip: asString(n['ip_address']),
    email: asString(n['email']),
    username: asString(n['username']),
    plan: custom?.plan ?? null,
  };
}

const sink = (logs: string[], tag: string) => ({
  info: (m: string) => void logs.push(`${tag} info: ${m}`),
  warn: (m: string) => void logs.push(`${tag} warn: ${m}`),
  error: (m: string) => void logs.push(`${tag} error: ${m}`),
});

async function seed(fx: Fixture, dialect: Dialect, logs: string[]) {
  let clock = new Date();
  const t0 = clock.getTime();
  const writer = await createDynaliticsWith(
    {
      adapter: ADAPTERS[dialect],
      connection: { writer: { connectionString: fx.writerUrl } },
      table: fx.table,
      customFields,
      ip: { mode: 'raw' },
      logger: sink(logs, 'writer'),
      onError: (e) => void logs.push(`writer onError: ${e.code} ${e.message}`),
    },
    {
      createDriver: (adapter, options) => adapter.createDriver(options),
      now: () => clock,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
    },
  );
  const results: { label: string; result: TrackResult }[] = [];
  for (const step of [...SEED, ...FILLER]) {
    clock = new Date(t0 - step.ago);
    results.push({ label: step.label, result: await writer.track(step.visit) });
  }
  await writer.flush({ timeoutMs: 20_000 });
  await writer.close();
  return { t0, results };
}

/**
 * Rows a different writer could have put in the table. track() refuses `javascript:` paths and strips the RTL
 * override character, so the page cannot get them through the package; the dashboard must still render them inertly.
 */
export const DIRECT_PAGES: readonly { page: string; ago: number }[] = [
  { page: 'javascript:alert(document.domain)', ago: 3 * HOUR },
  { page: '/‮evil/gpj.exe', ago: 2 * HOUR + HOUR / 2 },
  { page: '"><script>alert(1)</script>', ago: 90 * 60_000 },
];

async function insertDirect(fx: Fixture, dialect: Dialect, t0: number): Promise<void> {
  const table = fx.table.split('.').map(fx.q).join('.');
  const cols = ['visited_at', 'consent', 'page_visited'].map(fx.q).join(', ');
  for (const { page, ago } of DIRECT_PAGES) {
    const iso = new Date(t0 - ago).toISOString();
    const at = dialect === 'postgres' ? `'${iso}'` : `'${iso.replace('T', ' ').replace('Z', '')}'`;
    const yes = dialect === 'postgres' ? 'true' : '1';
    await fx.run(
      `INSERT INTO ${table} (${cols}) VALUES (${at}, ${yes}, '${page.replace(/'/g, "''")}')`,
    );
  }
}

type Listener = (req: IncomingMessage, res: ServerResponse) => void;
type Wrapper = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
type HandlerOptions = Parameters<typeof createHandler>[1];

const LEFTOVER_SQL: Record<Dialect, string> = {
  postgres:
    "SELECT tablename AS n FROM pg_tables WHERE tablename LIKE 'dyn\\_it\\_%' UNION ALL SELECT rolname FROM pg_roles WHERE rolname LIKE 'dyn\\_%\\_%'",
  mysql:
    "SELECT table_name AS n FROM information_schema.tables WHERE table_name LIKE 'dyn\\_it\\_%' UNION ALL SELECT user AS n FROM mysql.user WHERE user LIKE 'dyn\\_%\\_%'",
  mssql: "SELECT name AS n FROM sys.tables WHERE name LIKE 'dyn[_]it[_]%'",
};

export async function startHarness(dialect: Dialect, dashboardHtml: string): Promise<Harness> {
  const logs: string[] = [];
  const fixtures: Fixture[] = [];
  const readers: Dynalitics[] = [];
  let server: Server | undefined;

  const fixture = async (): Promise<Fixture> => {
    const fx = await setupFixture(dialect, { customFields });
    fixtures.push(fx);
    return fx;
  };
  const readerFor = async (fx: Fixture): Promise<Dynalitics> => {
    const dyn = await createDynalitics({
      adapter: ADAPTERS[dialect],
      connection: { reader: { connectionString: fx.readerUrl } },
      table: fx.table,
      customFields,
      ip: { mode: 'raw' },
      logger: sink(logs, 'reader'),
    });
    readers.push(dyn);
    return dyn;
  };

  try {
    const main = await fixture();
    const seeded = await seed(main, dialect, logs);
    await insertDirect(main, dialect, seeded.t0);
    const empty = await fixture();
    const dyn = await readerFor(main);
    const emptyDyn = await readerFor(empty);

    const make = (
      d: Dynalitics,
      basePath: string,
      extra: Partial<HandlerOptions> = {},
    ): DynaliticsHandler =>
      createHandler(d, { authorize: () => true, basePath, dashboardHtml, scope: 'none', ...extra });

    const routes = new Map<string, Listener>();
    const mount = (
      prefix: string,
      handler: DynaliticsHandler,
      opts: { strip?: boolean; wrap?: Wrapper } = {},
    ): void => {
      const listener = toNodeListener(handler);
      routes.set(prefix, (req, res) => {
        const go = (): void => {
          if (opts.strip === true) {
            // What Express does: remove the mount path from req.url and record it in req.baseUrl.
            (req as IncomingMessage & { baseUrl?: string }).baseUrl = prefix;
            req.url = (req.url ?? '/').slice(prefix.length) || '/';
          }
          listener(req, res);
        };
        if (opts.wrap) opts.wrap(req, res, go);
        else go();
      });
    };
    const isApi = (req: IncomingMessage): boolean => (req.url ?? '').includes('/api/');

    mount('/admin', make(dyn, '/admin'));
    mount('/express', make(dyn, '/express'), { strip: true });
    mount('/empty', make(emptyDyn, '/empty'));
    // The page request itself goes through authorize (SPEC 10.3), so a host that denies "/" never serves the UI.
    // /locked and /boom cover that; /denied and /throws let the page load and then fail on /api/meta, which is what a
    // session that expires while the page is open looks like.
    mount('/locked', make(dyn, '/locked', { authorize: () => false }));
    mount(
      '/boom',
      make(dyn, '/boom', {
        authorize: () => {
          throw new Error('authorize blew up');
        },
      }),
    );
    mount('/denied', make(dyn, '/denied', { authorize: (req) => req.path === '/' }));
    mount(
      '/throws',
      make(dyn, '/throws', {
        authorize: (req) => {
          if (req.path === '/') return true;
          throw new Error('authorize blew up');
        },
      }),
    );
    mount(
      '/partial',
      make(dyn, '/partial', { authorize: (req) => req.path === '/' || req.path === '/api/meta' }),
    );
    mount(
      '/reveal',
      make(dyn, '/reveal', {
        pii: { reveal: true },
        authorize: () => ({ allowed: true, revealPii: true }),
      }),
    );
    mount('/wall', make(dyn, '/wall'), {
      wrap: (req, res, next) =>
        isApi(req)
          ? void res.writeHead(401, { 'content-type': 'text/plain' }).end('login required')
          : next(),
    });
    mount('/sso', make(dyn, '/sso'), {
      wrap: (req, res, next) =>
        isApi(req) ? void res.writeHead(302, { location: '/login' }).end() : next(),
    });
    const rootListener = toNodeListener(make(dyn, '/'));

    const stats = { loginHits: 0 };
    const srv = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      for (const [prefix, fn] of routes) {
        if (path === prefix || path.startsWith(`${prefix}/`)) return fn(req, res);
      }
      if (path === '/login') {
        stats.loginHits += 1;
        return void res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<title>Sign in</title>');
      }
      rootListener(req, res);
    });
    server = srv;
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const address = srv.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return {
      dialect,
      port,
      table: main.table,
      now: seeded.t0,
      trackResults: seeded.results,
      mounts: [
        { path: '/', note: "basePath '/' (QA F-07)" },
        { path: '/admin', note: "basePath '/admin', URL not stripped" },
        { path: '/express', note: "basePath '/express', mount path stripped like Express" },
        { path: '/empty', note: 'empty table' },
        { path: '/locked', note: 'authorize returns false for every request, page included' },
        { path: '/boom', note: 'authorize throws for every request, page included' },
        { path: '/denied', note: 'page allowed, /api/meta denied (session expired while open)' },
        { path: '/throws', note: 'page allowed, authorize throws on /api/meta' },
        { path: '/partial', note: 'page and meta allowed, every data route denied' },
        { path: '/reveal', note: 'pii.reveal and authorize revealPii' },
        { path: '/wall', note: 'host answers 401 text before the handler' },
        { path: '/sso', note: 'host redirects API calls to /login' },
      ],
      logs,
      stats,
      async rows() {
        return (await main.rows('ORDER BY 1')).map(toDbRow);
      },
      async close() {
        await new Promise<void>((ok) => srv.close(() => ok()));
        await Promise.allSettled(readers.map((r) => r.close()));
        const names = fixtures.flatMap((f) => [f.bareTable, f.writerName, f.readerName]);
        const adminUrl = fixtures[0]?.adminUrl;
        // Sequential on purpose: the fixtures revoke from the same schema ACL, and concurrent DROP OWNED BY loses a
        // race ("tuple concurrently updated") that the fixture's best-effort teardown then swallows.
        for (const f of fixtures) await f.cleanup().catch(() => undefined);
        if (adminUrl === undefined) return [];
        const admin = await createDriver(dialect, {
          credential: { connectionString: adminUrl },
          max: 1,
          connectTimeoutMs: 10_000,
          redact: createRedactor([]),
          requestTimeoutMs: 20_000,
        });
        try {
          const found = await admin.query(
            { sql: LEFTOVER_SQL[dialect], params: [] },
            { timeoutMs: 20_000 },
          );
          return found.map((r) => String(Object.values(r)[0])).filter((n) => names.includes(n));
        } finally {
          await admin.close();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled(readers.map((r) => r.close()));
    for (const f of fixtures) await f.cleanup().catch(() => undefined);
    server?.close();
    throw error;
  }
}

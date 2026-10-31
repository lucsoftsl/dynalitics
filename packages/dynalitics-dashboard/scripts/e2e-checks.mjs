// The checks of scripts/e2e-real.mjs. Three kinds of failure, named so the owner is obvious:
//   [handler]  the read API's JSON disagrees with the oracle computed from the raw table rows  -> Tom
//   [page]     what the page shows disagrees with the JSON it received                         -> Dan
//   [security] / [csp] / [state] / [layout]  the other contracts (masking, CSP, error states, overflow)
import { join } from 'node:path';

const WIDTHS = [320, 768, 1024, 1440];
const SCHEMES = ['light', 'dark'];
const short = (v) => (JSON.stringify(v) ?? 'undefined').slice(0, 260);
const nums = (s) => Number(String(s ?? '').replace(/[^\d]/g, ''));
const utcTime = (iso) => new Date(iso).toISOString().slice(11, 19);

export async function runChecks({ harness: h, browser, out, report, dialect, oracle }) {
  const base = `http://127.0.0.1:${h.port}`;
  const rows = await h.rows();
  // Self-test of the checks themselves: with this flag the oracle forgets the newest row, so they MUST fail.
  if (process.env.DYNALITICS_E2E_SABOTAGE === '1') rows.pop();
  const T = (name, ok, detail = '') => {
    report.checks += 1;
    if (!ok) report.failures.push(`[${dialect}] ${name}${detail ? `: ${detail}` : ''}`);
    return ok;
  };
  const same = (name, actual, expected) =>
    T(
      name,
      JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${short(expected)} but got ${short(actual)}`,
    );
  const note = (m) => report.notes.push(`[${dialect}] ${m}`);

  // ---- seeding facts (the real track() path) ----
  const rejected = h.trackResults.filter((t) => t.result.status !== 'queued');
  same(
    'track(): only the javascript: path is rejected',
    rejected.map((t) => t.label),
    ['hostile javascript:'],
  );
  T(
    'seeded rows reached the table',
    rows.length === h.trackResults.length - rejected.length + 3,
    `rows=${rows.length}`,
  );
  note(
    `seeded ${rows.length} rows (${h.trackResults.length - rejected.length} via track(), 3 by direct insert); track() rejected: ${rejected.map((t) => t.label).join(', ')}`,
  );
  note(
    `track() stored the RTL path as ${JSON.stringify(rows.find((r) => r.page.includes('evil/gpj'))?.page)} (control characters stripped on write)`,
  );
  T(
    'writer logged no unexpected errors',
    h.logs.filter((l) => /onError|error:/.test(l)).length === 1,
    short(h.logs.filter((l) => /onError|error:/.test(l))),
  );

  // ---- page plumbing ----
  async function open(mount, { width = 1440, scheme = 'light', expectErrors = false } = {}) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: scheme,
      reducedMotion: 'reduce',
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    const page = await ctx.newPage();
    const rec = { ctx, page, requests: [], responses: [], problems: [], mount };
    await page.addInitScript(() => {
      window.__csp = [];
      window.__xss = false;
      window.alert = () => {
        window.__xss = true;
      };
      document.addEventListener('securitypolicyviolation', (e) =>
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    });
    page.on('console', (m) => {
      if (!['error', 'warning'].includes(m.type())) return;
      if (expectErrors && /Failed to load resource/.test(m.text())) return;
      rec.problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => rec.problems.push(`pageerror: ${e.message}`));
    page.on('request', (r) => {
      if (r.url().includes('/api/') || r.url().endsWith('/login')) rec.requests.push(r.url());
    });
    page.on('response', async (r) => {
      if (!r.url().includes('/api/')) return;
      let body = null;
      try {
        body = await r.text();
      } catch {
        /* redirect responses have no body */
      }
      rec.responses.push({ url: r.url(), status: r.status(), body });
    });
    const nav = await page.goto(`${base}${mount === '/' ? '/' : `${mount}/`}`);
    rec.nav = nav;
    try {
      await settled(page);
    } catch {
      const state = await page
        .evaluate(() => ({
          panels: document.querySelectorAll('.dy-panel').length,
          busy: document.querySelectorAll('.dy-viz[aria-busy="true"]').length,
          text: (document.querySelector('#dy-grid')?.textContent ?? '').slice(0, 160),
        }))
        .catch(() => null);
      T(
        `[state] ${mount} @${width} ${scheme} settles`,
        false,
        short({ state, problems: rec.problems.slice(0, 3), requests: rec.requests.length }),
      );
    }
    return rec;
  }
  async function settled(page) {
    await page.waitForFunction(
      () => {
        const grid = document.querySelector('#dy-grid');
        if (!grid) return false;
        if (grid.querySelector('.dy-err') && !grid.querySelector('.dy-panel')) return true;
        return (
          grid.querySelectorAll('.dy-panel').length === 5 &&
          !document.querySelector('.dy-viz[aria-busy="true"]')
        );
      },
      null,
      { timeout: 25000 },
    );
    await page.waitForTimeout(250);
  }
  const apiPath = (url) => new URL(url).pathname.replace(/^.*\/api\//, '');
  const latest = (rec, route, pred = () => true) => {
    const hit = [...rec.responses]
      .reverse()
      .find(
        (r) => apiPath(r.url) === route && r.status === 200 && pred(new URL(r.url).searchParams),
      );
    return hit
      ? { ...hit, json: JSON.parse(hit.body), params: new URL(hit.url).searchParams }
      : null;
  };
  const win = (params) => ({
    from: Date.parse(params.get('from')),
    to: Date.parse(params.get('to')),
    interval: params.get('interval'),
  });

  // ---- JSON against the oracle (failures here are the handler's) ----
  function compareApi(rec, label, filter = {}) {
    const pick = (route, p) =>
      latest(rec, route, (s) => (filter[route] ?? (() => true))(s) && (p ? p(s) : true));
    const vot = pick('visits-over-time', (s) => !s.get('breakdown'));
    if (vot) {
      const { from, to, interval } = win(vot.params);
      const o = oracle.visitsOverTime(rows, from, to, interval);
      same(`[handler] ${label} visits-over-time points`, vot.json.data.points, o.points);
      same(`[handler] ${label} visits-over-time total`, vot.json.data.total, o.total);
    } else T(`${label}: visits-over-time response exists`, false);
    const tp = pick('top-pages');
    if (tp) {
      const { from, to } = win(tp.params);
      const o = oracle.topPages(rows, from, to);
      const d = tp.json.data;
      same(`[handler] ${label} top-pages totalVisits`, d.totalVisits, o.total);
      for (const p of d.pages)
        same(
          `[handler] ${label} top-pages count of ${JSON.stringify(p.page.slice(0, 30))}`,
          p.visits,
          o.counts.get(p.page),
        );
      same(
        `[handler] ${label} top-pages order is by visits`,
        d.pages.map((p) => p.visits),
        [...o.counts.values()].sort((a, b) => b - a).slice(0, d.pages.length),
      );
      same(
        `[handler] ${label} top-pages otherVisits`,
        d.otherVisits,
        o.total - d.pages.reduce((a, p) => a + p.visits, 0),
      );
      T(
        `[handler] ${label} top-pages share = visits/total`,
        d.pages.every((p) => Math.abs(p.share - p.visits / d.totalVisits) < 0.0006),
        short(d.pages.slice(0, 2)),
      );
    } else T(`${label}: top-pages response exists`, false);
    const cr = pick('consent-rate');
    if (cr) {
      const { from, to, interval } = win(cr.params);
      const o = oracle.consentRate(rows, from, to, interval);
      same(
        `[handler] ${label} consent-rate points`,
        cr.json.data.points.map(({ bucket, granted, denied }) => ({ bucket, granted, denied })),
        o.points,
      );
      same(
        `[handler] ${label} consent-rate totals`,
        { granted: cr.json.data.totals.granted, denied: cr.json.data.totals.denied },
        o.totals,
      );
      const t = o.totals;
      T(
        `[handler] ${label} consent-rate rate`,
        t.granted + t.denied === 0
          ? cr.json.data.totals.rate === null
          : Math.abs(cr.json.data.totals.rate - t.granted / (t.granted + t.denied)) < 0.0006,
        short(cr.json.data.totals),
      );
    } else T(`${label}: consent-rate response exists`, false);
    const nv = pick('new-vs-returning');
    if (nv) {
      const { from, to, interval } = win(nv.params);
      const o = oracle.newVsReturning(rows, from, to, interval);
      same(`[handler] ${label} new-vs-returning points`, nv.json.data.points, o.points);
      same(`[handler] ${label} new-vs-returning totals`, nv.json.data.totals, o.totals);
      same(
        `[handler] ${label} new-vs-returning identity basis`,
        [nv.json.data.basis, nv.json.data.approximate, nv.json.data.source],
        ['user_id_then_ip', true, 'computed'],
      );
      const v = oracle.visitsOverTime(rows, from, to, interval);
      same(
        `[handler] ${label} new+returning+unknown equals visits-over-time for the same window`,
        o.totals.new + o.totals.returning + o.totals.unknown,
        v.total,
      );
    } else T(`${label}: new-vs-returning response exists`, false);
    const rv = pick('recent-visits', (s) => !s.get('cursor'));
    if (rv) {
      const { from, to } = win(rv.params);
      const limit = Number(rv.params.get('limit'));
      const o = oracle.recentVisits(rows, from, to, limit);
      same(
        `[handler] ${label} recent-visits ids, newest first`,
        rv.json.data.visits.map((x) => x.id),
        o.map((r) => r.id),
      );
      same(
        `[handler] ${label} recent-visits timestamps`,
        rv.json.data.visits.map((x) => x.timestamp),
        o.map((r) => new Date(r.ts).toISOString()),
      );
      same(
        `[handler] ${label} recent-visits pages`,
        rv.json.data.visits.map((x) => x.pageVisited),
        o.map((r) => r.page),
      );
      same(
        `[handler] ${label} recent-visits consent`,
        rv.json.data.visits.map((x) => x.consent),
        o.map((r) => r.consent),
      );
    }
  }

  // ---- DOM against the JSON the page received (failures here are the page's) ----
  async function compareDom(rec, label) {
    const { page } = rec;
    const vot = latest(rec, 'visits-over-time', (s) => !s.get('breakdown'));
    const dom = await page.evaluate(() => {
      const legend = (sel) =>
        [...document.querySelectorAll(`${sel} .dy-legend li`)].map((li) => li.textContent.trim());
      return {
        hero: document.querySelector('.p-hero .dy-hero-num')?.textContent ?? '',
        pages: [...document.querySelectorAll('.p-pages .dy-page-row')].map((li) => ({
          other: li.classList.contains('dy-page-row--other'),
          page: li.querySelector('.dy-page')?.textContent,
          count: li.querySelector('.dy-count')?.textContent,
        })),
        consentLegend: legend('.p-consent'),
        nvrLegend: legend('.p-nvr'),
        consentKpi: document.querySelector('.p-consent .dy-kpi-num')?.textContent ?? '',
        nvrKpi: document.querySelector('.p-nvr .dy-kpi-num')?.textContent ?? '',
        updated: document.querySelector('#dy-updated')?.textContent ?? '',
      };
    });
    if (vot) {
      same(
        `[page] ${label} hero numeral = visits-over-time total`,
        nums(dom.hero),
        vot.json.data.total,
      );
      same(
        `[page] ${label} "Updated" is the server time in UTC although the browser zone is Los Angeles`,
        dom.updated,
        utcTime(vot.json.meta.generatedAt),
      );
    }
    const tp = latest(rec, 'top-pages');
    if (tp) {
      const list = dom.pages.filter((p) => !p.other);
      same(
        `[page] ${label} top pages list`,
        list.map((p) => [p.page, nums(p.count)]),
        tp.json.data.pages.map((p) => [p.page, p.visits]),
      );
      T(
        `[page] ${label} "Other pages" row only when otherVisits > 0`,
        dom.pages.some((p) => p.other) === tp.json.data.otherVisits > 0,
      );
    }
    const cr = latest(rec, 'consent-rate');
    if (cr) {
      const t = cr.json.data.totals;
      same(
        `[page] ${label} consent legend`,
        dom.consentLegend.map((s) => nums(s)),
        [t.granted, t.denied],
      );
      same(
        `[page] ${label} consent headline`,
        dom.consentKpi.startsWith(t.rate === null ? '—' : `${Math.round(t.rate * 1000) / 10}%`),
        true,
      );
    }
    const nv = latest(rec, 'new-vs-returning');
    if (nv) {
      const t = nv.json.data.totals;
      same(
        `[page] ${label} new-vs-returning legend (new, returning, unknown)`,
        dom.nvrLegend.map((s) => nums(s)),
        [t.new, t.returning, t.unknown],
      );
      const ident = t.new + t.returning;
      same(
        `[page] ${label} new-vs-returning headline`,
        dom.nvrKpi.startsWith(ident ? `${Math.round((t.new / ident) * 1000) / 10}%` : '—'),
        true,
      );
      T(
        `[page] ${label} ESTIMATE tag shown because identity includes IP`,
        dom.nvrKpi.includes('Estimate'),
      );
    }
  }

  async function tableRows(page) {
    return page.evaluate(() =>
      [...document.querySelectorAll('.p-table tbody tr')].map((tr) => ({
        iso: tr.querySelector('time')?.getAttribute('datetime') ?? null,
        clock: tr.querySelector('.t-time b')?.textContent ?? null,
        page: tr.querySelector('.c-page')?.textContent ?? null,
        pageDir: tr.querySelector('.c-page')?.getAttribute('dir') ?? null,
        consent: tr.querySelector('.chip')?.textContent ?? null,
        first: tr.querySelector('.c-first')?.textContent ?? null,
        ip: tr.querySelector('.c-ip')?.textContent ?? null,
        email: tr.querySelector('.c-email')?.textContent ?? null,
        user: tr.querySelector('.c-user')?.textContent ?? null,
        notCollected: tr.querySelector('td.na')?.textContent ?? null,
      })),
    );
  }

  // ======================= 1. the main page at the root mount =======================
  const main = await open('/');
  const baseHeaders = main.nav.headers();
  T(
    '[state] GET / answers 200 with the dashboard HTML',
    main.nav.status() === 200 && /text\/html/.test(baseHeaders['content-type'] ?? ''),
  );
  const csp = baseHeaders['content-security-policy'] ?? '';
  T(
    '[csp] the real handler CSP is default-src none with nonce script/style and no unsafe-inline',
    /default-src 'none'/.test(csp) &&
      /script-src 'nonce-[\w-]+'/.test(csp) &&
      /style-src 'nonce-[\w-]+'/.test(csp) &&
      !/unsafe-/.test(csp) &&
      /connect-src 'self'/.test(csp) &&
      /frame-ancestors 'none'/.test(csp),
    csp,
  );
  T(
    '[csp] x-frame-options DENY, nosniff, no-store',
    baseHeaders['x-frame-options'] === 'DENY' &&
      baseHeaders['x-content-type-options'] === 'nosniff' &&
      /no-store/.test(baseHeaders['cache-control'] ?? ''),
    short(baseHeaders),
  );
  const raw1 = await (await main.ctx.request.get(`${base}/`)).text();
  const raw2 = await (await main.ctx.request.get(`${base}/`)).text();
  const nonceOf = (t) => /<script nonce="([^"]+)"/.exec(t)?.[1];
  T(
    '[csp] a fresh nonce on every request, the same one on all inline blocks',
    nonceOf(raw1) &&
      nonceOf(raw1) !== nonceOf(raw2) &&
      (raw1.match(/nonce="([^"]+)"/g) ?? []).every((n) => n === `nonce="${nonceOf(raw1)}"`) &&
      !raw1.includes('%%DYNALITICS'),
  );
  T(
    '[state] root mount: <meta name=dynalitics-base> is empty (F-07)',
    /<meta name="dynalitics-base" content="">/.test(raw1),
    /<meta name="dynalitics-base"[^>]*>/.exec(raw1)?.[0],
  );
  T(
    '[state] root mount: every API call is /api/... and never //api (F-07)',
    main.requests.length >= 6 &&
      main.requests.every((u) => new URL(u).pathname.startsWith('/api/')),
    short(main.requests),
  );
  T(
    '[state] all API calls answered 200',
    main.responses.every((r) => r.status === 200),
    short(main.responses.map((r) => [apiPath(r.url), r.status])),
  );

  const meta = latest(main, 'meta').json;
  T(
    '[handler] /api/meta v2 with all widgets available, fields for the recommended table',
    meta.data.version === 2 &&
      Object.values(meta.data.widgets).every((w) => w.available) &&
      meta.data.fields.email &&
      meta.data.fields.ipAddress &&
      meta.data.fields.userId &&
      meta.data.fields.id,
    short(meta.data),
  );
  T(
    '[handler] meta.now is the server clock (within a minute of the seed)',
    Math.abs(Date.parse(meta.data.now) - Date.now()) < 120000,
  );
  same(
    '[handler] meta.breakdowns lists the declared custom field',
    meta.data.breakdowns.map((b) => b.key),
    ['consent', 'plan'],
  );
  T(
    '[handler] piiRevealable is false when the host did not enable reveal',
    meta.data.features.piiRevealable === false,
  );

  compareApi(main, 'default 7d');
  {
    const v = latest(main, 'visits-over-time', (q) => !q.get('breakdown')).json.data;
    const c = latest(main, 'consent-rate').json.data.totals;
    const n = latest(main, 'new-vs-returning').json.data.totals;
    note(
      `real numbers, default 7d: ${v.total} visits; consent ${c.granted} granted / ${c.denied} declined; new ${n.new} / returning ${n.returning} / unknown ${n.unknown}`,
    );
  }
  await compareDom(main, 'default 7d');

  // -- recent visits: rows, masking, hostile text --
  const rv = latest(main, 'recent-visits', (s) => !s.get('cursor'));
  const uiRows = await tableRows(main.page);
  same('[page] 25 table rows on the first page', uiRows.length, 25);
  same(
    '[page] table pages = API pages',
    uiRows.map((r) => r.page),
    rv.json.data.visits.map((x) => x.pageVisited),
  );
  same(
    '[page] table instants = API timestamps',
    uiRows.map((r) => r.iso),
    rv.json.data.visits.map((x) => x.timestamp),
  );
  same(
    '[page] times are shown in UTC although the browser zone is Los Angeles',
    uiRows.map((r) => r.clock),
    rv.json.data.visits.map((x) => utcTime(x.timestamp)),
  );
  same(
    '[page] consent chips',
    uiRows.map((r) => r.consent.trim().toLowerCase()),
    rv.json.data.visits.map((x) => (x.consent ? 'granted' : 'declined')),
  );
  T(
    '[page] every page cell is isolated for bidi and dir=auto',
    uiRows.every((r) => r.pageDir === 'auto'),
  );
  rv.json.data.visits.forEach((x, i) => {
    const r = uiRows[i];
    if (!x.consent) {
      T(
        `[page] declined row ${i}: one merged "not collected" cell, no personal cells`,
        !!r.notCollected && r.ip === null && r.email === null && r.user === null,
        short(r),
      );
      T(
        `[handler] declined row ${i}: every personal field is null in the JSON`,
        [x.ipAddress, x.userId, x.username, x.email].every((f) => f === null),
        short(x),
      );
      return;
    }
    if (x.ipAddress !== null)
      same(`[page] row ${i} IP shown exactly as the API sent it`, r.ip, x.ipAddress);
    if (x.email !== null)
      same(`[page] row ${i} email shown exactly as the API sent it`, r.email, x.email);
    if (x.username !== null)
      T(
        `[page] row ${i} username shown as the API sent it`,
        r.user.startsWith(x.username),
        short([r.user, x.username]),
      );
    if (x.userId !== null)
      T(
        `[page] row ${i} userId shown as the API sent it`,
        r.user.endsWith(x.userId),
        short([r.user, x.userId]),
      );
  });
  // masking (handler) and no leaks (page)
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const x of rv.json.data.visits.filter((v) => v.consent)) {
    const raw = byId.get(x.id);
    if (!T(`[handler] row ${x.id} returned by recent-visits exists in the table`, !!raw)) continue;
    if (raw.ip !== null)
      T(
        `[security] row ${x.id} IP is masked in the JSON`,
        x.ipAddress !== raw.ip && /^[\da-f.:]+\.x\.x$|x/.test(x.ipAddress ?? ''),
        short([x.ipAddress, raw.ip]),
      );
    if (raw.email !== null)
      T(
        `[security] row ${x.id} email is masked in the JSON`,
        x.email !== raw.email && /^.\*\*\*@/.test(x.email ?? ''),
        short([x.email, raw.email]),
      );
    if (raw.username !== null)
      T(
        `[security] row ${x.id} username is masked in the JSON`,
        x.username !== raw.username && /\*\*\*/.test(x.username ?? ''),
        short([x.username, raw.username]),
      );
    if (raw.userId !== null)
      T(
        `[security] row ${x.id} userId is masked in the JSON (pii.maskUserId default)`,
        x.userId !== raw.userId && /\*/.test(x.userId ?? ''),
        short([x.userId, raw.userId]),
      );
  }
  T('[security] meta.piiMasked is true on recent-visits', rv.json.meta.piiMasked === true);
  const bodyText = await main.page.evaluate(() => document.body.textContent);
  const rawSecrets = [
    ...new Set(
      rows
        .flatMap((r) => [
          r.email,
          r.userId,
          r.ip,
          r.username && r.username.length > 3 ? r.username : null,
        ])
        .filter(Boolean),
    ),
  ];
  const leaked = rawSecrets.filter((s) => bodyText.includes(s));
  T(
    '[security] no raw email, IP, user id or username appears anywhere in the rendered page',
    leaked.length === 0,
    `leaked: ${short(leaked)}`,
  );
  T(
    '[security] the hostile <img onerror> path renders as exact text and creates no element',
    await main.page.evaluate(() => {
      const cells = [...document.querySelectorAll('.p-table .c-page')].map((c) => c.textContent);
      return (
        cells.includes('/<img src=x onerror=alert(1)>') &&
        document.querySelectorAll('img, script[src], iframe, object').length === 0
      );
    }),
  );
  T(
    '[security] no alert() ran and no script was injected',
    (await main.page.evaluate(() => window.__xss)) === false,
  );
  const direct = await main.page.evaluate(() =>
    [...document.querySelectorAll('.p-table .c-page')].map((c) => c.textContent),
  );
  T(
    '[page] data written by another tool renders inertly: javascript: URL, RTL override, <script>',
    direct.includes('javascript:alert(document.domain)') &&
      direct.includes('/‮evil/gpj.exe') &&
      direct.includes('"><script>alert(1)</script>') &&
      (await main.page.evaluate(() => document.querySelectorAll('a[href]').length)) === 1,
    short(direct),
  );
  T(
    '[page] the 400-character page path is in the table in full',
    direct.some((p) => p.length === 405 && p.endsWith('/end')) ||
      (await main.page.evaluate(() =>
        [...document.querySelectorAll('.p-pages .dy-page')].some(
          (c) => c.textContent.length === 405,
        ),
      )),
  );
  const raw = await (
    await main.ctx.request.get(`${base}/api/recent-visits?pii=reveal&limit=5`)
  ).json();
  T(
    '[security] ?pii=reveal without server opt-in stays masked (not an error)',
    raw.success === true &&
      raw.meta.piiMasked === true &&
      raw.data.visits.every((x) => x.email === null || /\*\*\*/.test(x.email)),
    short(raw.meta),
  );
  T(
    '[state] no reveal button when the server did not allow it',
    (await main.page.locator('.p-table .dy-tools button').count()) === 0,
  );

  // -- load more --
  const before = await main.page.locator('.p-table tbody tr').count();
  await main.page.locator('.p-table .dy-more button').click();
  await main.page.waitForFunction(
    (n) => document.querySelectorAll('.p-table tbody tr').length > n,
    before,
  );
  const moreResp = latest(main, 'recent-visits', (s) => !!s.get('cursor'));
  const { from: rf, to: rt } = win(moreResp.params);
  const all = oracle.recentVisits(rows, rf, rt, 500);
  same(
    '[handler] cursor page 2 continues the newest-first order without gaps or repeats',
    moreResp.json.data.visits.map((x) => x.id),
    all.slice(25, 25 + moreResp.json.data.visits.length).map((r) => r.id),
  );
  same(
    '[page] load more appends exactly the API rows',
    (await tableRows(main.page)).length,
    before + moreResp.json.data.visits.length,
  );
  T(
    '[page] focus moved to the first new row',
    await main.page.evaluate(
      (n) =>
        document.activeElement?.closest('tr') === document.querySelectorAll('.p-table tbody tr')[n],
      before,
    ),
  );
  T(
    '[page] "End of range." after the last page',
    moreResp.json.data.nextCursor === null
      ? (await main.page.locator('.p-table .dy-more').textContent()).includes('End of range.')
      : true,
  );

  // -- range selector: 24h, 30d, 90d --
  async function pickRange(rec, key) {
    const n = rec.responses.length;
    await rec.page.locator(`#dy-range input[value="${key}"]`).evaluate((i) => i.click());
    await rec.page.waitForFunction(
      () => !document.querySelector('.dy-viz[aria-busy="true"]'),
      null,
    );
    await rec.page.waitForTimeout(400);
    await settled(rec.page);
    return rec.responses.slice(n);
  }
  for (const key of ['24h', '30d', '90d']) {
    const fresh = await pickRange(main, key);
    T(
      `[state] ${key}: all API calls answered 200 (including new-vs-returning)`,
      fresh.every((r) => r.status === 200),
      short(fresh.map((r) => [apiPath(r.url), r.status])),
    );
    compareApi({ ...main, responses: fresh }, key);
    await compareDom({ page: main.page, responses: fresh }, key);
    T(
      `[state] ${key}: URL hash mirrors the range`,
      (await main.page.evaluate(() => window.location.hash)) === `#range=${key}`,
    );
  }
  const nv90 = latest(main, 'new-vs-returning');
  const hero90Window = win(latest(main, 'visits-over-time', (q) => !q.get('breakdown')).params);
  const span = (Date.parse(nv90.params.get('to')) - Date.parse(nv90.params.get('from'))) / 864e5;
  same(
    '[page] 90d: new-vs-returning is clamped to 31 days at daily buckets',
    [span, nv90.params.get('interval')],
    [31, 'day'],
  );
  const hero90 = latest(main, 'visits-over-time', (s) => !s.get('breakdown'));
  same(
    '[page] 90d: the other four widgets use the whole range at weekly buckets',
    [
      (Date.parse(hero90.params.get('to')) - Date.parse(hero90.params.get('from'))) / 864e5,
      hero90.params.get('interval'),
    ],
    [90, 'week'],
  );
  same(
    '[page] 90d: eyebrows name the windows',
    await main.page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.p-hero .dy-panel-head > .dy-eyebrow, .p-nvr .dy-panel-head > .dy-eyebrow',
        ),
      ].map((e) => e.textContent),
    ),
    ['No. 1 · LAST 90 DAYS', 'No. 3 · LAST 31 DAYS'],
  );
  T(
    '[page] 90d: the cap note is shown',
    (await main.page.locator('.p-nvr').textContent()).includes(
      'Showing the last 31 days: this widget is capped at 31 days.',
    ),
  );
  // the clamp matters: people first seen 40 days ago are "returning" in the 31-day window, not "new"
  const o31 = oracle.newVsReturning(
    rows,
    Date.parse(nv90.params.get('from')),
    Date.parse(nv90.params.get('to')),
    'day',
  );
  same(
    '[handler] 90d clamped window: totals match the oracle (history before the window makes people returning)',
    nv90.json.data.totals,
    o31.totals,
  );
  {
    // control: the clamp is only meaningful if an unclamped 90-day answer would differ on this data
    const o90 = oracle.newVsReturning(rows, hero90Window.from, hero90Window.to, 'day');
    T(
      'control: the unclamped 90-day answer differs from the clamped 31-day one on this data',
      JSON.stringify(o90.totals) !== JSON.stringify(o31.totals),
      short([o90.totals, o31.totals]),
    );
    note(
      `90d clamp: new/returning/unknown over 31 days = ${o31.totals.new}/${o31.totals.returning}/${o31.totals.unknown}; the same query over 90 days would give ${o90.totals.new}/${o90.totals.returning}/${o90.totals.unknown}`,
    );
  }

  // -- split by --
  await pickRange(main, '7d');
  const splitN = main.responses.length;
  await main.page.selectOption('.p-hero select', 'plan');
  await settled(main.page);
  const split = latest(
    { responses: main.responses.slice(splitN) },
    'visits-over-time',
    (s) => s.get('breakdown') === 'plan',
  );
  if (T('[state] split by plan requests breakdown=plan and gets 200', !!split)) {
    const { from, to } = win(split.params);
    const o = oracle.planCounts(rows, from, to);
    const got = new Map(
      split.json.data.breakdown.series
        .filter((s) => !s.isOther)
        .map((s) => [s.value, s.points.reduce((a, p) => a + p.visits, 0)]),
    );
    same(
      '[handler] per-plan totals (incl. "no value") match the database',
      [...got].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [...o].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const legend = await main.page.evaluate(() =>
      [...document.querySelectorAll('.p-hero .dy-legend li')].map((li) => li.textContent.trim()),
    );
    same(
      '[page] split legend totals = API series totals (stack order reversed)',
      legend.map(nums),
      [...split.json.data.breakdown.series]
        .reverse()
        .map((s) => s.points.reduce((a, p) => a + p.visits, 0)),
    );
    T(
      '[page] "No value" legend entry is explained without mentioning consent',
      await main.page.evaluate(() => {
        const li = [...document.querySelectorAll('.p-hero .dy-legend li')].find((x) =>
          x.textContent.includes('No value'),
        );
        return (
          !li ||
          (li.title === 'Rows without a value for this field.' && !/denied/i.test(li.textContent))
        );
      }),
    );
  }
  await main.page.selectOption('.p-hero select', 'consent');
  await settled(main.page);
  T(
    '[state] split by consent works against the real handler',
    !!latest(main, 'visits-over-time', (s) => s.get('breakdown') === 'consent'),
  );
  await main.page.selectOption('.p-hero select', '');
  await settled(main.page);

  // -- keyboard and theme --
  const kb = await open('/');
  await kb.page.keyboard.press('Tab');
  T(
    '[page] first Tab stop on a fresh page is the skip link',
    await kb.page.evaluate(() => document.activeElement?.classList.contains('dy-skip')),
  );
  await kb.ctx.close();
  await main.page.focus('.p-hero .dy-chart');
  await main.page.keyboard.press('ArrowLeft');
  T(
    '[page] arrow keys explore the chart and the live region announces',
    /Oct|Nov/.test(await main.page.locator('.p-hero [role="status"]').textContent()),
  );
  await main.page.click('#dy-theme');
  T(
    '[page] theme toggle sets data-theme and persists across reload',
    await (async () => {
      const a = await main.page.evaluate(() => document.documentElement.dataset.theme);
      await main.page.reload();
      await settled(main.page);
      const b = await main.page.evaluate(() => document.documentElement.dataset.theme);
      return a !== 'light' && a === b;
    })(),
  );
  T(
    '[csp] no CSP violation event and no console problem on the main page',
    (await main.page.evaluate(() => window.__csp)).length === 0 && main.problems.length === 0,
    short([await main.page.evaluate(() => window.__csp), main.problems]),
  );
  await main.ctx.close();

  // ======================= 2. other mounts and failure modes =======================
  for (const [mount, expectedBase] of [
    ['/admin', '/admin'],
    ['/express', '/express'],
  ]) {
    const rec = await open(mount);
    const html = await (await rec.ctx.request.get(`${base}${mount}/`)).text();
    T(
      `[state] ${mount}: meta base is ${expectedBase}`,
      html.includes(`<meta name="dynalitics-base" content="${expectedBase}">`),
    );
    T(
      `[state] ${mount}: all API calls under ${expectedBase}/api/ and 200`,
      rec.responses.length >= 6 &&
        rec.responses.every(
          (r) => new URL(r.url).pathname.startsWith(`${expectedBase}/api/`) && r.status === 200,
        ),
      short(rec.responses.map((r) => [new URL(r.url).pathname, r.status])),
    );
    compareApi(rec, mount);
    await compareDom(rec, mount);
    T(
      `[csp] ${mount}: no violations or console problems`,
      (await rec.page.evaluate(() => window.__csp)).length === 0 && rec.problems.length === 0,
      short(rec.problems),
    );
    await rec.ctx.close();
  }

  const reveal = await open('/reveal');
  T(
    '[state] reveal mount offers the reveal button (piiRevealable)',
    (await reveal.page.locator('.p-table .dy-tools button').count()) === 1,
  );
  const maskedFirst = latest(reveal, 'recent-visits').json;
  T(
    '[security] reveal mount starts masked',
    maskedFirst.meta.piiMasked === true &&
      maskedFirst.data.visits.some((x) => x.email && /\*\*\*/.test(x.email)),
  );
  await reveal.page.locator('.p-table .dy-tools button').click();
  await settled(reveal.page);
  const revealed = latest(reveal, 'recent-visits', (s) => s.get('pii') === 'reveal');
  if (T('[state] reveal sends ?pii=reveal and gets 200', !!revealed)) {
    T('[security] revealed response says piiMasked:false', revealed.json.meta.piiMasked === false);
    for (const x of revealed.json.data.visits.filter((v) => v.consent)) {
      const r = byId.get(x.id);
      if (!T(`[handler] revealed row ${x.id} exists in the table`, !!r)) continue;
      same(
        `[handler] revealed row ${x.id} equals the database`,
        [x.email, x.ipAddress, x.userId, x.username],
        [r.email, r.ip, r.userId, r.username],
      );
    }
    const shown = await tableRows(reveal.page);
    T(
      '[page] revealed values are shown and the sheet is marked',
      shown.some((r) => r.email === 'alice@example.com') &&
        (await reveal.page.locator('.p-table .dy-revealed').count()) === 1,
    );
    await reveal.page.locator('.p-table .dy-tools button').click();
    await settled(reveal.page);
    T(
      '[page] hiding returns to masked values',
      !(await reveal.page.evaluate(() => document.body.textContent)).includes('alice@example.com'),
    );
  }
  await reveal.ctx.close();

  for (const [mount, status, code] of [
    ['/locked', 403, 'forbidden'],
    ['/boom', 500, 'internal'],
  ]) {
    const res = await (await browser.newContext()).request.get(`${base}${mount}/`);
    const body = await res.text();
    same(
      `[state] ${mount}: the page request itself is refused with ${status} JSON, no dashboard HTML`,
      [res.status(), JSON.parse(body).error?.code, /<html/i.test(body)],
      [status, code, false],
    );
    T(
      `[security] ${mount}: refusal leaks nothing (no CSP-less HTML, no thrown message)`,
      !/blew up|dyn_it_|SELECT/i.test(body) &&
        /application\/json/.test(res.headers()['content-type'] ?? ''),
      body.slice(0, 200),
    );
  }
  const denied = await open('/denied', { expectErrors: true });
  same(
    '[state] authorize=false: exactly one API call (meta), nothing else requested',
    denied.requests.length,
    1,
  );
  same(
    '[state] authorize=false: HTTP 403 forbidden JSON',
    [denied.responses[0]?.status, JSON.parse(denied.responses[0]?.body ?? '{}').error?.code],
    [403, 'forbidden'],
  );
  same(
    '[page] authorize=false: page-level NOT AUTHORISED, only Reload page, role=alert',
    await denied.page.evaluate(() => ({
      stamp: document.querySelector('.dy-stamp')?.textContent,
      buttons: [...document.querySelectorAll('.dy-err button')].map((b) => b.textContent),
      role: document.querySelector('.dy-err')?.getAttribute('role'),
      panels: document.querySelectorAll('.dy-panel').length,
    })),
    { stamp: 'NOT AUTHORISED', buttons: ['Reload page'], role: 'alert', panels: 0 },
  );
  T(
    '[security] 403 body carries no route, SQL or table information',
    !/dynalitics_events|dyn_it_|SELECT/i.test(denied.responses[0]?.body ?? ''),
  );
  await denied.ctx.close();

  const throws = await open('/throws', { expectErrors: true });
  same(
    '[state] authorize throws: fails closed with HTTP 500',
    [throws.responses[0]?.status, JSON.parse(throws.responses[0]?.body ?? '{}').error?.code],
    [500, 'internal'],
  );
  T(
    '[security] the thrown message never reaches the browser',
    !/blew up/.test(throws.responses[0]?.body ?? '') &&
      !(await throws.page.evaluate(() => document.body.textContent)).includes('blew up'),
  );
  same(
    '[page] authorize throws: ERROR stamp with Retry',
    await throws.page.evaluate(() => [
      document.querySelector('.dy-stamp')?.textContent,
      [...document.querySelectorAll('.dy-err button')].map((b) => b.textContent),
    ]),
    ['ERROR', ['Retry']],
  );
  await throws.ctx.close();

  const partial = await open('/partial', { expectErrors: true });
  const pst = await partial.page.evaluate(() => ({
    stamps: [...document.querySelectorAll('.dy-panel .dy-stamp')].map((s) => s.textContent),
    alerts: document.querySelectorAll('[role="alert"]').length,
    statuses: document.querySelectorAll('.dy-err[role="status"]').length,
    retry: [...document.querySelectorAll('.dy-err button')].map((b) => b.textContent),
  }));
  same(
    '[page] meta allowed but data denied: five panel-level NOT AUTHORISED, one alert, four status, no Retry',
    pst,
    {
      stamps: Array(5).fill('NOT AUTHORISED'),
      alerts: 1,
      statuses: 4,
      retry: Array(5).fill('Reload page'),
    },
  );
  await partial.ctx.close();

  const wall = await open('/wall', { expectErrors: true });
  same(
    '[page] host 401 text before the handler: NOT AUTHORISED',
    await wall.page.evaluate(() => document.querySelector('.dy-stamp')?.textContent),
    'NOT AUTHORISED',
  );
  await wall.ctx.close();

  const sso = await open('/sso', { expectErrors: true });
  same(
    '[page] redirect to a login page: UNEXPECTED REPLY (redirect: manual), not a network error',
    await sso.page.evaluate(() => document.querySelector('.dy-stamp')?.textContent),
    'UNEXPECTED REPLY',
  );
  same(
    '[page] the fetch did not follow the redirect: the sign-in page got zero hits on the server',
    h.stats.loginHits,
    0,
  );
  await sso.ctx.close();

  const empty = await open('/empty');
  const titles = await empty.page.evaluate(() =>
    [...document.querySelectorAll('.dy-state h3')].map((h3) => h3.textContent),
  );
  same('[page] empty table: each widget shows its own empty copy', titles, [
    'The ledger is empty for this range.',
    'No pages yet.',
    'Nobody classified yet.',
    'No consent decisions yet.',
    'No visits in this range.',
  ]);
  T(
    '[handler] empty table: zero-filled series, rate null, no errors',
    (() => {
      const v = latest(empty, 'visits-over-time').json.data;
      const c = latest(empty, 'consent-rate').json.data;
      return (
        v.total === 0 &&
        v.points.length > 0 &&
        v.points.every((p) => p.visits === 0) &&
        c.totals.rate === null
      );
    })(),
  );
  await empty.page.locator('.p-hero .dy-state button', { hasText: 'Try 90 days' }).click();
  await settled(empty.page);
  T(
    '[page] empty: Try 90 days switches the range and reaches the 90-day copy',
    (await empty.page.locator('.p-hero .dy-state h3').textContent()) === 'Nothing recorded yet.',
  );
  T('[csp] empty mount: no console problems', empty.problems.length === 0, short(empty.problems));
  await empty.ctx.close();

  // ======================= 3. layout matrix: every mount, 4 widths, 2 themes =======================
  const errorMounts = new Set(['/denied', '/throws', '/partial', '/wall', '/sso']);
  for (const mount of ['/', '/admin', '/express', '/reveal', '/empty', ...errorMounts]) {
    for (const scheme of SCHEMES) {
      for (const width of WIDTHS) {
        const rec = await open(mount, { width, scheme, expectErrors: errorMounts.has(mount) });
        const tag = `${mount === '/' ? 'root' : mount.slice(1)}-${scheme}-${width}`;
        const overflow = await rec.page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        T(`[layout] ${tag}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
        T(
          `[csp] ${tag}: no CSP violations or console problems`,
          (await rec.page.evaluate(() => window.__csp)).length === 0 && rec.problems.length === 0,
          short([await rec.page.evaluate(() => window.__csp), rec.problems]),
        );
        const file = join(out, `${tag}.png`);
        await rec.page.screenshot({ path: file, fullPage: true });
        report.shots.push(file);
        await rec.ctx.close();
      }
    }
  }
}

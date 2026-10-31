import { describe, expect, test } from 'vitest';
import { buildRow, type RowConfig } from '../../src/track/build-row.js';
import { deniedView } from '../../src/track/denied-view.js';
import { getDialect } from '../../src/dialect/index.js';
import { buildColumnModel } from '../../src/model/column-model.js';
import type { SchemaConfig } from '../../src/model/types.js';
import type { Visit } from '../../src/types.js';

const NOW = new Date('2026-10-30T12:01:44.120Z');
const TS = '2026-10-30T12:01:44.120Z';

const baseSchema: SchemaConfig = {
  table: 'public.events',
  customFields: {
    plan: { type: 'string', maxLength: 32, personal: false },
    campaign: { type: 'string', maxLength: 64 },
  },
};
const baseCfg: RowConfig = {
  page: { keepQuery: false, maxLength: 512 },
  ip: { mode: 'truncate', salt: undefined, ipv4Prefix: 24, ipv6Prefix: 48 },
  limits: { customMaxKeys: 20, customMaxBytes: 4096, oversize: 'truncate' },
  consentDefault: undefined,
};

function run(visit: unknown, schema: SchemaConfig = baseSchema, cfg: Partial<RowConfig> = {}) {
  const model = buildColumnModel(schema);
  return buildRow({
    model,
    dialect: getDialect('postgres'),
    cfg: { ...baseCfg, ...cfg },
    visit: visit as Visit,
    now: NOW,
  });
}
const full: Visit = {
  pageVisited: '/pricing?utm=x',
  ip: '203.0.113.77',
  userId: 'u_42',
  username: 'jane',
  email: 'jane@example.com',
  custom: { plan: 'pro', campaign: 'fall' },
};

describe('consent matrix (spec 8.2)', () => {
  test('1. consent true: everything is stored (IP truncated, query string stripped)', () => {
    const r = run({ ...full, consent: true });
    expect(r).toMatchObject({ ok: true, consent: true });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values).toEqual([
      TS,
      true,
      '/pricing',
      '203.0.113.0',
      'u_42',
      'jane',
      'jane@example.com',
      '{"plan":"pro","campaign":"fall"}',
    ]);
  });

  test('2. consent false: ONLY page, timestamp and consent=false (non-personal custom fields are NOT kept by default)', () => {
    const r = run({ ...full, consent: false });
    if (!r.ok) throw new Error('unreachable');
    expect(r.consent).toBe(false);
    expect(r.values).toEqual([TS, false, '/pricing', null, null, null, null, null]);
    expect(r.identity).toBeNull();
  });

  test('3. no per-call consent, resolver says true -> as row 1', () => {
    const r = run(full, baseSchema, { consentDefault: () => true });
    if (!r.ok) throw new Error('unreachable');
    expect(r.consent).toBe(true);
    expect(r.values[4]).toBe('u_42');
  });

  test('4. no consent info at all -> denied, with a consent_missing note (fail closed)', () => {
    const r = run(full);
    if (!r.ok) throw new Error('unreachable');
    expect(r.consent).toBe(false);
    expect(r.values.slice(3, 7)).toEqual([null, null, null, null]);
    expect(r.notes.map((n) => n.code)).toEqual(['consent_missing']);
  });

  test('null consent is treated like missing consent', () => {
    const r = run({ ...full, consent: null });
    if (!r.ok) throw new Error('unreachable');
    expect(r.consent).toBe(false);
  });

  test('5. resolver throws or returns a non-boolean -> denied with consent_resolver_failed', () => {
    for (const resolver of [
      () => {
        throw new Error('boom');
      },
      () => 'yes' as unknown as boolean,
    ]) {
      const r = run(full, baseSchema, { consentDefault: resolver });
      if (!r.ok) throw new Error('unreachable');
      expect(r.consent).toBe(false);
      expect(r.notes.map((n) => n.code)).toEqual(['consent_resolver_failed']);
    }
  });

  test('a per-call boolean beats the resolver', () => {
    const r = run({ ...full, consent: false }, baseSchema, { consentDefault: () => true });
    if (!r.ok) throw new Error('unreachable');
    expect(r.consent).toBe(false);
  });

  test.each(['yes', 'false', 1, 0, {}, []])(
    '6. non-boolean consent %j is NEVER coerced: the visit is stored as "no consent" and reported',
    (bad) => {
      const r = run({ ...full, consent: bad });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.consent).toBe(false);
      expect(r.values).toEqual([TS, false, '/pricing', null, null, null, null, null]);
      expect(r.notes.map((n) => n.code)).toEqual(['invalid_visit']);
      expect(r.notes[0]?.message).toMatch(/consent must be a boolean/);
    },
  );

  test('7. consent true without ip/userId is stored (no identity)', () => {
    const r = run({ pageVisited: '/a', consent: true });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values).toEqual([TS, true, '/a', null, null, null, null, null]);
    expect(r.identity).toBeNull();
  });

  test('8. invalid ip -> stored as NULL with an invalid_ip note, visit kept', () => {
    const r = run({ ...full, consent: true, ip: 'not-an-ip' });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[3]).toBeNull();
    expect(r.values[4]).toBe('u_42');
    expect(r.notes.map((n) => n.code)).toEqual(['invalid_ip']);
  });

  test('9. denied with custom fields -> custom is NULL', () => {
    const r = run({ pageVisited: '/a', consent: false, custom: { campaign: 'x' } });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values).toEqual([TS, false, '/a', null, null, null, null, null]);
  });

  test('10. missing or empty pageVisited is rejected', () => {
    for (const bad of [undefined, '', '   ', 5, '?only=query']) {
      expect(run({ consent: true, pageVisited: bad }).ok).toBe(false);
    }
  });

  test('11. an unmapped role is ignored entirely (no column, no validation, no error)', () => {
    const r = run(
      { ...full, consent: true, email: { not: 'a string' } },
      { ...baseSchema, columns: { email: false } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.values).toHaveLength(7);
  });

  test('personal inputs are not even inspected when consent is denied (wrong types do not matter)', () => {
    const r = run({
      pageVisited: '/a',
      consent: false,
      ip: 42,
      userId: {},
      username: [],
      email: true,
    });
    expect(r.ok).toBe(true);
  });

  test('personal text inputs of the wrong type ARE rejected when consent is granted', () => {
    expect(run({ pageVisited: '/a', consent: true, email: 42 }).ok).toBe(false);
    expect(run({ pageVisited: '/a', consent: true, username: {} }).ok).toBe(false);
  });
});

describe('invariant: with consent false no personal value ever reaches the row', () => {
  test('across many generated inputs', () => {
    const model = buildColumnModel(baseSchema);
    const personal = model.insertColumns
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.personal && c.role !== 'custom');
    const inputs = [
      '',
      'a',
      'x'.repeat(1000),
      "'; DROP TABLE t;--",
      '<script>',
      '\u0000',
      '203.0.113.5',
      '😀',
    ];
    for (const a of inputs) {
      for (const b of inputs) {
        const r = run({
          pageVisited: '/p',
          consent: false,
          ip: a,
          userId: b,
          username: a,
          email: b,
          custom: { campaign: a, plan: b },
        });
        if (!r.ok) continue;
        for (const [, i] of personal) expect(r.values[i]).toBeNull();
        expect(r.values[7]).toBeNull(); // nothing is kept unless a field opts in with keepWhenDenied
      }
    }
  });
});

describe('page handling', () => {
  test('query string and fragment are stripped by default, kept on request', () => {
    const r1 = run({ pageVisited: '/a/b?token=secret#frag', consent: false });
    const r2 = run({ pageVisited: '/a/b?token=secret#frag', consent: false }, baseSchema, {
      page: { keepQuery: true, maxLength: 512 },
    });
    if (!r1.ok || !r2.ok) throw new Error('unreachable');
    expect(r1.values[2]).toBe('/a/b');
    expect(r2.values[2]).toBe('/a/b?token=secret#frag');
  });

  test('control characters are removed and lone surrogates replaced', () => {
    const r = run({ pageVisited: '/a\u0000b\nc\u007f\uD800d', consent: false });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[2]).toBe('/abc�d');
  });

  test('oversize strings are truncated by default (never splitting a surrogate pair), or rejected on request', () => {
    const long = '/' + 'a'.repeat(600);
    const t = run({ pageVisited: long, consent: false });
    if (!t.ok) throw new Error('unreachable');
    expect((t.values[2] as string).length).toBe(512);
    const emoji = run({ pageVisited: '/' + '😀'.repeat(300), consent: false }, baseSchema, {
      page: { keepQuery: false, maxLength: 11 },
    });
    if (!emoji.ok) throw new Error('unreachable');
    expect(emoji.values[2]).toBe('/' + '😀'.repeat(5));
    const rej = run({ pageVisited: long, consent: false }, baseSchema, {
      limits: { ...baseCfg.limits, oversize: 'reject' },
    });
    expect(rej.ok).toBe(false);
  });
});

describe('field limits', () => {
  test('userId (128), username (128), email (320) are truncated; numbers become strings', () => {
    const r = run({
      pageVisited: '/a',
      consent: true,
      userId: 12345,
      username: 'u'.repeat(200),
      email: 'e'.repeat(400),
    });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[4]).toBe('12345');
    expect((r.values[5] as string).length).toBe(128);
    expect((r.values[6] as string).length).toBe(320);
  });

  test('empty strings are stored as NULL', () => {
    const r = run({ pageVisited: '/a', consent: true, username: '', email: '' });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values.slice(5, 7)).toEqual([null, null]);
  });

  test('an over-long ip input is treated as invalid, not stored', () => {
    const r = run({ pageVisited: '/a', consent: true, ip: '1'.repeat(65) });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[3]).toBeNull();
  });
});

describe('custom fields', () => {
  test('unknown keys are dropped with a note; declared ones are kept', () => {
    const r = run({
      pageVisited: '/a',
      consent: true,
      custom: { plan: 'pro', evil: 'x', __proto__x: 1 },
    });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[7]).toBe('{"plan":"pro"}');
    expect(r.notes.filter((n) => n.code === 'unknown_custom_field')).toHaveLength(2);
  });

  test('type checks per declared type reject the event', () => {
    const schema: SchemaConfig = {
      table: 't',
      customFields: {
        s: { type: 'string', personal: false },
        i: { type: 'integer', personal: false },
        n: { type: 'number', personal: false },
        b: { type: 'boolean', personal: false },
      },
    };
    expect(
      run({ pageVisited: '/a', consent: true, custom: { s: 'x', i: 1, n: 1.5, b: true } }, schema)
        .ok,
    ).toBe(true);
    for (const bad of [
      { s: 1 },
      { i: 1.5 },
      { i: '1' },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { b: 'true' },
      { s: {} },
      { s: [] },
    ]) {
      expect(run({ pageVisited: '/a', consent: true, custom: bad }, schema).ok).toBe(false);
    }
  });

  test('null and undefined values are omitted from the JSON', () => {
    const r = run({
      pageVisited: '/a',
      consent: true,
      custom: { plan: null, campaign: undefined },
    });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[7]).toBeNull();
  });

  test('limits: too many keys or too many bytes reject the event; long strings are truncated', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'x']));
    expect(run({ pageVisited: '/a', consent: true, custom: many }).ok).toBe(false);
    const big = { plan: 'p'.repeat(32), campaign: 'c'.repeat(64) };
    expect(
      run({ pageVisited: '/a', consent: true, custom: big }, baseSchema, {
        limits: { ...baseCfg.limits, customMaxBytes: 20 },
      }).ok,
    ).toBe(false);
    const long = run({ pageVisited: '/a', consent: true, custom: { plan: 'p'.repeat(100) } });
    if (!long.ok) throw new Error('unreachable');
    expect(JSON.parse(long.values[7] as string)).toEqual({ plan: 'p'.repeat(32) });
  });

  test('custom must be a plain object', () => {
    for (const bad of ['x', 5, [1], true])
      expect(run({ pageVisited: '/a', consent: true, custom: bad }).ok).toBe(false);
  });

  test('prototype-pollution keys never reach the output or Object.prototype', () => {
    const custom = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "plan": "pro"}',
    ) as Record<string, unknown>;
    const r = run({ pageVisited: '/a', consent: true, custom });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[7]).toBe('{"plan":"pro"}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('promoted fields go to their own column, not the JSON', () => {
    const schema: SchemaConfig = {
      table: 't',
      customFields: {
        locale: { type: 'string', maxLength: 5, personal: false, column: true },
        plan: { type: 'string', personal: false },
      },
    };
    const r = run(
      { pageVisited: '/a', consent: true, custom: { locale: 'de-DE-1996', plan: 'pro' } },
      schema,
    );
    if (!r.ok) throw new Error('unreachable');
    const model = buildColumnModel(schema);
    const idx = model.insertColumns.findIndex((c) => c.name === 'locale');
    expect(r.values[idx]).toBe('de-DE');
    expect(r.values[model.insertColumns.findIndex((c) => c.role === 'custom')]).toBe(
      '{"plan":"pro"}',
    );
  });
});

describe('identity for write-time first visit', () => {
  const fv: SchemaConfig = { ...baseSchema, firstVisit: { enabled: true } };
  test('userId wins, else the stored (truncated) ip, else none; the flag column starts NULL', () => {
    const u = run({ pageVisited: '/a', consent: true, userId: 'u1', ip: '203.0.113.9' }, fv);
    const i = run({ pageVisited: '/a', consent: true, ip: '203.0.113.9' }, fv);
    const n = run({ pageVisited: '/a', consent: true }, fv);
    if (!u.ok || !i.ok || !n.ok) throw new Error('unreachable');
    expect(u.identity).toEqual({ kind: 'u', value: 'u1' });
    expect(i.identity).toEqual({ kind: 'i', value: '203.0.113.0' });
    expect(n.identity).toBeNull();
    const model = buildColumnModel(fv);
    expect(u.values[model.insertColumns.findIndex((c) => c.role === 'isFirstVisit')]).toBeNull();
  });
});

describe('purity', () => {
  test('does not mutate the visit', () => {
    const visit = Object.freeze({ ...full, consent: true, custom: Object.freeze({ plan: 'pro' }) });
    expect(() => run(visit)).not.toThrow();
  });
  test('non-object visits are rejected', () => {
    for (const bad of [null, undefined, 'x', 5, []]) expect(run(bad).ok).toBe(false);
  });
});

describe('keepWhenDenied (F-03 strict)', () => {
  const schema: SchemaConfig = {
    table: 'public.events',
    customFields: {
      plan: { type: 'string', maxLength: 32, personal: false, keepWhenDenied: true },
      tier: { type: 'string', maxLength: 32, personal: false },
      campaign: { type: 'string', maxLength: 64 },
    },
  };
  test('only fields that explicitly opt in survive a denied visit', () => {
    const r = run(
      { pageVisited: '/a', consent: false, custom: { plan: 'pro', tier: 'gold', campaign: 'x' } },
      schema,
    );
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[7]).toBe('{"plan":"pro"}');
  });
  test('with consent everything declared is stored', () => {
    const r = run(
      { pageVisited: '/a', consent: true, custom: { plan: 'pro', tier: 'gold', campaign: 'x' } },
      schema,
    );
    if (!r.ok) throw new Error('unreachable');
    expect(JSON.parse(r.values[7] as string)).toEqual({ plan: 'pro', tier: 'gold', campaign: 'x' });
  });
  test('promoted fields follow the same rule', () => {
    const s: SchemaConfig = {
      table: 't',
      customFields: {
        locale: { type: 'string', personal: false, column: true, keepWhenDenied: true },
        region: { type: 'string', personal: false, column: true },
      },
    };
    const model = buildColumnModel(s);
    const r = run({ pageVisited: '/a', consent: false, custom: { locale: 'de', region: 'eu' } }, s);
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[model.insertColumns.findIndex((c) => c.name === 'locale')]).toBe('de');
    expect(r.values[model.insertColumns.findIndex((c) => c.name === 'region')]).toBeNull();
  });
});

describe('deniedView: what a compute function may see when consent is denied', () => {
  const model = buildColumnModel({
    table: 't',
    customFields: {
      plan: { type: 'string', personal: false, keepWhenDenied: true },
      tier: { type: 'string', personal: false },
      campaign: { type: 'string' },
    },
  });
  test('only pageVisited, consent:false and keepWhenDenied custom fields', () => {
    const v = deniedView(model, '/a', { plan: 'pro', tier: 'gold', campaign: 'x', ip: '1.2.3.4' });
    expect(v).toEqual({ pageVisited: '/a', consent: false, custom: { plan: 'pro' } });
  });
  test('property: no ip/userId/username/email key is ever visible, whatever the input looks like', () => {
    const evil = [
      '',
      'x',
      '203.0.113.5',
      'jane@example.com',
      '__proto__',
      'constructor',
      { toString: () => 'x' },
      [1],
      null,
      undefined,
      5,
    ];
    for (const a of evil) {
      for (const b of evil) {
        const custom = JSON.parse(
          '{"__proto__": {"ip": "1.2.3.4"}, "ip": "1.2.3.4", "userId": "u", "email": "e@x", "username": "n"}',
        ) as Record<string, unknown>;
        Object.assign(custom, { plan: a, tier: b, campaign: a });
        const v = deniedView(model, '/p', custom);
        expect(Object.keys(v).sort()).toEqual(['consent', 'custom', 'pageVisited']);
        expect(Object.keys(v.custom).every((k) => k === 'plan')).toBe(true);
        for (const banned of ['ip', 'userId', 'username', 'email']) {
          expect(JSON.stringify(v)).not.toContain(`"${banned}"`);
        }
        expect(Object.getPrototypeOf(v.custom)).toBeNull();
      }
    }
  });
  test('non-object custom data yields an empty custom view', () => {
    for (const bad of [null, undefined, 'x', 5, [1]])
      expect(Object.keys(deniedView(model, '/a', bad).custom)).toEqual([]);
  });
});

describe('page hygiene (F-14)', () => {
  const page = (visit: unknown, cfg: Partial<RowConfig> = {}) => {
    const r = run(visit, baseSchema, cfg);
    return r.ok ? (r.values[2] as string) : r.issues[0];
  };
  test('an absolute URL is reduced to its path: scheme, userinfo and host never reach the table', () => {
    expect(
      page({ pageVisited: 'https://user:pw@example.com:8443/orders/42?x=1#f', consent: false }),
    ).toBe('/orders/42');
    expect(
      JSON.stringify(run({ pageVisited: 'https://user:secretpw@example.com/x', consent: false })),
    ).not.toContain('secretpw');
  });
  test('matrix parameters such as ;jsessionid are stripped', () => {
    expect(page({ pageVisited: '/a;jsessionid=ABC123/b;x=1?y=2', consent: false })).toBe('/a/b');
  });
  test('a path must start with "/"', () => {
    for (const bad of [
      'orders/42',
      'jane@example.com',
      'javascript:alert(1)',
      '#frag',
      'mailto:x@y',
    ]) {
      expect(page({ pageVisited: bad, consent: false })).toMatch(
        /pageVisited must be a path starting with "\/"/,
      );
    }
  });
  test('page.normalize maps paths to route templates (host hook); a canary path can be templated away', () => {
    const normalize = (p: string): string =>
      p.replace(/^\/users\/[^/]+/, '/users/:id').replace(/^\/reset\/.+/, '/reset/:token');
    expect(
      page(
        { pageVisited: '/users/jane@example.com/orders', consent: false },
        { page: { keepQuery: false, maxLength: 512, normalize } },
      ),
    ).toBe('/users/:id/orders');
    expect(
      page(
        { pageVisited: '/reset/abc123', consent: false },
        { page: { keepQuery: false, maxLength: 512, normalize } },
      ),
    ).toBe('/reset/:token');
  });
  test('a throwing normalize falls back to the cleaned path and is reported', () => {
    const bad = run({ pageVisited: '/a/b', consent: false }, baseSchema, {
      page: {
        keepQuery: false,
        maxLength: 512,
        normalize: () => {
          throw new Error('boom');
        },
      },
    });
    if (!bad.ok) throw new Error('unreachable');
    expect(bad.values[2]).toBe('/a/b');
    expect(bad.notes.map((n) => n.code)).toContain('invalid_visit');
  });
});

describe('userId edge cases (F-32)', () => {
  const id = (userId: unknown) => {
    const r = run({ pageVisited: '/a', consent: true, userId });
    if (!r.ok) throw new Error('rejected');
    return { value: r.values[4], notes: r.notes.map((n) => n.code) };
  };
  test.each([
    [0, '0'],
    [-0, '0'],
    [42, '42'],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ['u_1', 'u_1'],
  ])('%j -> %j', (input, expected) => {
    expect(id(input)).toEqual({ value: expected, notes: [] });
  });
  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['1.5', 1.5],
    ['2**53', 2 ** 53],
    ['BigInt', BigInt(5)],
    ['object', {}],
    ['array', []],
    ['boolean', true],
  ])('%s is not a user id: stored as NULL, visit kept, reported', (_label, bad) => {
    expect(id(bad)).toEqual({ value: null, notes: ['invalid_user_id'] });
  });
});

describe('control characters (F-33)', () => {
  test.each([
    ['C1 controls', '/a\u0085b\u009fc', '/abc'],
    ['line/paragraph separators', '/a\u2028b\u2029c', '/abc'],
    ['bidi overrides and isolates', '/admin\u202Enigol\u2066x\u2069', '/adminnigolx'],
    ['bidi marks', '/a\u200Eb\u200Fc', '/abc'],
  ])('%s are removed', (_n, input, expected) => {
    const r = run({ pageVisited: input, consent: false });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values[2]).toBe(expected);
  });
});

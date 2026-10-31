// Spec 18.1 and 18.2: the explorer allow-list and query language. Pure, no SQL.
import { describe, expect, test } from 'vitest';
import { buildColumnModel } from '../../src/model/column-model.js';
import { buildSearchFields, facetFields, fieldInfo } from '../../src/read/search/fields.js';
import { parseQuery, QUERY_LIMITS, type Clause } from '../../src/read/search/parse.js';

const model = buildColumnModel({
  table: 'public.events',
  customFields: {
    plan: { type: 'string', maxLength: 32, personal: false, breakdown: true },
    referrer: { type: 'string', maxLength: 200, personal: false },
    amount: { type: 'number', personal: false },
    beta: { type: 'boolean', personal: false, breakdown: true },
    campaign: { type: 'string', maxLength: 64 }, // personal by default
    secret: { type: 'string', maxLength: 64, personal: true },
  },
});
const fields = buildSearchFields(model);

/** A compact, comparable view of the clauses. */
const shape = (c: Clause): string => {
  const neg = c.negate ? '-' : '';
  switch (c.type) {
    case 'term':
      return `${neg}term(${c.value})`;
    case 'text':
      return `${neg}${c.field.key}.${c.match.kind}${'value' in c.match ? `(${c.match.value})` : ''}`;
    case 'boolean':
      return `${neg}${c.field.key}=${String(c.value)}`;
    case 'number':
      return `${neg}${c.field.key}${c.op}${c.value}`;
  }
};
const parse = (q: string): string[] | string => {
  const r = parseQuery(q, fields);
  return r.ok ? r.clauses.map(shape) : `${r.reason}@${r.position}`;
};

describe('allow-list (18.1)', () => {
  test('personal columns and personal custom fields are never searchable', () => {
    const keys = [...fields.keys()];
    expect(keys).toEqual(['page', 'consent', 'plan', 'referrer', 'amount', 'beta']);
    for (const banned of [
      'ip',
      'userId',
      'username',
      'email',
      'id',
      'custom',
      'campaign',
      'secret',
    ])
      expect(fields.has(banned)).toBe(false);
  });

  test('types, bare-term search and facets follow the field definition', () => {
    expect(fieldInfo(fields)).toEqual([
      { key: 'page', type: 'text', search: true, facet: true },
      { key: 'consent', type: 'boolean', search: false, facet: true },
      { key: 'plan', type: 'text', search: true, facet: true },
      { key: 'referrer', type: 'text', search: true, facet: false },
      { key: 'amount', type: 'number', search: false, facet: false },
      { key: 'beta', type: 'boolean', search: false, facet: true },
    ]);
  });

  test('isFirstVisit is a field only with the write-time column', () => {
    expect(fields.has('isFirstVisit')).toBe(false);
    const fv = buildSearchFields(
      buildColumnModel({ table: 'public.events', firstVisit: { enabled: true } }),
    );
    expect(fv.get('isFirstVisit')).toMatchObject({ type: 'boolean', facet: true });
  });

  test('facets are capped at 8 (spec 18.5)', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `f${i}`,
        { type: 'string' as const, maxLength: 8, personal: false, breakdown: true },
      ]),
    );
    const f = buildSearchFields(buildColumnModel({ table: 'public.events', customFields: many }));
    expect(facetFields(f)).toHaveLength(8);
    expect(fieldInfo(f).filter((x) => x.facet)).toHaveLength(8);
  });
});

describe('query language (18.2)', () => {
  test.each([
    ['', []],
    ['   ', []],
    ['Pricing', ['term(pricing)']],
    ['"Hello World"', ['term(hello world)']],
    ['-bot', ['-term(bot)']],
    ['plan:Pro', ['plan.exact(pro)']],
    ['page:/Blog*', ['page.prefix(/blog)']],
    ['page:*.PDF', ['page.suffix(.pdf)']],
    ['page:*docs*', ['page.contains(docs)']],
    ['referrer:*', ['referrer.exists']],
    ['plan:"a*b"', ['plan.exact(a*b)']],
    ['consent:TRUE -beta:false', ['consent=true', '-beta=false']],
    ['amount:>=10.5 amount:<-3 amount:7', ['amount>=10.5', 'amount<-3', 'amount=7']],
    ['/blog:2', ['term(/blog:2)']],
    ['a  b\tc', ['term(a)', 'term(b)', 'term(c)']],
  ])('%j', (q, expected) => {
    expect(parse(q)).toEqual(expected);
  });

  test.each([
    ['email:a@b.c', 'unknown_field@0'],
    ['ip:1.2.3.4', 'unknown_field@0'],
    ['campaign:x', 'unknown_field@0'], // personal custom field: same answer as a typo
    ['secret:x', 'unknown_field@0'],
    ['pricing nope:1', 'unknown_field@8'],
    ['https://example.com', 'unknown_field@0'],
    ['plan:', 'empty_value@5'],
    ['plan: pro', 'empty_value@5'],
    ['- x', 'empty_value@0'],
    ['-', 'empty_value@0'],
    ['""', 'empty_value@1'],
    ['"open', 'unbalanced_quote@0'],
    ['plan:"open', 'unbalanced_quote@5'],
    ['ab"cd', 'unbalanced_quote@2'],
    ['"a"b', 'unbalanced_quote@3'],
    ['page:/a*b', 'bad_value@5'],
    ['consent:yes', 'bad_value@8'],
    ['amount:ten', 'bad_value@7'],
    ['amount:>>1', 'bad_value@7'],
    ['amount:1e5', 'bad_value@7'],
  ])('%j is refused: %s', (q, expected) => {
    expect(parse(q)).toBe(expected);
  });

  test('limits: length, clause count and value length', () => {
    expect(parse('a'.repeat(QUERY_LIMITS.maxQueryChars + 1))).toBe('too_long@512');
    expect(parse(Array.from({ length: 12 }, (_, i) => `t${i}`).join(' '))).toHaveLength(12);
    const thirteen = Array.from({ length: 13 }, (_, i) => `t${i}`).join(' ');
    expect(parse(thirteen)).toBe(`too_many_clauses@${thirteen.indexOf('t12')}`);
    expect(parse('x'.repeat(128))).toHaveLength(1);
    expect(parse('x'.repeat(129))).toBe('value_too_long@0');
    expect(parse(`plan:${'x'.repeat(129)}`)).toBe('value_too_long@5');
  });

  test('never throws on arbitrary input', () => {
    const alphabet = ['a', ':', '"', '-', '*', ' ', 'plan', 'page', '>', '=', '1', '.', 'é', '%'];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i++) {
      const q = Array.from(
        { length: Math.floor(rnd() * 20) },
        () => alphabet[Math.floor(rnd() * alphabet.length)],
      ).join('');
      expect(() => parseQuery(q, fields)).not.toThrow();
    }
  });
});

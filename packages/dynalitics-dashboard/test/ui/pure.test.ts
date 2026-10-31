import { describe, expect, test } from 'vitest';
import {
  bandLayout,
  createPlot,
  labelIndexes,
  labelStep,
  niceScale,
  lineMeetsBox,
  numeralCollides,
  pointXs,
} from '../../src/ui/charts/scales.js';
import {
  axisLabel,
  bucketEnd,
  clamp01,
  parseInstant,
  createFormatters,
  pct,
  sharePct,
  splitTimestamp,
  tooltipTitle,
} from '../../src/ui/format.js';
import {
  initialRange,
  isCapped,
  offeredRanges,
  rangeByKey,
  windowFor,
} from '../../src/ui/ranges.js';
import { begin, initialState, resolve, withData } from '../../src/ui/state.js';
import { interpretEnvelope, normalizeBase } from '../../src/ui/api.js';
import { parseMeta } from '../../src/ui/meta.js';
import { NOW, bucketStarts, makeMeta } from '../fixtures/api.js';

const f = createFormatters('en-GB');

describe('formatters', () => {
  test('pct keeps one decimal and drops trailing zeros', () => {
    expect([pct(0.825), pct(1), pct(0), pct(0.3333)]).toEqual(['82.5%', '100%', '0%', '33.3%']);
  });
  test('sharePct shows <1% for tiny non-zero shares', () => {
    expect(sharePct(0.001, 3)).toBe('<1%');
    expect(sharePct(0, 0)).toBe('0%');
    expect(sharePct(0.387, 310)).toBe('39%');
  });
  test('times are rendered in UTC regardless of the machine zone', () => {
    expect(splitTimestamp(f, '2026-10-30T23:59:58.000Z')).toEqual({
      time: '23:59:58',
      date: '30 Oct',
    });
    expect(splitTimestamp(f, 'garbage')).toBeNull();
  });
  test('tooltip flags in-progress and partial buckets', () => {
    const t = Date.parse('2026-10-30T00:00:00Z');
    expect(tooltipTitle(f, t, 'day', { last: true, first: false, fromMs: 0 })).toContain(
      '(so far)',
    );
    expect(tooltipTitle(f, t, 'day', { last: false, first: true, fromMs: t + 1000 })).toContain(
      '(partial period)',
    );
    expect(tooltipTitle(f, t, 'week', { last: false, first: false, fromMs: 0 })).toMatch(
      /^Week of/,
    );
  });
  test('bucketEnd handles calendar months', () => {
    expect(bucketEnd(Date.UTC(2026, 1, 1), 'month')).toBe(Date.UTC(2026, 2, 1));
  });
  test('parseInstant is strict: lenient Date.parse inputs are rejected', () => {
    expect(parseInstant('2026-10-30T12:00:00.000Z')).toBe(Date.UTC(2026, 9, 30, 12));
    expect(parseInstant('2026-10-30')).toBe(Date.UTC(2026, 9, 30));
    for (const bad of [
      '<img src=x onerror=1>',
      'Oct 30 2026',
      '1',
      '2026-10-30T12:00:00+02:00',
      '',
    ])
      expect(parseInstant(bad)).toBeNaN();
  });
  test('clamp01 never lets a hostile number escape 0..1', () => {
    expect([clamp01(5), clamp01(-1), clamp01(NaN), clamp01(Infinity), clamp01(0.4)]).toEqual([
      1, 0, 0, 0, 0.4,
    ]);
  });
});

describe('scales', () => {
  test('niceScale yields round ticks and starts at zero', () => {
    expect(niceScale(412)).toMatchObject({ step: 200, yMax: 600 });
    expect(niceScale(412).ticks).toEqual([0, 200, 400, 600]);
    expect(niceScale(0).yMax).toBe(4);
    expect(niceScale(NaN).yMax).toBe(4);
    expect(niceScale(7).ticks.every(Number.isInteger)).toBe(true);
  });
  test('label spacing keeps >= 64px and always labels the first bucket', () => {
    expect(labelStep(100)).toBe(1);
    expect(labelStep(10)).toBe(7);
    expect(labelIndexes(8, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(labelIndexes(31, 7)[0]).toBe(0);
    expect(labelIndexes(31, 7)).not.toContain(29);
  });
  test('layouts stay inside the plot', () => {
    const plot = createPlot(288, 180);
    const xs = pointXs(plot, 8);
    expect(xs[0]).toBe(plot.left);
    expect(xs[7]).toBe(plot.right);
    const bands = bandLayout(plot, 90);
    expect(bands.bandWidth).toBeGreaterThanOrEqual(2);
    expect(pointXs(plot, 1)).toHaveLength(1);
  });
  test('numeral collision rule (DESIGN 7.6): measured box, every segment, no usable size', () => {
    const plotW = 830;
    const xs = Array.from({ length: 8 }, (_, i) => 40 + (i * plotW) / 7);
    const high = xs.map((x) => ({ x, y: 20 })); // line near the top of the plot
    const low = xs.map((x) => ({ x, y: 300 })); // line near the bottom
    expect(numeralCollides(high, { w: 150, h: 104 }, plotW)).toBe(true);
    expect(numeralCollides(low, { w: 150, h: 104 }, plotW)).toBe(false);
    expect(numeralCollides([], { w: 150, h: 104 }, plotW)).toBe(false);
    expect(numeralCollides(low, null, plotW)).toBe(true);
    expect(numeralCollides(low, { w: 0, h: 104 }, plotW)).toBe(true);
    expect(numeralCollides(low, { w: plotW * 0.61, h: 104 }, plotW)).toBe(true);
  });
  test('a peak between two vertices inside the numeral box is found (segments, not vertices)', () => {
    // vertices at x=10 and x=400 are far from the box, but the segment between them crosses it high up
    const line = [
      { x: 10, y: 20 },
      { x: 400, y: 20 },
    ];
    expect(numeralCollides(line, { w: 150, h: 104 }, 830)).toBe(true);
    expect(lineMeetsBox(line, { left: 36, top: -6, right: 220, bottom: 130 })).toBe(true);
    expect(
      lineMeetsBox(
        [
          { x: 300, y: 20 },
          { x: 400, y: 20 },
        ],
        { left: 36, top: -6, right: 220, bottom: 130 },
      ),
    ).toBe(false);
    expect(lineMeetsBox([{ x: 100, y: 20 }], { left: 36, top: -6, right: 220, bottom: 130 })).toBe(
      true,
    );
  });
  test.each([7, 80, 801, 12_345, 1_234_567])(
    'total %i at 1024 and 1440: stacked, or the line stays clear of the numeral',
    (total) => {
      const text = total.toLocaleString('en-US');
      const w =
        (text.length - (text.match(/,/g)?.length ?? 0)) * 54 + (text.match(/,/g)?.length ?? 0) * 26;
      for (const plotW of [830, 780]) {
        for (const peak of ['early', 'late']) {
          const ys = Array.from({ length: 8 }, (_, i) =>
            peak === 'early' ? 30 + i * 30 : 240 - i * 30,
          );
          const line = ys.map((y, i) => ({ x: 40 + (i * plotW) / 7, y }));
          const collides = numeralCollides(line, { w, h: 104 }, plotW);
          if (!collides) {
            // brute force: sample the polyline densely and make sure nothing enters the grown box
            for (let x = 36; x <= 48 + w + 12; x += 2) {
              const i = Math.min(6, Math.max(0, Math.floor(((x - 40) / plotW) * 7)));
              const a = line[i]!;
              const b = line[i + 1]!;
              const y = a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
              if (x >= a.x && x <= b.x) expect(y).toBeGreaterThanOrEqual(6 + 104 + 12);
            }
          }
        }
      }
    },
  );
});

describe('ranges', () => {
  const meta = makeMeta('ok');
  test('window uses the server clock and half-open ISO strings', () => {
    const w = windowFor(rangeByKey('7d')!, NOW)!;
    expect(w.to).toBe(NOW);
    expect(w.from).toBe('2026-10-23T12:05:00.000Z');
    expect(windowFor(rangeByKey('7d')!, 'nope')).toBeNull();
  });
  test('new-vs-returning cap shortens the window and switches 90d weekly to daily', () => {
    const r = rangeByKey('90d')!;
    expect(isCapped(r, 31)).toBe(true);
    const w = windowFor(r, NOW, 31)!;
    expect(w.toMs - w.fromMs).toBe(31 * 86_400_000);
    expect(w.interval).toBe('day');
  });
  test('only ranges the server allows are offered; hash and defaults pick the start', () => {
    const tight = { ...meta, limits: { ...meta.limits, maxRangeDays: 30 } };
    expect(offeredRanges(tight).map((r) => r.key)).toEqual(['24h', '7d', '30d']);
    expect(initialRange(meta, '#range=30d')).toBe('30d');
    expect(initialRange(tight, '#range=90d')).toBe('7d');
    expect(initialRange(meta, '')).toBe('7d');
  });
  test('fixture buckets are zero-filled and Monday-aligned for weeks', () => {
    const starts = bucketStarts(Date.parse('2026-08-01T00:00:00Z'), Date.parse(NOW), 'week');
    expect(new Date(starts[0]!).getUTCDay()).toBe(1);
  });
});

describe('panel state machine', () => {
  const never = () => false;
  const data = {
    kind: 'data',
    data: { n: 1 },
    meta: { generatedAt: NOW, piiMasked: true, cached: false },
  } as const;
  test('first load: loading -> ready', () => {
    const s = begin(initialState<{ n: number }>());
    expect(s.status).toBe('loading');
    expect(resolve(s, s.reqId, data, never).status).toBe('ready');
  });
  test('empty data is its own state', () => {
    const s = begin(initialState<{ n: number }>());
    expect(resolve(s, s.reqId, data, () => true).status).toBe('empty');
  });
  test('a stale response cannot overwrite a newer request', () => {
    const first = begin(initialState<{ n: number }>());
    const ready = resolve(first, first.reqId, data, never);
    const second = begin(ready);
    const third = begin(second);
    expect(
      resolve(
        third,
        second.reqId,
        { kind: 'error', failure: { kind: 'server', status: 500 } },
        never,
      ),
    ).toBe(third);
  });
  test('refresh keeps data and flags refreshing; failure keeps data with a stale failure', () => {
    const ready = resolve(begin(initialState<{ n: number }>()), 1, data, never);
    const again = begin(ready);
    expect(again).toMatchObject({ status: 'ready', refreshing: true });
    const failed = resolve(
      again,
      again.reqId,
      { kind: 'error', failure: { kind: 'unreachable', status: 0 } },
      never,
    );
    expect(failed).toMatchObject({
      status: 'ready',
      refreshing: false,
      staleFailure: { kind: 'unreachable' },
    });
    expect(failed.data).toEqual({ n: 1 });
  });
  test('first-load failure is an error; unavailable is not an error; aborted is ignored', () => {
    const s = begin(initialState<{ n: number }>());
    expect(
      resolve(s, s.reqId, { kind: 'error', failure: { kind: 'forbidden', status: 403 } }, never)
        .status,
    ).toBe('error');
    const un = resolve(
      s,
      s.reqId,
      {
        kind: 'unavailable',
        unavailable: { reason: 'disabled_by_host', message: 'm' },
        meta: data.meta,
      },
      never,
    );
    expect(un).toMatchObject({ status: 'unavailable', failure: null });
    expect(resolve(s, s.reqId, { kind: 'aborted' }, never)).toBe(s);
  });
  test('withData re-derives empty', () => {
    const ready = resolve(begin(initialState<{ n: number }>()), 1, data, never);
    expect(withData(ready, { n: 0 }, (d) => d.n === 0).status).toBe('empty');
  });
});

describe('api envelope mapping', () => {
  const meta = { generatedAt: NOW, piiMasked: true, cached: false };
  const err = (code: string, status: number) =>
    interpretEnvelope(status, {
      success: false,
      data: null,
      unavailable: null,
      error: { code, message: 'SELECT secret FROM t', param: 'from' },
    });
  test('success with data, and success with unavailable (HTTP 200, not an error)', () => {
    expect(
      interpretEnvelope(200, {
        success: true,
        data: { a: 1 },
        unavailable: null,
        error: null,
        meta,
      }).kind,
    ).toBe('data');
    const r = interpretEnvelope(200, {
      success: true,
      data: null,
      error: null,
      meta,
      unavailable: { reason: 'no_identity_column', message: 'hi' },
    });
    expect(r.kind).toBe('unavailable');
  });
  test.each([
    ['forbidden', 403, 'forbidden'],
    ['timeout', 504, 'timeout'],
    ['unavailable', 503, 'busy'],
    ['range_too_large', 400, 'bad_request'],
    ['invalid_parameter', 400, 'bad_request'],
    ['not_found', 404, 'not_found'],
    ['internal', 500, 'server'],
  ])('error code %s maps to %s', (code, status, kind) => {
    const r = err(code, status);
    expect(r.kind === 'error' && r.failure.kind).toBe(kind);
  });
  test('failure never carries the server message', () => {
    expect(JSON.stringify(err('internal', 500))).not.toContain('SELECT');
  });
  test('401 without a JSON envelope is still forbidden; junk is unexpected', () => {
    expect(interpretEnvelope(401, 'x')).toMatchObject({ failure: { kind: 'forbidden' } });
    expect(interpretEnvelope(200, { hello: 1 })).toMatchObject({ failure: { kind: 'unexpected' } });
    expect(
      interpretEnvelope(200, { success: true, data: [1], unavailable: null, meta }),
    ).toMatchObject({ kind: 'error' });
  });
  test('base is a same-origin path prefix only', () => {
    expect(normalizeBase('/admin/analytics/')).toBe('/admin/analytics');
    expect(normalizeBase('/')).toBe('');
    for (const bad of [
      'https://evil.test',
      '//evil.test',
      '/a b',
      '/a?x',
      'javascript:1',
      '/"><x',
      null,
    ])
      expect(normalizeBase(bad as string)).toBe('');
  });
});

describe('parseMeta', () => {
  test('accepts the v2 contract and rejects other versions and broken shapes', () => {
    expect(parseMeta(makeMeta('ok'))).not.toBeNull();
    expect(parseMeta({ ...makeMeta('ok'), version: 1 })).toBeNull();
    expect(parseMeta({ ...makeMeta('ok'), now: 'x' })).toBeNull();
    expect(parseMeta({ ...makeMeta('ok'), widgets: {} })).toBeNull();
    expect(parseMeta(null)).toBeNull();
  });
});

describe('error copy and labels cover every failure kind', () => {
  const kinds = [
    'forbidden',
    'unexpected',
    'unreachable',
    'timeout',
    'busy',
    'bad_request',
    'not_found',
    'server',
  ] as const;
  test.each(kinds)('%s renders a stamp, fixed copy and never a server message', async (kind) => {
    const { errorBlock } = await import('../../src/ui/states.js');
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('');
    Object.assign(globalThis, { document: dom.window.document });
    const node = errorBlock(
      { kind, status: 500, code: 'internal' },
      {
        role: 'status',
        cooldownLeftMs: 0,
        onRetry: () => {},
        onReload: () => {},
        onTrySevenDays: null,
      },
    );
    expect(node.querySelector('.dy-stamp')?.textContent).toMatch(/^[A-Z ]+$/);
    expect(node.querySelector('h3')?.textContent?.length).toBeGreaterThan(5);
    expect(node.textContent).not.toContain('SELECT');
  });
  test('axis labels: hourly first/midnight show the date, others the time; months show the month', () => {
    const t = Date.UTC(2026, 9, 30, 14);
    expect(axisLabel(f, t, 'hour', true)).toBe('30 Oct');
    expect(axisLabel(f, t, 'hour', false)).toBe('14:00');
    expect(axisLabel(f, Date.UTC(2026, 9, 30, 0), 'hour', false)).toBe('30 Oct');
    expect(axisLabel(f, t, 'month', false)).toBe('Oct');
    expect(axisLabel(f, t, 'week', false)).toBe('30 Oct');
    expect(tooltipTitle(f, t, 'hour', { last: false, first: false, fromMs: 0 })).toContain(
      '14:00-15:00 UTC',
    );
    expect(tooltipTitle(f, t, 'month', { last: false, first: false, fromMs: 0 })).toContain('2026');
  });
  test('bucketEnd for every interval; label helpers tolerate degenerate input', () => {
    const t = Date.UTC(2026, 9, 5);
    expect([bucketEnd(t, 'hour') - t, bucketEnd(t, 'day') - t, bucketEnd(t, 'week') - t]).toEqual([
      3_600_000, 86_400_000, 604_800_000,
    ]);
    expect(labelStep(0)).toBe(1);
    expect(labelIndexes(1, 3)).toEqual([0]);
  });
});

import { describe, expect, it } from 'vitest';
import { TimescaleError } from '../src/index.js';
import {
  assertParsableInterval,
  canonicalizeInterval,
  intervalsEqual,
  parsePolicyConfig,
  policiesEqual,
  normalizeCaggDefinition,
  caggDefinitionsEqual,
} from '../src/normalize.js';

describe('canonicalizeInterval — matches Postgres interval equality (30-day month, 24-hour day)', () => {
  // Pairs Postgres's `=` operator treats as EQUAL — the canonical key must match.
  it.each([
    ['1 day', '24 hours'],
    ['1 day', '24:00:00'],
    ['1 day', '1440 minutes'],
    ['12 hours', '12:00:00'],
    ['12 hours', '720 minutes'],
    ['3 days', '72 hours'],
    ['1 day 02:00:00', '26 hours'],
    ['30 minutes', '00:30:00'],
    ['1 week', '7 days'],
    ['1 mon', '30 days'],
    ['1 month', '30 days'],
    ['1 year', '12 mons'],
    ['1 year', '360 days'],
    ['00:00:01.5', '1500 milliseconds'],
    ['2 days', '2 days'],
  ])('%s == %s', (a, b) => {
    expect(canonicalizeInterval(a)).toBe(canonicalizeInterval(b));
    expect(intervalsEqual(a, b)).toBe(true);
  });

  // Pairs Postgres treats as DISTINCT — the canonical key must differ.
  it.each([
    ['1 mon', '31 days'],
    ['1 year', '365 days'],
    ['1 day', '23 hours'],
    ['12:00:00', '12:00:01'],
    ['1 day', '2 days'],
  ])('%s != %s', (a, b) => {
    expect(canonicalizeInterval(a)).not.toBe(canonicalizeInterval(b));
    expect(intervalsEqual(a, b)).toBe(false);
  });

  it('handles negative time components', () => {
    expect(canonicalizeInterval('-02:00:00')).toBe(canonicalizeInterval('-2 hours'));
    expect(intervalsEqual('-02:00:00', '2 hours')).toBe(false);
  });

  it('handles integer intervals (integer-time hypertables) distinctly from interval strings', () => {
    expect(canonicalizeInterval(1_000_000)).toBe('int:1000000');
    expect(intervalsEqual(1_000_000, 1_000_000)).toBe(true);
    expect(intervalsEqual(1_000_000, 1_000_001)).toBe(false);
    // an integer interval is never equal to an interval string, even a coincidental one
    expect(intervalsEqual(1_000_000, '1 second')).toBe(false);
  });

  it('canonicalizes to a us: key with the 30-day-month total for a plain interval', () => {
    // 7 days = 7 * 86_400_000_000 us
    expect(canonicalizeInterval('7 days')).toBe('us:604800000000');
    // 1 mon = 30 * 86_400_000_000 us
    expect(canonicalizeInterval('1 mon')).toBe('us:2592000000000');
  });

  it('falls back to a raw key for an unrecognized form (never throws)', () => {
    const k = canonicalizeInterval('every other tuesday');
    expect(k.startsWith('raw:')).toBe(true);
    // same unparseable text compares equal to itself; a different one does not
    expect(intervalsEqual('every other tuesday', 'every  other tuesday')).toBe(true); // whitespace-collapsed
    expect(intervalsEqual('every other tuesday', 'never')).toBe(false);
  });

  it('undefined handling: both undefined equal, one undefined not', () => {
    expect(intervalsEqual(undefined, undefined)).toBe(true);
    expect(intervalsEqual('1 day', undefined)).toBe(false);
  });

  it('honors Postgres mixed-sign output (negative days + positive time)', () => {
    // `-1 days +02:00:00` = -22 hours, NOT -1 day — the `+` on the time must not be dropped
    expect(canonicalizeInterval('-1 days +02:00:00')).toBe(canonicalizeInterval('-22 hours'));
    expect(canonicalizeInterval('-1 days +02:00:00')).not.toBe(canonicalizeInterval('-1 day'));
  });

  it('rounds sub-microsecond fractional seconds like Postgres (not truncate)', () => {
    // .9999999 s rounds up to 1 s → 00:00:02 total, equal to 2 seconds
    expect(intervalsEqual('00:00:01.9999999', '2 seconds')).toBe(true);
    // a fraction within µs precision is exact
    expect(intervalsEqual('00:00:00.5', '500 milliseconds')).toBe(true);
  });

  it('quarantines a partial parse (junk around a recognized token) to raw, never a confident mis-parse', () => {
    expect(canonicalizeInterval('every 5 minutes').startsWith('raw:')).toBe(true);
    expect(intervalsEqual('every 5 minutes', '5 minutes')).toBe(false);
  });

  it('preserves precision for counts beyond 2^53 (BigInt parse, not Number)', () => {
    expect(canonicalizeInterval('9007199254740993 microseconds')).toBe('us:9007199254740993');
  });

  it('parses multi-digit hours in the time component', () => {
    expect(intervalsEqual('100:00:00', '100 hours')).toBe(true);
  });
});

describe('parsePolicyConfig — proc_name → logical policy, internal ids stripped', () => {
  it('maps policy_compression and strips hypertable_id', () => {
    const p = parsePolicyConfig('policy_compression', {
      compress_after: '3 days',
      hypertable_id: 17,
    });
    expect(p).toMatchObject({ kind: 'compression', after: '3 days' });
    expect(p.rawConfig).toBeUndefined();
  });

  it('maps policy_retention', () => {
    expect(
      parsePolicyConfig('policy_retention', { drop_after: '30 days', hypertable_id: 19 }),
    ).toMatchObject({
      kind: 'retention',
      after: '30 days',
    });
  });

  it('maps policy_refresh_continuous_aggregate (start/end offsets) and strips mat_hypertable_id', () => {
    expect(
      parsePolicyConfig('policy_refresh_continuous_aggregate', {
        start_offset: '3 days',
        end_offset: '1 hour',
        mat_hypertable_id: 21,
      }),
    ).toMatchObject({ kind: 'refresh', startOffset: '3 days', endOffset: '1 hour' });
  });

  it('degrades an unknown proc to unmanaged, keeping opaque config minus internal ids', () => {
    const p = parsePolicyConfig('user_backfill_job', { window: '5 min', hypertable_id: 5 });
    expect(p.kind).toBe('unmanaged');
    expect(p.procName).toBe('user_backfill_job');
    expect(p.rawConfig).toEqual({ window: '5 min' }); // hypertable_id stripped
  });

  it('threads scheduleInterval', () => {
    expect(
      parsePolicyConfig('policy_compression', { compress_after: '3 days' }, '12 hours')
        .scheduleInterval,
    ).toBe('12 hours');
  });

  it('reads the created_before variant (TSDB 2.13+) for compression and retention', () => {
    expect(
      parsePolicyConfig('policy_compression', {
        compress_created_before: '7 days',
        hypertable_id: 3,
      }),
    ).toMatchObject({ kind: 'compression', createdBefore: '7 days' });
    expect(parsePolicyConfig('policy_retention', { drop_created_before: '30 days' })).toMatchObject(
      {
        kind: 'retention',
        createdBefore: '30 days',
      },
    );
  });
});

describe('policiesEqual', () => {
  it('equal when offsets canonicalize equal even if written differently', () => {
    const a = parsePolicyConfig('policy_compression', { compress_after: '3 days' }, '12 hours');
    const b = parsePolicyConfig('policy_compression', { compress_after: '72 hours' }, '12 hours');
    expect(policiesEqual(a, b)).toBe(true);
  });
  it('unequal on differing kind or offset', () => {
    const comp = parsePolicyConfig('policy_compression', { compress_after: '3 days' });
    const ret = parsePolicyConfig('policy_retention', { drop_after: '3 days' });
    expect(policiesEqual(comp, ret)).toBe(false);
    const comp2 = parsePolicyConfig('policy_compression', { compress_after: '4 days' });
    expect(policiesEqual(comp, comp2)).toBe(false);
  });
  it('unmanaged compares by procName + raw config', () => {
    const a = parsePolicyConfig('job_x', { a: 1 });
    const b = parsePolicyConfig('job_x', { a: 1 });
    const c = parsePolicyConfig('job_x', { a: 2 });
    expect(policiesEqual(a, b)).toBe(true);
    expect(policiesEqual(a, c)).toBe(false);
  });
  it('distinguishes the after vs createdBefore threshold variants (not a masked diff)', () => {
    const after = parsePolicyConfig('policy_compression', { compress_after: '7 days' });
    const before = parsePolicyConfig('policy_compression', { compress_created_before: '7 days' });
    expect(policiesEqual(after, before)).toBe(false);
  });
});

describe('CAGG definition normalization (case-preserving)', () => {
  it('collapses whitespace + trailing semicolon (same case) for comparison', () => {
    const a = "SELECT time_bucket('1 hour', ts) AS bucket, avg(v)  FROM reading GROUP BY bucket;";
    const b = "SELECT time_bucket('1 hour', ts) AS bucket, avg(v) FROM reading GROUP BY bucket";
    expect(caggDefinitionsEqual(a, b)).toBe(true);
    expect(normalizeCaggDefinition(a)).toBe(normalizeCaggDefinition(b));
  });
  it('does NOT lowercase — a case-differing string literal is a genuinely different definition', () => {
    expect(
      caggDefinitionsEqual(
        "SELECT count(*) FROM t WHERE s = 'Active'",
        "SELECT count(*) FROM t WHERE s = 'active'",
      ),
    ).toBe(false);
    // a quoted identifier's case is significant in Postgres (distinct columns)
    expect(caggDefinitionsEqual('SELECT "MyCol" FROM t', 'SELECT "mycol" FROM t')).toBe(false);
  });
  it('distinguishes genuinely different definitions', () => {
    expect(caggDefinitionsEqual('SELECT avg(v) FROM reading', 'SELECT sum(v) FROM reading')).toBe(
      false,
    );
  });
});

describe('assertParsableInterval', () => {
  it('accepts <n> <unit> form', () => {
    expect(assertParsableInterval('30 minutes', 'x')).toBe('30 minutes');
    expect(assertParsableInterval('1 day', 'x')).toBe('1 day');
  });

  it('accepts Postgres HH:MM:SS time form (sub-day introspected intervals)', () => {
    expect(assertParsableInterval('01:00:00', 'x')).toBe('01:00:00');
    expect(assertParsableInterval('00:30:00', 'x')).toBe('00:30:00');
  });

  it('accepts the compound form Postgres emits for >24h non-day-aligned intervals', () => {
    expect(assertParsableInterval('1 day 02:00:00', 'x')).toBe('1 day 02:00:00');
  });

  it('rejects an unrecognized value (would canonicalize to raw:)', () => {
    expect(() => assertParsableInterval('every 5 minutes', 'x')).toThrow(TimescaleError);
    expect(() => assertParsableInterval('not-an-interval', 'x')).toThrow(TimescaleError);
  });

  it('with { positive } rejects zero and negative intervals', () => {
    expect(() => assertParsableInterval('0 seconds', 'x', { positive: true })).toThrow(
      TimescaleError,
    );
    expect(() => assertParsableInterval('-1 hour', 'x', { positive: true })).toThrow(
      TimescaleError,
    );
    expect(assertParsableInterval('1 hour', 'x', { positive: true })).toBe('1 hour');
    expect(assertParsableInterval('00:30:00', 'x', { positive: true })).toBe('00:30:00');
  });
});

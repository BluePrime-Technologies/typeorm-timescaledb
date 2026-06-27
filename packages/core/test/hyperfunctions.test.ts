import { describe, expect, it } from 'vitest';
import {
  timeBucketExpr,
  firstExpr,
  lastExpr,
  histogramExpr,
  timeBucketGapfillExpr,
  locfExpr,
  interpolateExpr,
  TimescaleError,
  TimescaleErrorCode,
} from '../src/index.js';

describe('timeBucketExpr', () => {
  it('builds the base two-arg form', () => {
    expect(timeBucketExpr({ interval: '1 hour', column: 'ts' })).toBe(
      `time_bucket(INTERVAL '1 hour', "ts")`,
    );
  });

  it('quotes/allow-lists the column', () => {
    expect(timeBucketExpr({ interval: '15 minutes', column: 'created_at' })).toBe(
      `time_bucket(INTERVAL '15 minutes', "created_at")`,
    );
  });

  it('emits the timezone variant', () => {
    expect(timeBucketExpr({ interval: '1 day', column: 'ts', timezone: 'Europe/London' })).toBe(
      `time_bucket(INTERVAL '1 day', "ts", 'Europe/London')`,
    );
  });

  it('emits the origin (non-tz) form', () => {
    expect(timeBucketExpr({ interval: '1 day', column: 'ts', origin: '2024-01-01' })).toBe(
      `time_bucket(INTERVAL '1 day', "ts", TIMESTAMPTZ '2024-01-01')`,
    );
  });

  it('emits the offset (non-tz) form', () => {
    expect(timeBucketExpr({ interval: '1 hour', column: 'ts', offset: '30 minutes' })).toBe(
      `time_bucket(INTERVAL '1 hour', "ts", INTERVAL '30 minutes')`,
    );
  });

  it('combines origin + offset under a timezone (positional)', () => {
    expect(
      timeBucketExpr({
        interval: '1 day',
        column: 'ts',
        timezone: 'UTC',
        origin: '2024-01-01',
        offset: '6 hours',
      }),
    ).toBe(
      `time_bucket(INTERVAL '1 day', "ts", 'UTC', TIMESTAMPTZ '2024-01-01', INTERVAL '6 hours')`,
    );
  });

  it('uses a NULL origin placeholder for offset-only under a timezone', () => {
    expect(
      timeBucketExpr({ interval: '1 day', column: 'ts', timezone: 'UTC', offset: '6 hours' }),
    ).toBe(`time_bucket(INTERVAL '1 day', "ts", 'UTC', NULL::timestamptz, INTERVAL '6 hours')`);
  });

  it('rejects origin + offset without a timezone', () => {
    expect(() =>
      timeBucketExpr({ interval: '1 day', column: 'ts', origin: '2024-01-01', offset: '1 hour' }),
    ).toThrowError(TimescaleError);
  });

  it('rejects an unsafe column (injection attempt)', () => {
    expect(() =>
      timeBucketExpr({ interval: '1 hour', column: 'ts); DROP TABLE x;--' }),
    ).toThrowError(expect.objectContaining({ code: TimescaleErrorCode.UNSAFE_IDENTIFIER }));
  });

  it('rejects a malformed interval', () => {
    expect(() => timeBucketExpr({ interval: '1 fortnight', column: 'ts' })).toThrowError(
      expect.objectContaining({ code: TimescaleErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('escapes a single-quote in the timezone literal', () => {
    // not a real tz, but proves the literal is escaped rather than breaking out
    expect(timeBucketExpr({ interval: '1 day', column: 'ts', timezone: "a'b" })).toBe(
      `time_bucket(INTERVAL '1 day', "ts", 'a''b')`,
    );
  });
});

describe('first / last', () => {
  it('builds first(value, time)', () => {
    expect(firstExpr('price', 'ts')).toBe(`first("price", "ts")`);
  });
  it('builds last(value, time)', () => {
    expect(lastExpr('price', 'ts')).toBe(`last("price", "ts")`);
  });
  it('rejects unsafe identifiers', () => {
    expect(() => firstExpr('a, b', 'ts')).toThrowError(TimescaleError);
    expect(() => lastExpr('price', 'ts"--')).toThrowError(TimescaleError);
  });
});

describe('histogramExpr', () => {
  it('builds histogram(value, min, max, nbuckets)', () => {
    expect(histogramExpr({ column: 'value', min: 0, max: 100, nbuckets: 5 })).toBe(
      `histogram("value", 0, 100, 5)`,
    );
  });
  it('supports decimal bounds', () => {
    expect(histogramExpr({ column: 'v', min: 0.5, max: 99.5, nbuckets: 10 })).toBe(
      `histogram("v", 0.5, 99.5, 10)`,
    );
  });
  it('rejects min >= max', () => {
    expect(() => histogramExpr({ column: 'v', min: 100, max: 0, nbuckets: 5 })).toThrowError(
      expect.objectContaining({ code: TimescaleErrorCode.INVALID_ARGUMENT }),
    );
  });
  it('rejects non-positive / non-integer nbuckets', () => {
    expect(() => histogramExpr({ column: 'v', min: 0, max: 1, nbuckets: 0 })).toThrowError(
      TimescaleError,
    );
    expect(() => histogramExpr({ column: 'v', min: 0, max: 1, nbuckets: 2.5 })).toThrowError(
      TimescaleError,
    );
  });
  it('rejects non-finite bounds', () => {
    expect(() => histogramExpr({ column: 'v', min: 0, max: Infinity, nbuckets: 5 })).toThrowError(
      expect.objectContaining({ code: TimescaleErrorCode.INVALID_ARGUMENT }),
    );
  });
  it('rejects an unsafe column', () => {
    expect(() =>
      histogramExpr({ column: 'v)::int,0,0,0)--', min: 0, max: 1, nbuckets: 1 }),
    ).toThrowError(TimescaleError);
  });
});

describe('timeBucketGapfillExpr', () => {
  it('builds the base form (bounds from WHERE)', () => {
    expect(timeBucketGapfillExpr({ interval: '1 hour', column: 'ts' })).toBe(
      `time_bucket_gapfill(INTERVAL '1 hour', "ts")`,
    );
  });
  it('builds the explicit start/finish form', () => {
    expect(
      timeBucketGapfillExpr({
        interval: '1 hour',
        column: 'ts',
        start: '2024-01-01',
        finish: '2024-01-02',
      }),
    ).toBe(
      `time_bucket_gapfill(INTERVAL '1 hour', "ts", TIMESTAMPTZ '2024-01-01', TIMESTAMPTZ '2024-01-02')`,
    );
  });
  it('rejects an inverted range (finish <= start)', () => {
    expect(() =>
      timeBucketGapfillExpr({
        interval: '1 hour',
        column: 'ts',
        start: '2024-01-02',
        finish: '2024-01-01',
      }),
    ).toThrowError(expect.objectContaining({ code: TimescaleErrorCode.INVALID_ARGUMENT }));
  });
  it('rejects only-start or only-finish', () => {
    expect(() =>
      timeBucketGapfillExpr({ interval: '1 hour', column: 'ts', start: '2024-01-01' }),
    ).toThrowError(expect.objectContaining({ code: TimescaleErrorCode.INVALID_ARGUMENT }));
    expect(() =>
      timeBucketGapfillExpr({ interval: '1 hour', column: 'ts', finish: '2024-01-02' }),
    ).toThrowError(TimescaleError);
  });
  it('rejects an unsafe column and bad interval', () => {
    expect(() => timeBucketGapfillExpr({ interval: '1 hour', column: 'ts);--' })).toThrowError(
      TimescaleError,
    );
    expect(() => timeBucketGapfillExpr({ interval: 'soon', column: 'ts' })).toThrowError(
      TimescaleError,
    );
  });
});

describe('locf / interpolate', () => {
  it('wrap a (trusted) aggregate fragment', () => {
    expect(locfExpr('avg("v")')).toBe('locf(avg("v"))');
    expect(interpolateExpr('avg("v")')).toBe('interpolate(avg("v"))');
  });
});

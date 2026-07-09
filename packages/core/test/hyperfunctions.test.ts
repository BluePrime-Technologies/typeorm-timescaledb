import { describe, expect, it } from 'vitest';
import {
  timeBucketExpr,
  firstExpr,
  lastExpr,
  histogramExpr,
  timeBucketGapfillExpr,
  locfExpr,
  interpolateExpr,
  candlestickAggExpr,
  candlestickAccessorExpr,
  approxCountDistinctAggExpr,
  distinctCountExpr,
  lttbExpr,
  asapSmoothExpr,
  statsAgg1DExpr,
  statsAgg2DExpr,
  statsAccessor1DExpr,
  statsAccessor2DExpr,
  percentileAggExpr,
  approxPercentileExpr,
  approxPercentileRankExpr,
  percentileSketchAccessorExpr,
  counterAggExpr,
  counterAccessorExpr,
  timeWeightAggExpr,
  timeWeightAccessorExpr,
  timeWeightIntegralExpr,
  stateAggExpr,
  stateIntoValuesExpr,
  stateTimelineExpr,
  statePeriodsExpr,
  stateAtExpr,
  mcvAggExpr,
  mcvIntoValuesExpr,
  mcvTopNExpr,
  mcvMaxFrequencyExpr,
  mcvMinFrequencyExpr,
  heartbeatAggExpr,
  heartbeatAccessorExpr,
  heartbeatLiveAtExpr,
  heartbeatLiveRangesExpr,
  heartbeatDeadRangesExpr,
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

describe('toolkit builders', () => {
  it('candlestickAggExpr quotes all three columns', () => {
    expect(candlestickAggExpr('ts', 'price', 'vol')).toBe('candlestick_agg("ts", "price", "vol")');
  });
  it('lttbExpr / asapSmoothExpr quote columns and bind the resolution', () => {
    expect(lttbExpr('ts', 'val', ':__resolution')).toBe('lttb("ts", "val", :__resolution)');
    expect(asapSmoothExpr('ts', 'val', '$1')).toBe('asap_smooth("ts", "val", $1)');
  });
  it('lttbExpr / asapSmoothExpr reject unsafe columns and bad bind tokens', () => {
    expect(() => lttbExpr('ts);--', 'val', ':r')).toThrowError(TimescaleError);
    expect(() => asapSmoothExpr('ts', 'val);--', ':r')).toThrowError(TimescaleError);
    expect(() => lttbExpr('ts', 'val', '10')).toThrowError(TimescaleError); // raw int, not a placeholder
  });
  it('candlestickAggExpr rejects an unsafe column', () => {
    expect(() => candlestickAggExpr('ts);--', 'price', 'vol')).toThrowError(TimescaleError);
  });
  it('candlestickAccessorExpr wraps the agg with an allow-listed accessor', () => {
    const cs = candlestickAggExpr('ts', 'price', 'vol');
    expect(candlestickAccessorExpr('open', cs)).toBe('open(candlestick_agg("ts", "price", "vol"))');
    expect(candlestickAccessorExpr('vwap', cs)).toBe('vwap(candlestick_agg("ts", "price", "vol"))');
  });
  it('approx_count_distinct must be wrapped in distinct_count for a scalar', () => {
    const agg = approxCountDistinctAggExpr('price');
    expect(agg).toBe('approx_count_distinct("price")');
    expect(distinctCountExpr(agg)).toBe('distinct_count(approx_count_distinct("price"))');
  });
  it('approxCountDistinctAggExpr rejects an unsafe column', () => {
    expect(() => approxCountDistinctAggExpr('p) FROM secrets--')).toThrowError(TimescaleError);
  });
});

describe('stats_agg builders', () => {
  it('statsAgg1DExpr quotes the value column', () => {
    expect(statsAgg1DExpr('latency')).toBe('stats_agg("latency")');
  });
  it('statsAgg2DExpr emits (Y, X) order, both quoted', () => {
    expect(statsAgg2DExpr('y', 'x')).toBe('stats_agg("y", "x")');
  });
  it('statsAgg1DExpr / statsAgg2DExpr reject unsafe columns', () => {
    expect(() => statsAgg1DExpr('v);--')).toThrowError(TimescaleError);
    expect(() => statsAgg2DExpr('y', 'x);--')).toThrowError(TimescaleError);
  });

  it('1D non-moment accessors take no method', () => {
    const agg = statsAgg1DExpr('v');
    expect(statsAccessor1DExpr('average', agg)).toBe('average(stats_agg("v"))');
    expect(statsAccessor1DExpr('sum', agg)).toBe('sum(stats_agg("v"))');
    expect(statsAccessor1DExpr('num_vals', agg)).toBe('num_vals(stats_agg("v"))');
  });
  it('1D moment accessors default to the sample method', () => {
    const agg = statsAgg1DExpr('v');
    expect(statsAccessor1DExpr('stddev', agg)).toBe('stddev(stats_agg("v"), \'sample\')');
    expect(statsAccessor1DExpr('variance', agg)).toBe('variance(stats_agg("v"), \'sample\')');
  });
  it('1D moment accessors honour an explicit population method', () => {
    const agg = statsAgg1DExpr('v');
    expect(statsAccessor1DExpr('skewness', agg, 'population')).toBe(
      'skewness(stats_agg("v"), \'population\')',
    );
    expect(statsAccessor1DExpr('kurtosis', agg, 'population')).toBe(
      'kurtosis(stats_agg("v"), \'population\')',
    );
  });
  it('1D accessor rejects an unknown accessor and an unknown method', () => {
    const agg = statsAgg1DExpr('v');
    // @ts-expect-error — not in the union
    expect(() => statsAccessor1DExpr('median', agg)).toThrowError(TimescaleError);
    // @ts-expect-error — not a StatsMethod
    expect(() => statsAccessor1DExpr('stddev', agg, 'sneaky')).toThrowError(TimescaleError);
  });

  it('2D regression accessors take no method', () => {
    const agg = statsAgg2DExpr('y', 'x');
    expect(statsAccessor2DExpr('slope', agg)).toBe('slope(stats_agg("y", "x"))');
    expect(statsAccessor2DExpr('intercept', agg)).toBe('intercept(stats_agg("y", "x"))');
    expect(statsAccessor2DExpr('corr', agg)).toBe('corr(stats_agg("y", "x"))');
    expect(statsAccessor2DExpr('determination_coeff', agg)).toBe(
      'determination_coeff(stats_agg("y", "x"))',
    );
  });
  it('2D covariance/per-axis moment accessors take a method', () => {
    const agg = statsAgg2DExpr('y', 'x');
    expect(statsAccessor2DExpr('covariance', agg)).toBe(
      'covariance(stats_agg("y", "x"), \'sample\')',
    );
    expect(statsAccessor2DExpr('stddev_y', agg, 'population')).toBe(
      'stddev_y(stats_agg("y", "x"), \'population\')',
    );
  });
  it('2D accessor rejects an unknown accessor', () => {
    const agg = statsAgg2DExpr('y', 'x');
    // @ts-expect-error — not in the union
    expect(() => statsAccessor2DExpr('gradient', agg)).toThrowError(TimescaleError);
  });
});

describe('percentile_agg builders', () => {
  it('percentileAggExpr quotes the value column', () => {
    expect(percentileAggExpr('latency')).toBe('percentile_agg("latency")');
  });
  it('percentileAggExpr rejects an unsafe column', () => {
    expect(() => percentileAggExpr('v) FROM secrets--')).toThrowError(TimescaleError);
  });
  it('approxPercentileExpr inlines a validated percentile literal', () => {
    const agg = percentileAggExpr('v');
    expect(approxPercentileExpr(0.99, agg)).toBe('approx_percentile(0.99, percentile_agg("v"))');
    expect(approxPercentileExpr(0, agg)).toBe('approx_percentile(0, percentile_agg("v"))');
    expect(approxPercentileExpr(1, agg)).toBe('approx_percentile(1, percentile_agg("v"))');
  });
  it('approxPercentileExpr rejects an out-of-range or non-finite percentile', () => {
    const agg = percentileAggExpr('v');
    expect(() => approxPercentileExpr(1.5, agg)).toThrowError(TimescaleError);
    expect(() => approxPercentileExpr(-0.1, agg)).toThrowError(TimescaleError);
    expect(() => approxPercentileExpr(Number.NaN, agg)).toThrowError(TimescaleError);
    expect(() => approxPercentileExpr(Number.POSITIVE_INFINITY, agg)).toThrowError(TimescaleError);
  });
  it('approxPercentileRankExpr inlines a validated value literal', () => {
    const agg = percentileAggExpr('v');
    expect(approxPercentileRankExpr(250, agg)).toBe(
      'approx_percentile_rank(250, percentile_agg("v"))',
    );
    expect(approxPercentileRankExpr(-3.5, agg)).toBe(
      'approx_percentile_rank(-3.5, percentile_agg("v"))',
    );
  });
  it('approxPercentileRankExpr rejects a non-finite value', () => {
    const agg = percentileAggExpr('v');
    expect(() => approxPercentileRankExpr(Number.NaN, agg)).toThrowError(TimescaleError);
  });
  it('percentileSketchAccessorExpr wraps allow-listed scalar accessors', () => {
    const agg = percentileAggExpr('v');
    expect(percentileSketchAccessorExpr('mean', agg)).toBe('mean(percentile_agg("v"))');
    expect(percentileSketchAccessorExpr('error', agg)).toBe('error(percentile_agg("v"))');
    expect(percentileSketchAccessorExpr('num_vals', agg)).toBe('num_vals(percentile_agg("v"))');
  });
  it('percentileSketchAccessorExpr rejects an unknown accessor', () => {
    const agg = percentileAggExpr('v');
    // @ts-expect-error — not in the union
    expect(() => percentileSketchAccessorExpr('median', agg)).toThrowError(TimescaleError);
  });
});

describe('counter_agg builders', () => {
  it('counterAggExpr quotes time + value columns', () => {
    expect(counterAggExpr('ts', 'requests')).toBe('counter_agg("ts", "requests")');
  });
  it('counterAggExpr rejects unsafe columns', () => {
    expect(() => counterAggExpr('ts);--', 'v')).toThrowError(TimescaleError);
    expect(() => counterAggExpr('ts', 'v);--')).toThrowError(TimescaleError);
  });
  it('counterAccessorExpr wraps allow-listed accessors', () => {
    const agg = counterAggExpr('ts', 'v');
    expect(counterAccessorExpr('delta', agg)).toBe('delta(counter_agg("ts", "v"))');
    expect(counterAccessorExpr('rate', agg)).toBe('rate(counter_agg("ts", "v"))');
    expect(counterAccessorExpr('num_resets', agg)).toBe('num_resets(counter_agg("ts", "v"))');
    expect(counterAccessorExpr('first_time', agg)).toBe('first_time(counter_agg("ts", "v"))');
    expect(counterAccessorExpr('counter_zero_time', agg)).toBe(
      'counter_zero_time(counter_agg("ts", "v"))',
    );
  });
  it('counterAccessorExpr rejects an unknown accessor', () => {
    const agg = counterAggExpr('ts', 'v');
    // @ts-expect-error — not in the union
    expect(() => counterAccessorExpr('extrapolated_rate', agg)).toThrowError(TimescaleError);
  });
});

describe('time_weight builders', () => {
  it('timeWeightAggExpr emits the method literal + columns', () => {
    expect(timeWeightAggExpr('Linear', 'ts', 'v')).toBe('time_weight(\'Linear\', "ts", "v")');
    expect(timeWeightAggExpr('LOCF', 'ts', 'v')).toBe('time_weight(\'LOCF\', "ts", "v")');
  });
  it('timeWeightAggExpr rejects an unknown method and unsafe columns', () => {
    // @ts-expect-error — not a TimeWeightMethod
    expect(() => timeWeightAggExpr('linear', 'ts', 'v')).toThrowError(TimescaleError);
    expect(() => timeWeightAggExpr('Linear', 'ts);--', 'v')).toThrowError(TimescaleError);
  });
  it('timeWeightAccessorExpr wraps allow-listed accessors', () => {
    const agg = timeWeightAggExpr('Linear', 'ts', 'v');
    expect(timeWeightAccessorExpr('average', agg)).toBe(
      'average(time_weight(\'Linear\', "ts", "v"))',
    );
    expect(timeWeightAccessorExpr('last_val', agg)).toBe(
      'last_val(time_weight(\'Linear\', "ts", "v"))',
    );
  });
  it('timeWeightAccessorExpr rejects an unknown accessor', () => {
    const agg = timeWeightAggExpr('LOCF', 'ts', 'v');
    // @ts-expect-error — not in the union
    expect(() => timeWeightAccessorExpr('integral', agg)).toThrowError(TimescaleError);
  });
  it('timeWeightIntegralExpr defaults to seconds and honours an allow-listed unit', () => {
    const agg = timeWeightAggExpr('Linear', 'ts', 'v');
    expect(timeWeightIntegralExpr(agg)).toBe(
      'integral(time_weight(\'Linear\', "ts", "v"), \'second\')',
    );
    expect(timeWeightIntegralExpr(agg, 'hour')).toBe(
      'integral(time_weight(\'Linear\', "ts", "v"), \'hour\')',
    );
  });
  it('timeWeightIntegralExpr rejects an unknown unit', () => {
    const agg = timeWeightAggExpr('Linear', 'ts', 'v');
    // @ts-expect-error — not an IntegralUnit
    expect(() => timeWeightIntegralExpr(agg, 'fortnight')).toThrowError(TimescaleError);
  });
});

describe('state_agg builders', () => {
  it('stateAggExpr quotes time + value columns', () => {
    expect(stateAggExpr('ts', 'status')).toBe('state_agg("ts", "status")');
  });
  it('stateAggExpr rejects unsafe columns', () => {
    expect(() => stateAggExpr('ts);--', 'v')).toThrowError(TimescaleError);
    expect(() => stateAggExpr('ts', 'v);--')).toThrowError(TimescaleError);
  });
  it('table-function accessors wrap a (safe) agg fragment', () => {
    const agg = stateAggExpr('ts', 'status');
    expect(stateIntoValuesExpr(agg)).toBe('into_values(state_agg("ts", "status"))');
    expect(stateTimelineExpr(agg)).toBe('state_timeline(state_agg("ts", "status"))');
  });
  it('statePeriodsExpr / stateAtExpr require a positional parameter placeholder', () => {
    const agg = stateAggExpr('ts', 'status');
    expect(statePeriodsExpr(agg, '$2')).toBe('state_periods(state_agg("ts", "status"), $2)');
    expect(stateAtExpr(agg, '$2')).toBe('state_at(state_agg("ts", "status"), $2)');
    // Raw values must never be inlined — only valid 1-based $N placeholders are accepted.
    expect(() => statePeriodsExpr(agg, "'on'")).toThrowError(TimescaleError);
    expect(() => stateAtExpr(agg, 'now()')).toThrowError(TimescaleError);
    expect(() => stateAtExpr(agg, '$0')).toThrowError(TimescaleError);
    expect(() => statePeriodsExpr(agg, '$01')).toThrowError(TimescaleError);
  });
});

describe('mcv_agg builders', () => {
  it('mcvAggExpr inlines a validated count and quotes the value column', () => {
    expect(mcvAggExpr(10, 'status')).toBe('mcv_agg(10, "status")');
  });
  it('mcvAggExpr rejects a non-positive / non-integer / out-of-int4-range count and unsafe column', () => {
    expect(() => mcvAggExpr(0, 'v')).toThrowError(TimescaleError);
    expect(() => mcvAggExpr(2.5, 'v')).toThrowError(TimescaleError);
    // 1e21 is an "integer" to Number.isInteger but stringifies to scientific notation.
    expect(() => mcvAggExpr(1e21, 'v')).toThrowError(TimescaleError);
    expect(() => mcvAggExpr(2147483648, 'v')).toThrowError(TimescaleError); // > int4 max
    expect(() => mcvAggExpr(10, 'v);--')).toThrowError(TimescaleError);
  });
  it('mcvIntoValuesExpr / mcvTopNExpr wrap a (safe) agg fragment', () => {
    const agg = mcvAggExpr(10, 'status');
    expect(mcvIntoValuesExpr(agg)).toBe('into_values(mcv_agg(10, "status"))');
    expect(mcvTopNExpr(agg, 3)).toBe('topn(mcv_agg(10, "status"), 3)');
  });
  it('mcvTopNExpr rejects a non-positive n', () => {
    const agg = mcvAggExpr(10, 'status');
    expect(() => mcvTopNExpr(agg, 0)).toThrowError(TimescaleError);
  });
  it('frequency accessors require a positional parameter placeholder for the value', () => {
    const agg = mcvAggExpr(10, 'status');
    expect(mcvMaxFrequencyExpr(agg, '$2')).toBe('max_frequency(mcv_agg(10, "status"), $2)');
    expect(mcvMinFrequencyExpr(agg, '$2')).toBe('min_frequency(mcv_agg(10, "status"), $2)');
    expect(() => mcvMaxFrequencyExpr(agg, "'a'")).toThrowError(TimescaleError);
  });
});

describe('heartbeat_agg builders', () => {
  it('heartbeatAggExpr quotes the time column + casts the bound config args', () => {
    expect(heartbeatAggExpr('ts', ':__hbStart', ':__hbDuration', ':__hbLiveness')).toBe(
      'heartbeat_agg("ts", :__hbStart::timestamptz, :__hbDuration::interval, :__hbLiveness::interval)',
    );
    // positional bind tokens are also accepted
    expect(heartbeatAggExpr('ts', '$1', '$2', '$3')).toBe(
      'heartbeat_agg("ts", $1::timestamptz, $2::interval, $3::interval)',
    );
  });
  it('heartbeatAggExpr rejects unsafe columns and raw (non-placeholder) config values', () => {
    expect(() => heartbeatAggExpr('ts);--', ':a', ':b', ':c')).toThrowError(TimescaleError);
    expect(() => heartbeatAggExpr('ts', "'2024-01-01'", ':b', ':c')).toThrowError(TimescaleError);
    expect(() => heartbeatAggExpr('ts', ':a', "'5 min'", ':c')).toThrowError(TimescaleError);
  });
  it('scalar accessors are allow-listed', () => {
    const agg = heartbeatAggExpr('ts', '$1', '$2', '$3');
    expect(heartbeatAccessorExpr('uptime', agg)).toBe(
      'uptime(heartbeat_agg("ts", $1::timestamptz, $2::interval, $3::interval))',
    );
    expect(heartbeatAccessorExpr('num_gaps', agg)).toContain('num_gaps(heartbeat_agg(');
    // @ts-expect-error — not in the union
    expect(() => heartbeatAccessorExpr('mtbf', agg)).toThrowError(TimescaleError);
  });
  it('live_at requires a bind token; range table-funcs wrap the agg', () => {
    const agg = heartbeatAggExpr('ts', '$1', '$2', '$3');
    expect(heartbeatLiveAtExpr(agg, '$4')).toContain('live_at(heartbeat_agg(');
    expect(heartbeatLiveAtExpr(agg, '$4')).toMatch(/, \$4\)$/);
    expect(() => heartbeatLiveAtExpr(agg, 'now()')).toThrowError(TimescaleError);
    expect(heartbeatLiveRangesExpr(agg)).toContain('live_ranges(heartbeat_agg(');
    expect(heartbeatDeadRangesExpr(agg)).toContain('dead_ranges(heartbeat_agg(');
  });
});

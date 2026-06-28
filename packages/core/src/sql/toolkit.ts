import { safeIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { TimescaleError, TimescaleErrorCode } from '../errors.js';

/**
 * Pure SQL expression builders for `timescaledb_toolkit` hyperfunctions.
 *
 * These require the **`timescaledb_toolkit`** extension (NOT base TimescaleDB) — the
 * runtime layer detects its presence and throws `TSDB_TOOLKIT_MISSING` before using
 * them. Like the base builders, each returns a SQL fragment with every column run
 * through {@link safeIdent}; they never execute.
 *
 * Two-step aggregate pattern: an aggregate (`candlestick_agg`, `approx_count_distinct`)
 * builds an intermediate, then an accessor (`open`, `distinct_count`, …) extracts a
 * scalar. The aggregate fragment is composed inside the accessor in one grouped SELECT.
 */

/** Catalog query: number of rows is the toolkit-installed flag (0 = missing). */
export const TOOLKIT_PRESENCE_SQL =
  "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb_toolkit'";

/** `candlestick_agg(time, price, volume)` — the OHLCV intermediate aggregate. */
export function candlestickAggExpr(
  timeColumn: string,
  priceColumn: string,
  volumeColumn: string,
): string {
  return `candlestick_agg(${safeIdent(timeColumn, 'candlestick time column')}, ${safeIdent(
    priceColumn,
    'candlestick price column',
  )}, ${safeIdent(volumeColumn, 'candlestick volume column')})`;
}

/** The candlestick accessors (scalar functions over a `candlestick_agg` intermediate). */
export type CandlestickAccessor =
  | 'open'
  | 'high'
  | 'low'
  | 'close'
  | 'volume'
  | 'vwap'
  | 'open_time'
  | 'high_time'
  | 'low_time'
  | 'close_time';

const CANDLESTICK_ACCESSORS: ReadonlySet<string> = new Set([
  'open',
  'high',
  'low',
  'close',
  'volume',
  'vwap',
  'open_time',
  'high_time',
  'low_time',
  'close_time',
]);

/**
 * Wrap a candlestick aggregate fragment in an accessor, e.g.
 * `open(candlestick_agg("t","p","v"))`. The accessor name is allow-listed; the
 * aggregate fragment must already be safe (built via {@link candlestickAggExpr}).
 */
export function candlestickAccessorExpr(accessor: CandlestickAccessor, aggExpr: string): string {
  if (!CANDLESTICK_ACCESSORS.has(accessor)) {
    // Defensive: TS already constrains the union, but guard the SQL boundary too.
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown candlestick accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  return `${accessor}(${aggExpr})`;
}

/** `approx_count_distinct(value)` — the HyperLogLog intermediate (NOT a scalar count). */
export function approxCountDistinctAggExpr(column: string): string {
  return `approx_count_distinct(${safeIdent(column, 'approx_count_distinct column')})`;
}

/**
 * `distinct_count(<hyperloglog>)` — the accessor that turns an
 * {@link approxCountDistinctAggExpr} intermediate into a `bigint` estimate.
 * `aggExpr` must already be safe.
 */
export function distinctCountExpr(aggExpr: string): string {
  return `distinct_count(${aggExpr})`;
}

// ---------------------------------------------------------------------------
// stats_agg — statistical summaries (1D moments + 2D linear regression)
// ---------------------------------------------------------------------------

/**
 * Sampling method for the moment accessors (`stddev`/`variance`/`skewness`/
 * `kurtosis`/`covariance`). `'sample'` uses Bessel's correction (n−1), `'population'`
 * divides by n. Matches the toolkit accessor's `method` argument; defaults to
 * `'sample'` (the toolkit default).
 */
export type StatsMethod = 'sample' | 'population';

const STATS_METHODS: ReadonlySet<string> = new Set(['sample', 'population']);

/** Render the allow-listed `method` text argument (e.g. `'sample'`) for a moment accessor. */
function statsMethodArg(method: StatsMethod = 'sample'): string {
  if (!STATS_METHODS.has(method)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown stats method: ${JSON.stringify(method)} (expected 'sample' or 'population')`,
      { method: String(method) },
    );
  }
  return quoteLiteral(method, 'stats method');
}

/** `stats_agg(value)` — the 1-dimensional statistical summary intermediate. */
export function statsAgg1DExpr(valueColumn: string): string {
  return `stats_agg(${safeIdent(valueColumn, 'stats_agg value column')})`;
}

/**
 * `stats_agg(y, x)` — the 2-dimensional summary intermediate for linear regression.
 *
 * **Argument order is `(Y, X)`** — Y is the dependent variable, X the independent one,
 * matching the toolkit signature. `slope` is therefore dY/dX.
 */
export function statsAgg2DExpr(yColumn: string, xColumn: string): string {
  return `stats_agg(${safeIdent(yColumn, 'stats_agg Y column')}, ${safeIdent(
    xColumn,
    'stats_agg X column',
  )})`;
}

/** 1D `stats_agg` accessors. The moment accessors take a {@link StatsMethod}. */
export type Stats1DAccessor =
  | 'average'
  | 'sum'
  | 'stddev'
  | 'variance'
  | 'skewness'
  | 'kurtosis'
  | 'num_vals';

const STATS_1D_ACCESSORS: ReadonlySet<string> = new Set([
  'average',
  'sum',
  'stddev',
  'variance',
  'skewness',
  'kurtosis',
  'num_vals',
]);

/** Accessors whose signature includes the `method` argument. */
const STATS_1D_METHOD_ACCESSORS: ReadonlySet<string> = new Set([
  'stddev',
  'variance',
  'skewness',
  'kurtosis',
]);

/**
 * Wrap a 1D `stats_agg` intermediate in a scalar accessor, e.g.
 * `stddev(stats_agg("v"), 'sample')`. The accessor is allow-listed; `aggExpr` must
 * already be safe (built via {@link statsAgg1DExpr}). `method` is only emitted for the
 * moment accessors (`stddev`/`variance`/`skewness`/`kurtosis`).
 */
export function statsAccessor1DExpr(
  accessor: Stats1DAccessor,
  aggExpr: string,
  method?: StatsMethod,
): string {
  if (!STATS_1D_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown stats_agg 1D accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  if (STATS_1D_METHOD_ACCESSORS.has(accessor)) {
    return `${accessor}(${aggExpr}, ${statsMethodArg(method)})`;
  }
  return `${accessor}(${aggExpr})`;
}

/** 2D `stats_agg` accessors (regression + per-axis moments). */
export type Stats2DAccessor =
  | 'slope'
  | 'intercept'
  | 'x_intercept'
  | 'corr'
  | 'covariance'
  | 'determination_coeff'
  | 'num_vals'
  | 'average_x'
  | 'average_y'
  | 'sum_x'
  | 'sum_y'
  | 'stddev_x'
  | 'stddev_y'
  | 'variance_x'
  | 'variance_y'
  | 'skewness_x'
  | 'skewness_y'
  | 'kurtosis_x'
  | 'kurtosis_y';

const STATS_2D_ACCESSORS: ReadonlySet<string> = new Set([
  'slope',
  'intercept',
  'x_intercept',
  'corr',
  'covariance',
  'determination_coeff',
  'num_vals',
  'average_x',
  'average_y',
  'sum_x',
  'sum_y',
  'stddev_x',
  'stddev_y',
  'variance_x',
  'variance_y',
  'skewness_x',
  'skewness_y',
  'kurtosis_x',
  'kurtosis_y',
]);

/** 2D accessors whose signature includes the `method` argument. */
const STATS_2D_METHOD_ACCESSORS: ReadonlySet<string> = new Set([
  'covariance',
  'stddev_x',
  'stddev_y',
  'variance_x',
  'variance_y',
  'skewness_x',
  'skewness_y',
  'kurtosis_x',
  'kurtosis_y',
]);

/**
 * Wrap a 2D `stats_agg` intermediate in a scalar accessor, e.g.
 * `slope(stats_agg("y","x"))` or `covariance(stats_agg("y","x"), 'population')`.
 * The accessor is allow-listed; `aggExpr` must already be safe (built via
 * {@link statsAgg2DExpr}). `method` is only emitted for the moment/covariance accessors.
 */
export function statsAccessor2DExpr(
  accessor: Stats2DAccessor,
  aggExpr: string,
  method?: StatsMethod,
): string {
  if (!STATS_2D_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown stats_agg 2D accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  if (STATS_2D_METHOD_ACCESSORS.has(accessor)) {
    return `${accessor}(${aggExpr}, ${statsMethodArg(method)})`;
  }
  return `${accessor}(${aggExpr})`;
}

// ---------------------------------------------------------------------------
// percentile_agg — approximate percentiles (uddsketch)
// ---------------------------------------------------------------------------

/**
 * Validate and render a finite number as a SQL numeric literal. A finite JS number's
 * decimal/exponent string form is always a valid PostgreSQL numeric literal and
 * carries zero injection surface (it is a number, never user text).
 */
function numericLiteral(value: number, role: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a finite number`,
      {
        role,
        value: String(value),
      },
    );
  }
  return String(value);
}

/** `percentile_agg(value)` — the uddsketch percentile intermediate. */
export function percentileAggExpr(valueColumn: string): string {
  return `percentile_agg(${safeIdent(valueColumn, 'percentile_agg value column')})`;
}

/**
 * `approx_percentile(p, <sketch>)` — estimate the value at percentile `p` (0..1).
 * `aggExpr` must already be safe (built via {@link percentileAggExpr}).
 */
export function approxPercentileExpr(percentile: number, aggExpr: string): string {
  if (
    typeof percentile !== 'number' ||
    !Number.isFinite(percentile) ||
    percentile < 0 ||
    percentile > 1
  ) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `percentile must be a number in [0, 1], got ${String(percentile)}`,
      { percentile: String(percentile) },
    );
  }
  return `approx_percentile(${numericLiteral(percentile, 'percentile')}, ${aggExpr})`;
}

/**
 * `approx_percentile_rank(value, <sketch>)` — estimate the percentile rank (0..1) of
 * `value`. `aggExpr` must already be safe (built via {@link percentileAggExpr}).
 */
export function approxPercentileRankExpr(value: number, aggExpr: string): string {
  return `approx_percentile_rank(${numericLiteral(value, 'percentile rank value')}, ${aggExpr})`;
}

/** Scalar accessors over a `percentile_agg` sketch. */
export type PercentileSketchAccessor = 'mean' | 'error' | 'num_vals';

const PERCENTILE_SKETCH_ACCESSORS: ReadonlySet<string> = new Set(['mean', 'error', 'num_vals']);

/**
 * Wrap a `percentile_agg` sketch in a scalar accessor (`mean`/`error`/`num_vals`),
 * e.g. `mean(percentile_agg("v"))`. The accessor is allow-listed; `aggExpr` must
 * already be safe.
 */
export function percentileSketchAccessorExpr(
  accessor: PercentileSketchAccessor,
  aggExpr: string,
): string {
  if (!PERCENTILE_SKETCH_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown percentile sketch accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  return `${accessor}(${aggExpr})`;
}

// ---------------------------------------------------------------------------
// counter_agg — monotonic counters that may reset (delta / rate / …)
// ---------------------------------------------------------------------------

/**
 * `counter_agg(ts, value)` — the counter summary intermediate for a monotonically
 * increasing counter that may reset to zero (e.g. a request counter). The summary
 * accounts for resets so `delta`/`rate` reflect the true total increase.
 */
export function counterAggExpr(timeColumn: string, valueColumn: string): string {
  return `counter_agg(${safeIdent(timeColumn, 'counter_agg time column')}, ${safeIdent(
    valueColumn,
    'counter_agg value column',
  )})`;
}

/** Scalar accessors over a `counter_agg` summary. */
export type CounterAccessor =
  | 'delta'
  | 'rate'
  | 'irate_left'
  | 'irate_right'
  | 'slope'
  | 'intercept'
  | 'corr'
  | 'time_delta'
  | 'first_val'
  | 'last_val'
  | 'idelta_left'
  | 'idelta_right'
  | 'num_resets'
  | 'num_changes'
  | 'num_elements'
  | 'first_time'
  | 'last_time'
  | 'counter_zero_time';

const COUNTER_ACCESSORS: ReadonlySet<string> = new Set([
  'delta',
  'rate',
  'irate_left',
  'irate_right',
  'slope',
  'intercept',
  'corr',
  'time_delta',
  'first_val',
  'last_val',
  'idelta_left',
  'idelta_right',
  'num_resets',
  'num_changes',
  'num_elements',
  'first_time',
  'last_time',
  'counter_zero_time',
]);

/**
 * Wrap a `counter_agg` summary in an allow-listed scalar accessor, e.g.
 * `rate(counter_agg("ts","v"))`. `aggExpr` must already be safe (built via
 * {@link counterAggExpr}). Note `extrapolated_delta`/`extrapolated_rate` are NOT here:
 * they require the bounded `counter_agg(ts, value, bounds)` form and a method argument.
 */
export function counterAccessorExpr(accessor: CounterAccessor, aggExpr: string): string {
  if (!COUNTER_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown counter_agg accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  return `${accessor}(${aggExpr})`;
}

// ---------------------------------------------------------------------------
// time_weight — time-weighted average (LOCF / linear)
// ---------------------------------------------------------------------------

/**
 * Weighting method for {@link timeWeightAggExpr}. `'Linear'` interpolates linearly
 * between points; `'LOCF'` carries each value forward until the next point. Matches
 * the toolkit's `time_weight(method, …)` first argument.
 */
export type TimeWeightMethod = 'Linear' | 'LOCF';

const TIME_WEIGHT_METHODS: ReadonlySet<string> = new Set(['Linear', 'LOCF']);

/** Render the allow-listed weighting-method literal (e.g. `'Linear'`). */
function timeWeightMethodArg(method: TimeWeightMethod): string {
  if (!TIME_WEIGHT_METHODS.has(method)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown time_weight method: ${JSON.stringify(method)} (expected 'Linear' or 'LOCF')`,
      { method: String(method) },
    );
  }
  return quoteLiteral(method, 'time_weight method');
}

/** `time_weight(method, ts, value)` — the time-weighted summary intermediate. */
export function timeWeightAggExpr(
  method: TimeWeightMethod,
  timeColumn: string,
  valueColumn: string,
): string {
  return `time_weight(${timeWeightMethodArg(method)}, ${safeIdent(
    timeColumn,
    'time_weight time column',
  )}, ${safeIdent(valueColumn, 'time_weight value column')})`;
}

/** Scalar accessors over a `time_weight` summary (excluding `integral`, which takes a unit). */
export type TimeWeightAccessor = 'average' | 'first_val' | 'last_val' | 'first_time' | 'last_time';

const TIME_WEIGHT_ACCESSORS: ReadonlySet<string> = new Set([
  'average',
  'first_val',
  'last_val',
  'first_time',
  'last_time',
]);

/**
 * Wrap a `time_weight` summary in an allow-listed scalar accessor, e.g.
 * `average(time_weight('Linear',"ts","v"))`. `aggExpr` must already be safe.
 */
export function timeWeightAccessorExpr(accessor: TimeWeightAccessor, aggExpr: string): string {
  if (!TIME_WEIGHT_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown time_weight accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  return `${accessor}(${aggExpr})`;
}

/** Allowed `integral` time units (the denominator of the integral). */
export type IntegralUnit =
  | 'microsecond'
  | 'millisecond'
  | 'second'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week';

const INTEGRAL_UNITS: ReadonlySet<string> = new Set([
  'microsecond',
  'millisecond',
  'second',
  'minute',
  'hour',
  'day',
  'week',
]);

/**
 * `integral(<summary>, unit)` — the time-weighted integral (area under the curve) in
 * the given `unit` (default `'second'`). `aggExpr` must already be safe (built via
 * {@link timeWeightAggExpr}).
 */
export function timeWeightIntegralExpr(aggExpr: string, unit: IntegralUnit = 'second'): string {
  if (!INTEGRAL_UNITS.has(unit)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown integral unit: ${JSON.stringify(unit)}`,
      { unit: String(unit) },
    );
  }
  return `integral(${aggExpr}, ${quoteLiteral(unit, 'integral unit')})`;
}

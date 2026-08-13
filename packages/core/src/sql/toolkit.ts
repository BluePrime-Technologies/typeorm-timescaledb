import { assertSafeFragment, safeIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { numericLiteral } from './numeric.js';
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
  assertSafeFragment(aggExpr, 'aggExpr');
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
  'average' | 'sum' | 'stddev' | 'variance' | 'skewness' | 'kurtosis' | 'num_vals';

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
// numericLiteral is shared with the base hyperfunction builders — see ./numeric.ts.

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
// tdigest — approximate percentiles (T-Digest sketch)
// ---------------------------------------------------------------------------

/**
 * `tdigest(<buckets>, value)` — the T-Digest percentile intermediate. `bucketsToken`
 * binds the sketch size (accuracy/compression) as a parameter (`$N` or `:name`). The
 * `approx_percentile` / `approx_percentile_rank` accessors are shared with the uddsketch
 * builders ({@link approxPercentileExpr} / {@link approxPercentileRankExpr}).
 */
export function tdigestExpr(valueColumn: string, bucketsToken: string): string {
  return `tdigest(${assertBindToken(bucketsToken, 'buckets')}, ${safeIdent(valueColumn, 'tdigest value column')})`;
}

/** Scalar accessors over a `tdigest` sketch. */
export type TDigestAccessor = 'mean' | 'min_val' | 'max_val' | 'num_vals';

const TDIGEST_ACCESSORS: ReadonlySet<string> = new Set(['mean', 'min_val', 'max_val', 'num_vals']);

/**
 * Wrap a `tdigest` sketch in a scalar accessor (`mean`/`min_val`/`max_val`/`num_vals`),
 * e.g. `mean(tdigest(100,"v"))`. The accessor is allow-listed; `aggExpr` must already be safe.
 */
export function tdigestAccessorExpr(accessor: TDigestAccessor, aggExpr: string): string {
  if (!TDIGEST_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown tdigest accessor: ${JSON.stringify(accessor)}`,
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
  'microsecond' | 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week';

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

// ---------------------------------------------------------------------------
// state_agg — categorical state over time (durations / timeline) — TEXT states
// ---------------------------------------------------------------------------

/**
 * A positional parameter placeholder (`$1`, `$2`, …). The set/scalar `state_agg`
 * accessors take runtime values (a probe timestamp, a state name) that MUST be bound
 * as parameters — never inlined. This guards the builder boundary so a caller can't
 * pass raw text where a placeholder is required.
 */
function assertParamPlaceholder(token: string, role: string): string {
  // PostgreSQL positional parameters are 1-based with no leading zero ($1, $2, …).
  if (!/^\$[1-9]\d*$/.test(token)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a positional parameter placeholder like "$1", got ${JSON.stringify(token)}`,
      { role, token: String(token) },
    );
  }
  return token;
}

/** `state_agg(ts, value)` — the categorical-state summary intermediate (text states). */
export function stateAggExpr(timeColumn: string, valueColumn: string): string {
  return `state_agg(${safeIdent(timeColumn, 'state_agg time column')}, ${safeIdent(
    valueColumn,
    'state_agg value column',
  )})`;
}

/**
 * `into_values(<agg>)` — table function returning `(state text, duration interval)`,
 * one row per distinct state. Used in a FROM-clause lateral, not a scalar SELECT.
 * `aggExpr` must already be safe (built via {@link stateAggExpr}).
 */
export function stateIntoValuesExpr(aggExpr: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `into_values(${aggExpr})`;
}

/** `state_timeline(<agg>)` — table function returning `(state, start_time, end_time)`. */
export function stateTimelineExpr(aggExpr: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `state_timeline(${aggExpr})`;
}

/**
 * `state_periods(<agg>, <state>)` — table function returning `(start_time, end_time)`
 * for one state. `stateToken` must be a positional parameter placeholder (`$N`).
 */
export function statePeriodsExpr(aggExpr: string, stateToken: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `state_periods(${aggExpr}, ${assertParamPlaceholder(stateToken, 'state')})`;
}

/**
 * `state_at(<agg>, <point>)` — scalar: the state in effect at `point`. `pointToken`
 * must be a positional parameter placeholder (`$N`). `aggExpr` must already be safe.
 */
export function stateAtExpr(aggExpr: string, pointToken: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `state_at(${aggExpr}, ${assertParamPlaceholder(pointToken, 'point')})`;
}

// ---------------------------------------------------------------------------
// mcv_agg — most-common-values / top-N (Space-Saving) — TEXT values
// ---------------------------------------------------------------------------

/** Largest PostgreSQL `int4` (the type `mcv_agg` count / `topn` n accept). */
const INT4_MAX = 2147483647;

/**
 * Validate and render a positive `int4` (a config count, never user text) as a literal.
 * Requires a SAFE integer in `[1, INT4_MAX]` — this rules out values like `1e21` whose
 * `String()` form would be scientific notation rather than an exact decimal literal, so
 * the emitted token is always a provably-safe plain integer.
 */
function positiveIntLiteral(value: number, role: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > INT4_MAX) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a positive integer in [1, ${INT4_MAX}], got ${String(value)}`,
      { role, value: String(value) },
    );
  }
  return String(value);
}

/**
 * `mcv_agg(count, value)` — the most-common-values intermediate, tracking the top
 * `count` values approximately (Space-Saving). `count` is a validated positive integer.
 */
export function mcvAggExpr(count: number, valueColumn: string): string {
  return `mcv_agg(${positiveIntLiteral(count, 'mcv count')}, ${safeIdent(
    valueColumn,
    'mcv_agg value column',
  )})`;
}

/**
 * `into_values(<agg>)` — table function returning `(value, min_freq, max_freq)`, one row
 * per tracked value (frequency-descending). Used in a FROM-clause lateral. `aggExpr`
 * must already be safe (built via {@link mcvAggExpr}).
 */
export function mcvIntoValuesExpr(aggExpr: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `into_values(${aggExpr})`;
}

/** `topn(<agg>, <n>)` — set-returning: the top `n` values (frequency-descending). */
export function mcvTopNExpr(aggExpr: string, n: number): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `topn(${aggExpr}, ${positiveIntLiteral(n, 'topn n')})`;
}

/**
 * `max_frequency(<agg>, <value>)` — scalar upper bound on a value's frequency.
 * `valueToken` must be a positional parameter placeholder (`$N`).
 */
export function mcvMaxFrequencyExpr(aggExpr: string, valueToken: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `max_frequency(${aggExpr}, ${assertParamPlaceholder(valueToken, 'value')})`;
}

/**
 * `min_frequency(<agg>, <value>)` — scalar lower bound on a value's frequency.
 * `valueToken` must be a positional parameter placeholder (`$N`).
 */
export function mcvMinFrequencyExpr(aggExpr: string, valueToken: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `min_frequency(${aggExpr}, ${assertParamPlaceholder(valueToken, 'value')})`;
}

// ---------------------------------------------------------------------------
// heartbeat_agg — liveness / uptime over a window
// ---------------------------------------------------------------------------

/**
 * A bind token: either a positional placeholder (`$1`) or a TypeORM named placeholder
 * (`:name`). `heartbeat_agg`'s window config (start/duration/liveness) binds inside the
 * inner query via TypeORM named parameters, so those tokens are `:name`; the outer
 * `live_at` probe binds positionally. Guards the boundary either way — never raw values.
 */
function assertBindToken(token: string, role: string): string {
  if (!/^\$[1-9]\d*$/.test(token) && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a parameter placeholder ("$1" or ":name"), got ${JSON.stringify(token)}`,
      { role, token: String(token) },
    );
  }
  return token;
}

/**
 * `heartbeat_agg(heartbeat, agg_start, agg_duration, heartbeat_liveness)` — the liveness
 * summary over the window `[agg_start, agg_start + agg_duration)`, where each heartbeat
 * keeps the system live for `heartbeat_liveness`. The three config args are bind tokens
 * (bound + cast to `timestamptz`/`interval`); `aggExpr` consumers must already be safe.
 */
export function heartbeatAggExpr(
  timeColumn: string,
  startToken: string,
  durationToken: string,
  livenessToken: string,
): string {
  return `heartbeat_agg(${safeIdent(timeColumn, 'heartbeat_agg time column')}, ${assertBindToken(
    startToken,
    'agg_start',
  )}::timestamptz, ${assertBindToken(durationToken, 'agg_duration')}::interval, ${assertBindToken(
    livenessToken,
    'heartbeat_liveness',
  )}::interval)`;
}

/** Scalar `heartbeat_agg` accessors. `uptime`/`downtime` return an interval; the others a bigint. */
export type HeartbeatAccessor = 'uptime' | 'downtime' | 'num_gaps' | 'num_live_ranges';

const HEARTBEAT_ACCESSORS: ReadonlySet<string> = new Set([
  'uptime',
  'downtime',
  'num_gaps',
  'num_live_ranges',
]);

/** Wrap a `heartbeat_agg` summary in an allow-listed scalar accessor. `aggExpr` must be safe. */
export function heartbeatAccessorExpr(accessor: HeartbeatAccessor, aggExpr: string): string {
  if (!HEARTBEAT_ACCESSORS.has(accessor)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unknown heartbeat_agg accessor: ${JSON.stringify(accessor)}`,
      { accessor: String(accessor) },
    );
  }
  return `${accessor}(${aggExpr})`;
}

/** `live_at(<agg>, <point>)` — boolean: was the system live at `point`. `pointToken` is a bind token. */
export function heartbeatLiveAtExpr(aggExpr: string, pointToken: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `live_at(${aggExpr}, ${assertBindToken(pointToken, 'point')})`;
}

/** `live_ranges(<agg>)` — table function returning the live `(start, end)` intervals. */
export function heartbeatLiveRangesExpr(aggExpr: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `live_ranges(${aggExpr})`;
}

/** `dead_ranges(<agg>)` — table function returning the dead `(start, end)` intervals. */
export function heartbeatDeadRangesExpr(aggExpr: string): string {
  assertSafeFragment(aggExpr, 'aggExpr');
  return `dead_ranges(${aggExpr})`;
}

// ---------------------------------------------------------------------------
// Downsampling — LTTB (Largest-Triangle-Three-Buckets) + ASAP smoothing
// ---------------------------------------------------------------------------

/**
 * `lttb(time, value, resolution)` — the Largest-Triangle-Three-Buckets downsample
 * intermediate (a timevector). `resolutionToken` binds the target point count as a
 * parameter (`$1` or `:name`); the caller `unnest(...)`s the result into `(time, value)`
 * rows. Requires `timescaledb_toolkit`.
 */
export function lttbExpr(timeColumn: string, valueColumn: string, resolutionToken: string): string {
  return `lttb(${safeIdent(timeColumn, 'lttb time column')}, ${safeIdent(
    valueColumn,
    'lttb value column',
  )}, ${assertBindToken(resolutionToken, 'resolution')})`;
}

/**
 * `asap_smooth(time, value, resolution)` — the ASAP-smoothing downsample intermediate
 * (a timevector). `resolutionToken` binds the target point count as a parameter. The
 * caller `unnest(...)`s the result into `(time, value)` rows. Requires `timescaledb_toolkit`.
 */
export function asapSmoothExpr(
  timeColumn: string,
  valueColumn: string,
  resolutionToken: string,
): string {
  return `asap_smooth(${safeIdent(timeColumn, 'asap_smooth time column')}, ${safeIdent(
    valueColumn,
    'asap_smooth value column',
  )}, ${assertBindToken(resolutionToken, 'resolution')})`;
}

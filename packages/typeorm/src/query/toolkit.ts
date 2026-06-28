import type { DataSource, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import {
  approxCountDistinctAggExpr,
  approxPercentileExpr,
  approxPercentileRankExpr,
  candlestickAccessorExpr,
  candlestickAggExpr,
  counterAccessorExpr,
  counterAggExpr,
  distinctCountExpr,
  heartbeatAccessorExpr,
  heartbeatAggExpr,
  heartbeatDeadRangesExpr,
  heartbeatLiveAtExpr,
  heartbeatLiveRangesExpr,
  mcvAggExpr,
  mcvIntoValuesExpr,
  mcvTopNExpr,
  percentileAggExpr,
  percentileSketchAccessorExpr,
  safeIdent,
  stateAggExpr,
  stateAtExpr,
  stateIntoValuesExpr,
  statePeriodsExpr,
  stateTimelineExpr,
  statsAccessor1DExpr,
  statsAccessor2DExpr,
  statsAgg1DExpr,
  statsAgg2DExpr,
  timeBucketExpr,
  timeWeightAccessorExpr,
  timeWeightAggExpr,
  timeWeightIntegralExpr,
  TOOLKIT_PRESENCE_SQL,
  TimescaleError,
  TimescaleErrorCode,
  type IntegralUnit,
  type StatsMethod,
  type TimeWeightMethod,
} from '@blueprime/timescaledb-core';
import { toDate, toNumber, toNumberOrNull, toBigIntString } from './result-mapper.js';

/** Inclusive-from / exclusive-to time bounds; bound as query parameters when applied. */
export interface TimeRange {
  readonly from?: Date | string;
  readonly to?: Date | string;
}

/**
 * Resolve entity property names to DB column names for a repository. Used for every
 * column that reaches SQL — including the **default time column**, which is the entity
 * PROPERTY name (recorded by `@TimeColumn`) and differs from the DB column when mapped
 * via `@Column({ name })`. The lookup is a no-op for a value that is already a DB column
 * name (no matching property → returned unchanged), so it is safe to apply unconditionally.
 */
function columnResolver<T extends ObjectLiteral>(
  repo: Repository<T>,
): (property: string) => string {
  return (property) => repo.metadata.findColumnWithPropertyName(property)?.databaseName ?? property;
}

/** Apply optional `[from, to)` bounds on the time column to a query builder (params-bound). */
function applyTimeRange<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  timeColumn: string,
  range?: TimeRange,
): void {
  if (range?.from !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} >= :__tsFrom`, { __tsFrom: range.from });
  }
  if (range?.to !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} < :__tsTo`, { __tsTo: range.to });
  }
}

/**
 * `timescaledb_toolkit`-backed query helpers (candlesticks, approx_count_distinct).
 *
 * Every entry point runs a cached toolkit-presence check first and throws the stable
 * `TSDB_TOOLKIT_MISSING` error if the extension is absent — so consumers get a clear,
 * documented failure instead of a raw `function ... does not exist` from PostgreSQL.
 */

// Cache the presence check per DataSource: a present OR a deterministically-absent
// toolkit is a stable fact, so resolve/reject it once. Only a TRANSIENT query failure
// (connection blip) is evicted so it can be retried.
const toolkitChecked = new WeakMap<DataSource, Promise<void>>();

/** Resolve once per DataSource; throws `TSDB_TOOLKIT_MISSING` when the extension is absent. */
export function assertToolkit(dataSource: DataSource): Promise<void> {
  let pending = toolkitChecked.get(dataSource);
  if (!pending) {
    pending = dataSource.query(TOOLKIT_PRESENCE_SQL).then((rows: unknown) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new TimescaleError(
          TimescaleErrorCode.TOOLKIT_MISSING,
          'timescaledb_toolkit is not installed on this database — run `CREATE EXTENSION timescaledb_toolkit;` (or use an image that bundles it) to use candlesticks, approx_count_distinct, statistics, regression, or percentile aggregates',
          {},
        );
      }
    });
    // Keep the deterministic "missing" verdict cached; evict only a transient failure
    // (e.g. a dropped connection) so the next call re-checks rather than re-throwing it.
    pending.catch((err: unknown) => {
      const deterministic =
        err instanceof TimescaleError && err.code === TimescaleErrorCode.TOOLKIT_MISSING;
      if (!deterministic) {
        toolkitChecked.delete(dataSource);
      }
    });
    toolkitChecked.set(dataSource, pending);
  }
  return pending;
}

/** One OHLCV candle. `bucket` is the bucket start; numeric fields are coerced from the toolkit accessors. */
export interface Candle {
  readonly bucket: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** Volume-weighted average price; `null` when the bucket's total volume is 0. */
  readonly vwap: number | null;
}

export interface GetCandlesticksOptions {
  /** Bucket width, e.g. `'1 day'`. */
  readonly interval: string;
  /** Price **property** name. */
  readonly priceColumn: string;
  /** Volume **property** name. */
  readonly volumeColumn: string;
  /** Time **property** name; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Order rows by bucket. Default `ASC`. */
  readonly order?: 'ASC' | 'DESC';
}

/**
 * Typed OHLCV candlesticks over a hypertable — the marquee finance feature.
 *
 * Builds `time_bucket(...)` + `candlestick_agg(time, price, volume)` with the OHLCV
 * accessors, grouped per bucket. Resolves entity property names to DB columns and
 * binds range bounds as parameters. Requires `timescaledb_toolkit`.
 */
export async function getCandlesticks<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetCandlesticksOptions,
): Promise<Candle[]> {
  await assertToolkit(repo.manager.connection);

  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const cs = candlestickAggExpr(
    timeColumn,
    resolve(options.priceColumn),
    resolve(options.volumeColumn),
  );
  const bucketExpr = timeBucketExpr({ interval: options.interval, column: timeColumn });

  // Compute candlestick_agg ONCE per bucket in an inner query, then apply the
  // accessors in the outer query — repeating the aggregate in each accessor would
  // make PostgreSQL evaluate it 6× per bucket. The inner builder handles the table,
  // WHERE, and parameter binding safely; we only wrap its SQL.
  const inner = repo.createQueryBuilder('e').select(bucketExpr, 'bucket').addSelect(cs, 'cs');
  applyTimeRange(inner, timeColumn, options.range);
  inner.groupBy(bucketExpr);
  const [innerSql, params] = inner.getQueryAndParameters();

  const order = options.order === 'DESC' ? 'DESC' : 'ASC';
  const outerSql =
    `SELECT q."bucket" AS "bucket", ${candlestickAccessorExpr('open', 'q."cs"')} AS "open", ` +
    `${candlestickAccessorExpr('high', 'q."cs"')} AS "high", ` +
    `${candlestickAccessorExpr('low', 'q."cs"')} AS "low", ` +
    `${candlestickAccessorExpr('close', 'q."cs"')} AS "close", ` +
    `${candlestickAccessorExpr('volume', 'q."cs"')} AS "volume", ` +
    `${candlestickAccessorExpr('vwap', 'q."cs"')} AS "vwap" ` +
    `FROM (${innerSql}) q ORDER BY q."bucket" ${order}`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    bucket: toDate(r.bucket, 'bucket'),
    open: toNumber(r.open, 'open'),
    high: toNumber(r.high, 'high'),
    low: toNumber(r.low, 'low'),
    close: toNumber(r.close, 'close'),
    volume: toNumber(r.volume, 'volume'),
    // vwap = Σ(price·vol)/Σ(vol) → NULL when a bucket's total volume is 0.
    vwap: toNumberOrNull(r.vwap, 'vwap'),
  }));
}

export interface ApproxCountDistinctOptions {
  /** Column **property** name to estimate distinct cardinality of. */
  readonly column: string;
  /** Inclusive-from / exclusive-to time bounds on the time column (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property** for `range`; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/**
 * Approximate distinct count via toolkit HyperLogLog:
 * `distinct_count(approx_count_distinct(col))`. Returned as a **string** to avoid
 * precision loss on very large cardinalities. Requires `timescaledb_toolkit`.
 */
export async function approxCountDistinct<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: ApproxCountDistinctOptions,
): Promise<string> {
  await assertToolkit(repo.manager.connection);

  const resolve = columnResolver(repo);
  const expr = distinctCountExpr(approxCountDistinctAggExpr(resolve(options.column)));
  const qb = repo.createQueryBuilder('e').select(expr, 'n');

  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  applyTimeRange(qb, timeColumn, options.range);

  const row = await qb.getRawOne<{ n: unknown }>();
  return toBigIntString(row?.n, 'approx_count_distinct');
}

// ---------------------------------------------------------------------------
// stats_agg — 1D statistical summary
// ---------------------------------------------------------------------------

export interface GetStatsOptions {
  /** Value **property** name to summarise. */
  readonly valueColumn: string;
  /** Sampling method for stddev/variance/skewness/kurtosis. Default `'sample'`. */
  readonly method?: StatsMethod;
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property** for `range`; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/**
 * A 1D statistical summary. `stddev`/`variance`/`skewness`/`kurtosis` are `null` when
 * there are too few values for the chosen method (e.g. a `sample` stddev needs n ≥ 2).
 */
export interface StatsSummary {
  readonly average: number;
  readonly sum: number;
  readonly stddev: number | null;
  readonly variance: number | null;
  readonly skewness: number | null;
  readonly kurtosis: number | null;
  readonly numVals: number;
}

/**
 * Typed 1D statistics over a hypertable via `stats_agg` — average, sum, and the
 * sample/population moments. The aggregate is computed once in an inner query, then
 * the accessors are applied in the outer query (no N× re-evaluation). Resolves
 * property names to columns and binds range bounds as parameters. Requires
 * `timescaledb_toolkit`. Returns `null` when the (filtered) set is empty.
 */
export async function getStats<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetStatsOptions,
): Promise<StatsSummary | null> {
  await assertToolkit(repo.manager.connection);

  const resolve = columnResolver(repo);
  const agg = statsAgg1DExpr(resolve(options.valueColumn));
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);

  const inner = repo.createQueryBuilder('e').select(agg, 's');
  applyTimeRange(inner, timeColumn, options.range);
  const [innerSql, params] = inner.getQueryAndParameters();

  const m = options.method;
  const outerSql =
    `SELECT ${statsAccessor1DExpr('average', 'q."s"')} AS "average", ` +
    `${statsAccessor1DExpr('sum', 'q."s"')} AS "sum", ` +
    `${statsAccessor1DExpr('stddev', 'q."s"', m)} AS "stddev", ` +
    `${statsAccessor1DExpr('variance', 'q."s"', m)} AS "variance", ` +
    `${statsAccessor1DExpr('skewness', 'q."s"', m)} AS "skewness", ` +
    `${statsAccessor1DExpr('kurtosis', 'q."s"', m)} AS "kurtosis", ` +
    `${statsAccessor1DExpr('num_vals', 'q."s"')} AS "num_vals" ` +
    `FROM (${innerSql}) q`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  // An empty input set makes stats_agg NULL → every accessor NULL → no summary.
  if (!row || row.num_vals === null || row.num_vals === undefined) {
    return null;
  }
  return {
    average: toNumber(row.average, 'average'),
    sum: toNumber(row.sum, 'sum'),
    stddev: toNumberOrNull(row.stddev, 'stddev'),
    variance: toNumberOrNull(row.variance, 'variance'),
    skewness: toNumberOrNull(row.skewness, 'skewness'),
    kurtosis: toNumberOrNull(row.kurtosis, 'kurtosis'),
    numVals: toNumber(row.num_vals, 'num_vals'),
  };
}

// ---------------------------------------------------------------------------
// stats_agg — 2D linear regression
// ---------------------------------------------------------------------------

export interface GetRegressionOptions {
  /** Dependent (Y) **property** name. */
  readonly yColumn: string;
  /** Independent (X) **property** name. */
  readonly xColumn: string;
  /** Sampling method for covariance/per-axis moments. Default `'sample'`. */
  readonly method?: StatsMethod;
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property** for `range`; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/**
 * A 2D linear-regression summary (Y on X). The regression fields are `null` when the
 * fit is undefined (e.g. fewer than 2 points, or zero variance in X).
 */
export interface Regression {
  /** dY/dX. */
  readonly slope: number | null;
  /** Y-intercept. */
  readonly intercept: number | null;
  /** X-intercept (where the fitted line crosses Y = 0). */
  readonly xIntercept: number | null;
  /** Pearson correlation coefficient. */
  readonly corr: number | null;
  readonly covariance: number | null;
  /** Coefficient of determination (R²). */
  readonly determinationCoeff: number | null;
  readonly averageX: number;
  readonly averageY: number;
  readonly sumX: number;
  readonly sumY: number;
  readonly numVals: number;
}

/**
 * Typed 2D linear regression over a hypertable via `stats_agg(y, x)` — slope,
 * intercept, correlation, R², and the per-axis means/sums. Same inner/outer
 * single-evaluation pattern as {@link getStats}. Requires `timescaledb_toolkit`.
 * Returns `null` when the (filtered) set is empty.
 */
export async function getRegression<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetRegressionOptions,
): Promise<Regression | null> {
  await assertToolkit(repo.manager.connection);

  const resolve = columnResolver(repo);
  const agg = statsAgg2DExpr(resolve(options.yColumn), resolve(options.xColumn));
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);

  const inner = repo.createQueryBuilder('e').select(agg, 's');
  applyTimeRange(inner, timeColumn, options.range);
  const [innerSql, params] = inner.getQueryAndParameters();

  const m = options.method;
  const outerSql =
    `SELECT ${statsAccessor2DExpr('slope', 'q."s"')} AS "slope", ` +
    `${statsAccessor2DExpr('intercept', 'q."s"')} AS "intercept", ` +
    `${statsAccessor2DExpr('x_intercept', 'q."s"')} AS "x_intercept", ` +
    `${statsAccessor2DExpr('corr', 'q."s"')} AS "corr", ` +
    `${statsAccessor2DExpr('covariance', 'q."s"', m)} AS "covariance", ` +
    `${statsAccessor2DExpr('determination_coeff', 'q."s"')} AS "determination_coeff", ` +
    `${statsAccessor2DExpr('average_x', 'q."s"')} AS "average_x", ` +
    `${statsAccessor2DExpr('average_y', 'q."s"')} AS "average_y", ` +
    `${statsAccessor2DExpr('sum_x', 'q."s"')} AS "sum_x", ` +
    `${statsAccessor2DExpr('sum_y', 'q."s"')} AS "sum_y", ` +
    `${statsAccessor2DExpr('num_vals', 'q."s"')} AS "num_vals" ` +
    `FROM (${innerSql}) q`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || row.num_vals === null || row.num_vals === undefined) {
    return null;
  }
  return {
    slope: toNumberOrNull(row.slope, 'slope'),
    intercept: toNumberOrNull(row.intercept, 'intercept'),
    xIntercept: toNumberOrNull(row.x_intercept, 'x_intercept'),
    corr: toNumberOrNull(row.corr, 'corr'),
    covariance: toNumberOrNull(row.covariance, 'covariance'),
    determinationCoeff: toNumberOrNull(row.determination_coeff, 'determination_coeff'),
    averageX: toNumber(row.average_x, 'average_x'),
    averageY: toNumber(row.average_y, 'average_y'),
    sumX: toNumber(row.sum_x, 'sum_x'),
    sumY: toNumber(row.sum_y, 'sum_y'),
    numVals: toNumber(row.num_vals, 'num_vals'),
  };
}

// ---------------------------------------------------------------------------
// percentile_agg — approximate percentiles (uddsketch)
// ---------------------------------------------------------------------------

export interface GetPercentilesOptions {
  /** Value **property** name to estimate percentiles of. */
  readonly valueColumn: string;
  /** Percentiles in `[0, 1]` (e.g. `[0.5, 0.95, 0.99]`); must be non-empty. */
  readonly percentiles: readonly number[];
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property** for `range`; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

export interface PercentileResult {
  /** `approx_percentile` values, aligned to the requested `percentiles`. */
  readonly percentiles: number[];
  /** Arithmetic mean of the ingested values. */
  readonly mean: number;
  /** Relative error bound of the sketch estimate. */
  readonly error: number;
  readonly numVals: number;
}

/** Build the inner `percentile_agg` sketch query (sketch aliased `s`). */
function percentileInner<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: { valueColumn: string; range?: TimeRange; timeColumn?: string },
): [sql: string, params: unknown[]] {
  const resolve = columnResolver(repo);
  const agg = percentileAggExpr(resolve(options.valueColumn));
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const inner = repo.createQueryBuilder('e').select(agg, 's');
  applyTimeRange(inner, timeColumn, options.range);
  return inner.getQueryAndParameters();
}

/**
 * Typed approximate percentiles over a hypertable via `percentile_agg` (uddsketch).
 * Computes the sketch once, then extracts each requested percentile plus the sketch's
 * mean/error/count. Requires `timescaledb_toolkit`. Returns `null` when the (filtered)
 * set is empty.
 */
export async function getPercentiles<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetPercentilesOptions,
): Promise<PercentileResult | null> {
  if (options.percentiles.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'getPercentiles requires at least one percentile',
      {},
    );
  }
  await assertToolkit(repo.manager.connection);

  const [innerSql, params] = percentileInner(repo, defaultTimeColumn, options);
  const cols = options.percentiles.map((p, i) => `${approxPercentileExpr(p, 'q."s"')} AS "p${i}"`);
  const outerSql =
    `SELECT ${cols.join(', ')}, ` +
    `${percentileSketchAccessorExpr('mean', 'q."s"')} AS "mean", ` +
    `${percentileSketchAccessorExpr('error', 'q."s"')} AS "error", ` +
    `${percentileSketchAccessorExpr('num_vals', 'q."s"')} AS "num_vals" ` +
    `FROM (${innerSql}) q`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || row.num_vals === null || row.num_vals === undefined) {
    return null;
  }
  return {
    percentiles: options.percentiles.map((_, i) => toNumber(row[`p${i}`], `percentile[${i}]`)),
    mean: toNumber(row.mean, 'mean'),
    error: toNumber(row.error, 'error'),
    numVals: toNumber(row.num_vals, 'num_vals'),
  };
}

export interface GetPercentileRanksOptions {
  /** Value **property** name whose sketch the ranks are computed against. */
  readonly valueColumn: string;
  /** Values to rank (e.g. `[100, 250, 500]`); must be non-empty. */
  readonly values: readonly number[];
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property** for `range`; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/**
 * Typed approximate percentile **ranks** — for each input value, the fraction of the
 * distribution at or below it (`approx_percentile_rank`, the inverse of
 * {@link getPercentiles}). Requires `timescaledb_toolkit`. Returns `null` when the
 * (filtered) set is empty; otherwise an array aligned to the input `values`.
 */
export async function getPercentileRanks<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetPercentileRanksOptions,
): Promise<number[] | null> {
  if (options.values.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'getPercentileRanks requires at least one value',
      {},
    );
  }
  await assertToolkit(repo.manager.connection);

  const [innerSql, params] = percentileInner(repo, defaultTimeColumn, options);
  const cols = options.values.map((v, i) => `${approxPercentileRankExpr(v, 'q."s"')} AS "r${i}"`);
  const outerSql =
    `SELECT ${cols.join(', ')}, ${percentileSketchAccessorExpr('num_vals', 'q."s"')} AS "num_vals" ` +
    `FROM (${innerSql}) q`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || row.num_vals === null || row.num_vals === undefined) {
    return null;
  }
  return options.values.map((_, i) => toNumber(row[`r${i}`], `rank[${i}]`));
}

// ---------------------------------------------------------------------------
// counter_agg — monotonic counters that may reset
// ---------------------------------------------------------------------------

export interface GetCounterAggOptions {
  /** Counter value **property** name (a monotonically increasing counter). */
  readonly valueColumn: string;
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property**; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/**
 * A `counter_agg` summary. Rate-family fields (`rate`/`irate*`/`slope`/`intercept`/
 * `corr`/`idelta*`) are `null` when undefined (e.g. a single sample, zero time span).
 * `timeDelta` is in **seconds**.
 */
export interface CounterSummary {
  /** Total increase across the window, accounting for resets. */
  readonly delta: number;
  /** Per-second rate of increase (`delta / timeDelta`). */
  readonly rate: number | null;
  readonly irateLeft: number | null;
  readonly irateRight: number | null;
  readonly numResets: number;
  readonly numChanges: number;
  readonly numElements: number;
  readonly slope: number | null;
  readonly intercept: number | null;
  readonly corr: number | null;
  /** Seconds between the first and last sample. */
  readonly timeDelta: number;
  readonly firstVal: number;
  readonly lastVal: number;
  readonly firstTime: Date;
  readonly lastTime: Date;
  readonly ideltaLeft: number | null;
  readonly ideltaRight: number | null;
}

/**
 * Typed `counter_agg` over a hypertable — delta/rate/resets for a monotonic counter
 * that may reset. Same inner/outer single-evaluation pattern as the other helpers.
 * Requires `timescaledb_toolkit`. Returns `null` when the (filtered) set is empty.
 *
 * (The `extrapolated_delta`/`extrapolated_rate` accessors need the bounded
 * `counter_agg(ts, value, bounds)` form + a method; use the core builders for those.)
 */
export async function getCounterAgg<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetCounterAggOptions,
): Promise<CounterSummary | null> {
  await assertToolkit(repo.manager.connection);

  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const agg = counterAggExpr(timeColumn, resolve(options.valueColumn));

  const inner = repo.createQueryBuilder('e').select(agg, 'c');
  applyTimeRange(inner, timeColumn, options.range);
  const [innerSql, params] = inner.getQueryAndParameters();

  const acc = (a: Parameters<typeof counterAccessorExpr>[0], alias: string): string =>
    `${counterAccessorExpr(a, 'q."c"')} AS "${alias}"`;
  const outerSql =
    `SELECT ${acc('delta', 'delta')}, ${acc('rate', 'rate')}, ${acc('irate_left', 'irate_left')}, ` +
    `${acc('irate_right', 'irate_right')}, ${acc('num_resets', 'num_resets')}, ` +
    `${acc('num_changes', 'num_changes')}, ${acc('num_elements', 'num_elements')}, ` +
    `${acc('slope', 'slope')}, ${acc('intercept', 'intercept')}, ${acc('corr', 'corr')}, ` +
    `${acc('time_delta', 'time_delta')}, ${acc('first_val', 'first_val')}, ` +
    `${acc('last_val', 'last_val')}, ${acc('first_time', 'first_time')}, ` +
    `${acc('last_time', 'last_time')}, ${acc('idelta_left', 'idelta_left')}, ` +
    `${acc('idelta_right', 'idelta_right')} FROM (${innerSql}) q`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || row.num_elements === null || row.num_elements === undefined) {
    return null;
  }
  return {
    delta: toNumber(row.delta, 'delta'),
    rate: toNumberOrNull(row.rate, 'rate'),
    irateLeft: toNumberOrNull(row.irate_left, 'irate_left'),
    irateRight: toNumberOrNull(row.irate_right, 'irate_right'),
    numResets: toNumber(row.num_resets, 'num_resets'),
    numChanges: toNumber(row.num_changes, 'num_changes'),
    numElements: toNumber(row.num_elements, 'num_elements'),
    slope: toNumberOrNull(row.slope, 'slope'),
    intercept: toNumberOrNull(row.intercept, 'intercept'),
    corr: toNumberOrNull(row.corr, 'corr'),
    timeDelta: toNumber(row.time_delta, 'time_delta'),
    firstVal: toNumber(row.first_val, 'first_val'),
    lastVal: toNumber(row.last_val, 'last_val'),
    firstTime: toDate(row.first_time, 'first_time'),
    lastTime: toDate(row.last_time, 'last_time'),
    ideltaLeft: toNumberOrNull(row.idelta_left, 'idelta_left'),
    ideltaRight: toNumberOrNull(row.idelta_right, 'idelta_right'),
  };
}

// ---------------------------------------------------------------------------
// time_weight — time-weighted average / integral
// ---------------------------------------------------------------------------

export interface GetTimeWeightOptions {
  /** Value **property** name to time-weight. */
  readonly valueColumn: string;
  /** Weighting method. Default `'Linear'`. */
  readonly method?: TimeWeightMethod;
  /** Unit for the `integral` field. Default `'second'`. */
  readonly integralUnit?: IntegralUnit;
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: TimeRange;
  /** Time **property**; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/** A `time_weight` summary: the time-weighted average plus the integral and endpoints. */
export interface TimeWeight {
  /**
   * Time-weighted average over the window. `null` for a single-sample (zero-duration)
   * window, where the average is undefined but `firstVal`/`lastVal` are still valid.
   */
  readonly average: number | null;
  /** Time-weighted integral (area under the curve) in `integralUnit`. */
  readonly integral: number;
  readonly firstVal: number;
  readonly lastVal: number;
  readonly firstTime: Date;
  readonly lastTime: Date;
}

/**
 * Typed `time_weight` over a hypertable — the time-weighted average (and integral) of
 * an irregularly-sampled value, weighting each sample by how long it was in effect.
 * `method` defaults to `'Linear'` (interpolate) vs `'LOCF'` (carry forward). Requires
 * `timescaledb_toolkit`. Returns `null` when the (filtered) set is empty.
 */
export async function getTimeWeight<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetTimeWeightOptions,
): Promise<TimeWeight | null> {
  await assertToolkit(repo.manager.connection);

  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const agg = timeWeightAggExpr(
    options.method ?? 'Linear',
    timeColumn,
    resolve(options.valueColumn),
  );

  const inner = repo.createQueryBuilder('e').select(agg, 'w');
  applyTimeRange(inner, timeColumn, options.range);
  const [innerSql, params] = inner.getQueryAndParameters();

  const outerSql =
    `SELECT ${timeWeightAccessorExpr('average', 'q."w"')} AS "average", ` +
    `${timeWeightIntegralExpr('q."w"', options.integralUnit ?? 'second')} AS "integral", ` +
    `${timeWeightAccessorExpr('first_val', 'q."w"')} AS "first_val", ` +
    `${timeWeightAccessorExpr('last_val', 'q."w"')} AS "last_val", ` +
    `${timeWeightAccessorExpr('first_time', 'q."w"')} AS "first_time", ` +
    `${timeWeightAccessorExpr('last_time', 'q."w"')} AS "last_time" ` +
    `FROM (${innerSql}) q`;

  const rows = (await repo.query(outerSql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  // Empty input → time_weight NULL → every accessor NULL. Use first_time as the
  // sentinel: it is present for ANY non-empty window, whereas `average` is NULL for a
  // single-sample (zero-duration) window even though first/last values remain valid.
  if (!row || row.first_time === null || row.first_time === undefined) {
    return null;
  }
  return {
    average: toNumberOrNull(row.average, 'average'),
    integral: toNumber(row.integral, 'integral'),
    firstVal: toNumber(row.first_val, 'first_val'),
    lastVal: toNumber(row.last_val, 'last_val'),
    firstTime: toDate(row.first_time, 'first_time'),
    lastTime: toDate(row.last_time, 'last_time'),
  };
}

// ---------------------------------------------------------------------------
// state_agg — categorical state over time (text states)
// ---------------------------------------------------------------------------

/** Build the inner `state_agg(ts, value)` query (summary aliased `a`). */
function stateInner<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: { valueColumn: string; range?: TimeRange; timeColumn?: string },
): [sql: string, params: unknown[]] {
  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const agg = stateAggExpr(timeColumn, resolve(options.valueColumn));
  const inner = repo.createQueryBuilder('e').select(agg, 'a');
  applyTimeRange(inner, timeColumn, options.range);
  return inner.getQueryAndParameters();
}

export interface GetStateDurationsOptions {
  /** Text state **property** name. */
  readonly valueColumn: string;
  readonly range?: TimeRange;
  readonly timeColumn?: string;
}

/** Total time spent in a state, in seconds. */
export interface StateDuration {
  readonly state: string;
  readonly durationSeconds: number;
}

/**
 * Time spent in each state via `state_agg` + `into_values` — the headline accessor.
 * Durations are returned in **seconds**. Requires `timescaledb_toolkit`. Returns `[]`
 * when the (filtered) set is empty.
 */
export async function getStateDurations<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetStateDurationsOptions,
): Promise<StateDuration[]> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = stateInner(repo, defaultTimeColumn, options);
  const sql =
    `SELECT sv.state AS state, EXTRACT(EPOCH FROM sv.duration) AS duration_seconds ` +
    `FROM (${innerSql}) q, ${stateIntoValuesExpr('q."a"')} AS sv(state, duration)`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    state: String(r.state),
    durationSeconds: toNumber(r.duration_seconds, 'duration_seconds'),
  }));
}

export interface GetStateTimelineOptions {
  readonly valueColumn: string;
  readonly range?: TimeRange;
  readonly timeColumn?: string;
}

/** A contiguous period during which a single state was in effect. */
export interface StateInterval {
  readonly state: string;
  readonly startTime: Date;
  readonly endTime: Date;
}

/**
 * The ordered timeline of state intervals via `state_agg` + `state_timeline`.
 * Requires `timescaledb_toolkit`. Returns `[]` when the (filtered) set is empty.
 */
export async function getStateTimeline<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetStateTimelineOptions,
): Promise<StateInterval[]> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = stateInner(repo, defaultTimeColumn, options);
  const sql =
    `SELECT tl.state AS state, tl.start_time AS start_time, tl.end_time AS end_time ` +
    `FROM (${innerSql}) q, ${stateTimelineExpr('q."a"')} AS tl(state, start_time, end_time)`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    state: String(r.state),
    startTime: toDate(r.start_time, 'start_time'),
    endTime: toDate(r.end_time, 'end_time'),
  }));
}

export interface GetStateAtOptions {
  readonly valueColumn: string;
  /** The instant to probe. */
  readonly at: Date | string;
  readonly range?: TimeRange;
  readonly timeColumn?: string;
}

/**
 * The state in effect at `at` via `state_agg` + `state_at`. Requires
 * `timescaledb_toolkit`. Returns `null` when the set is empty or `at` is outside the
 * covered range.
 */
export async function getStateAt<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetStateAtOptions,
): Promise<string | null> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = stateInner(repo, defaultTimeColumn, options);
  const pointToken = `$${params.length + 1}`;
  const sql = `SELECT ${stateAtExpr('q."a"', pointToken)} AS state FROM (${innerSql}) q`;
  const rows = (await repo.query(sql, [...params, options.at])) as Array<Record<string, unknown>>;
  const v = rows[0]?.state;
  return v === null || v === undefined ? null : String(v);
}

export interface GetStatePeriodsOptions {
  readonly valueColumn: string;
  /** The state whose periods to return. */
  readonly state: string;
  readonly range?: TimeRange;
  readonly timeColumn?: string;
}

/** A `[startTime, endTime)` period. */
export interface Period {
  readonly startTime: Date;
  readonly endTime: Date;
}

/**
 * The periods during which the entity was in `state` via `state_agg` + `state_periods`.
 * Requires `timescaledb_toolkit`. Returns `[]` when the set is empty or the state never
 * occurred.
 */
export async function getStatePeriods<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetStatePeriodsOptions,
): Promise<Period[]> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = stateInner(repo, defaultTimeColumn, options);
  const stateToken = `$${params.length + 1}`;
  const sql =
    `SELECT p.start_time AS start_time, p.end_time AS end_time ` +
    `FROM (${innerSql}) q, ${statePeriodsExpr('q."a"', stateToken)} AS p(start_time, end_time)`;
  const rows = (await repo.query(sql, [...params, options.state])) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    startTime: toDate(r.start_time, 'start_time'),
    endTime: toDate(r.end_time, 'end_time'),
  }));
}

// ---------------------------------------------------------------------------
// mcv_agg — most-common-values / top-N (text values)
// ---------------------------------------------------------------------------

export interface GetMostCommonValuesOptions {
  /** Text value **property** name. */
  readonly valueColumn: string;
  /** How many top values to track (Space-Saving capacity). Default `10`. */
  readonly count?: number;
  readonly range?: TimeRange;
  readonly timeColumn?: string;
}

/** A tracked value with its estimated frequency bounds (fraction of rows, 0..1). */
export interface MostCommonValue {
  readonly value: string;
  readonly minFreq: number;
  readonly maxFreq: number;
}

/**
 * The most common values via `mcv_agg` + `into_values`, frequency-descending, with each
 * value's estimated min/max frequency. Requires `timescaledb_toolkit`. Returns `[]` when
 * the (filtered) set is empty.
 */
export async function getMostCommonValues<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetMostCommonValuesOptions,
): Promise<MostCommonValue[]> {
  await assertToolkit(repo.manager.connection);
  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const agg = mcvAggExpr(options.count ?? 10, resolve(options.valueColumn));
  const inner = repo.createQueryBuilder('e').select(agg, 'a');
  applyTimeRange(inner, timeColumn, options.range);
  const [innerSql, params] = inner.getQueryAndParameters();
  const sql =
    `SELECT mv.value AS value, mv.min_freq AS min_freq, mv.max_freq AS max_freq ` +
    `FROM (${innerSql}) q, ${mcvIntoValuesExpr('q."a"')} AS mv(value, min_freq, max_freq)`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    value: String(r.value),
    minFreq: toNumber(r.min_freq, 'min_freq'),
    maxFreq: toNumber(r.max_freq, 'max_freq'),
  }));
}

export interface GetTopNOptions {
  /** Text value **property** name. */
  readonly valueColumn: string;
  /** How many top values to return. */
  readonly n: number;
  /** Tracking capacity (Space-Saving). Defaults to `n`; raise it for better accuracy. */
  readonly count?: number;
  readonly range?: TimeRange;
  readonly timeColumn?: string;
}

/**
 * The top `n` most common values via `mcv_agg` + `topn`, frequency-descending. Requires
 * `timescaledb_toolkit`. Returns `[]` when the (filtered) set is empty.
 */
export async function getTopN<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetTopNOptions,
): Promise<string[]> {
  // `count` is the Space-Saving sketch capacity; asking for the top `n` with a smaller
  // capacity can silently drop real top-N values. Require count >= n (fail fast, no DB).
  const count = options.count ?? options.n;
  if (count < options.n) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `getTopN: count (${count}) must be >= n (${options.n}); count is the sketch capacity`,
      { count, n: options.n },
    );
  }
  await assertToolkit(repo.manager.connection);
  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const agg = mcvAggExpr(count, resolve(options.valueColumn));
  const inner = repo.createQueryBuilder('e').select(agg, 'a');
  applyTimeRange(inner, timeColumn, options.range);
  const [innerSql, params] = inner.getQueryAndParameters();
  const sql = `SELECT t.v AS v FROM (${innerSql}) q, ${mcvTopNExpr('q."a"', options.n)} AS t(v)`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.v));
}

// ---------------------------------------------------------------------------
// heartbeat_agg — liveness / uptime over a window
// ---------------------------------------------------------------------------

/** The window + liveness config for the `heartbeat_agg` helpers. */
export interface HeartbeatWindow {
  /** Window start (`agg_start`). */
  readonly start: Date | string;
  /** Window length as an interval string (`agg_duration`), e.g. `'1 day'`. */
  readonly duration: string;
  /** How long each heartbeat keeps the system live, as an interval string, e.g. `'10 minutes'`. */
  readonly liveness: string;
  /** Optional extra `[from, to)` filter on the input heartbeats. */
  readonly range?: TimeRange;
  /** Time **property**; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
}

/** A `heartbeat_agg` health summary over the window. Durations are in **seconds**. */
export interface HeartbeatHealth {
  readonly uptimeSeconds: number;
  readonly downtimeSeconds: number;
  readonly numGaps: number;
  readonly numLiveRanges: number;
}

/**
 * Build the inner `heartbeat_agg(...)` query (summary aliased `a`). The window config
 * and the range bounds are ALL bound in a single `setParameters` call (the config args
 * live inside the aggregate, so they cannot be appended at the outer query).
 */
function heartbeatInner<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: HeartbeatWindow,
): [sql: string, params: unknown[]] {
  const resolve = columnResolver(repo);
  const timeColumn = resolve(options.timeColumn ?? defaultTimeColumn);
  const agg = heartbeatAggExpr(timeColumn, ':__hbStart', ':__hbDuration', ':__hbLiveness');
  const inner = repo.createQueryBuilder('e').select(agg, 'a');
  const params: Record<string, unknown> = {
    __hbStart: options.start,
    __hbDuration: options.duration,
    __hbLiveness: options.liveness,
  };
  // heartbeat_agg ERRORS if any input point falls outside [start, start+duration), so
  // always bound the input to the window. A genuinely empty window then aggregates zero
  // rows → NULL summary → the helpers return null/[] rather than throwing.
  const col = safeIdent(timeColumn);
  inner.andWhere(`${col} >= :__hbStart`);
  inner.andWhere(`${col} < :__hbStart + :__hbDuration::interval`);
  if (options.range?.from !== undefined) {
    inner.andWhere(`${safeIdent(timeColumn)} >= :__hbFrom`);
    params.__hbFrom = options.range.from;
  }
  if (options.range?.to !== undefined) {
    inner.andWhere(`${safeIdent(timeColumn)} < :__hbTo`);
    params.__hbTo = options.range.to;
  }
  inner.setParameters(params);
  return inner.getQueryAndParameters();
}

/**
 * Liveness/uptime summary via `heartbeat_agg` — uptime/downtime (seconds), gap count and
 * live-range count over `[start, start+duration)`. Requires `timescaledb_toolkit`. Returns
 * `null` when there are no heartbeats in the window (the aggregate is empty).
 */
export async function getHeartbeatHealth<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: HeartbeatWindow,
): Promise<HeartbeatHealth | null> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = heartbeatInner(repo, defaultTimeColumn, options);
  const sql =
    `SELECT EXTRACT(EPOCH FROM ${heartbeatAccessorExpr('uptime', 'q."a"')}) AS uptime_s, ` +
    `EXTRACT(EPOCH FROM ${heartbeatAccessorExpr('downtime', 'q."a"')}) AS downtime_s, ` +
    `${heartbeatAccessorExpr('num_gaps', 'q."a"')} AS num_gaps, ` +
    `${heartbeatAccessorExpr('num_live_ranges', 'q."a"')} AS num_live_ranges ` +
    `FROM (${innerSql}) q`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row || row.uptime_s === null || row.uptime_s === undefined) {
    return null;
  }
  return {
    uptimeSeconds: toNumber(row.uptime_s, 'uptime_s'),
    downtimeSeconds: toNumber(row.downtime_s, 'downtime_s'),
    numGaps: toNumber(row.num_gaps, 'num_gaps'),
    numLiveRanges: toNumber(row.num_live_ranges, 'num_live_ranges'),
  };
}

/**
 * The live `[startTime, endTime)` ranges via `heartbeat_agg` + `live_ranges`. Requires
 * `timescaledb_toolkit`. Returns `[]` when there are no heartbeats in the window.
 */
export async function getLiveRanges<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: HeartbeatWindow,
): Promise<Period[]> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = heartbeatInner(repo, defaultTimeColumn, options);
  const sql =
    `SELECT lr.range_start AS start_time, lr.range_end AS end_time ` +
    `FROM (${innerSql}) q, ${heartbeatLiveRangesExpr('q."a"')} AS lr(range_start, range_end)`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    startTime: toDate(r.start_time, 'start_time'),
    endTime: toDate(r.end_time, 'end_time'),
  }));
}

/**
 * The dead `[startTime, endTime)` ranges via `heartbeat_agg` + `dead_ranges`. Requires
 * `timescaledb_toolkit`. Returns `[]` when there are no heartbeats in the window.
 */
export async function getDeadRanges<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: HeartbeatWindow,
): Promise<Period[]> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = heartbeatInner(repo, defaultTimeColumn, options);
  const sql =
    `SELECT dr.range_start AS start_time, dr.range_end AS end_time ` +
    `FROM (${innerSql}) q, ${heartbeatDeadRangesExpr('q."a"')} AS dr(range_start, range_end)`;
  const rows = (await repo.query(sql, params)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    startTime: toDate(r.start_time, 'start_time'),
    endTime: toDate(r.end_time, 'end_time'),
  }));
}

/** Options for {@link isLiveAt}: a heartbeat window plus the instant to probe. */
export interface IsLiveAtOptions extends HeartbeatWindow {
  /** The instant to probe liveness at. */
  readonly at: Date | string;
}

/**
 * Whether the system was live at `at` via `heartbeat_agg` + `live_at`. Requires
 * `timescaledb_toolkit`. Returns `null` when there are no heartbeats in the window.
 */
export async function isLiveAt<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: IsLiveAtOptions,
): Promise<boolean | null> {
  await assertToolkit(repo.manager.connection);
  const [innerSql, params] = heartbeatInner(repo, defaultTimeColumn, options);
  const pointToken = `$${params.length + 1}`;
  const sql = `SELECT ${heartbeatLiveAtExpr('q."a"', pointToken)} AS live FROM (${innerSql}) q`;
  const rows = (await repo.query(sql, [...params, options.at])) as Array<Record<string, unknown>>;
  const v = rows[0]?.live;
  return v === null || v === undefined ? null : Boolean(v);
}

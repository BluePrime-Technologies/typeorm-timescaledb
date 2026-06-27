import type { DataSource, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import {
  approxCountDistinctAggExpr,
  approxPercentileExpr,
  approxPercentileRankExpr,
  candlestickAccessorExpr,
  candlestickAggExpr,
  distinctCountExpr,
  percentileAggExpr,
  percentileSketchAccessorExpr,
  safeIdent,
  statsAccessor1DExpr,
  statsAccessor2DExpr,
  statsAgg1DExpr,
  statsAgg2DExpr,
  timeBucketExpr,
  TOOLKIT_PRESENCE_SQL,
  TimescaleError,
  TimescaleErrorCode,
  type StatsMethod,
} from '@blueprime/timescaledb-core';
import { toDate, toNumber, toNumberOrNull, toBigIntString } from './result-mapper.js';

/** Inclusive-from / exclusive-to time bounds; bound as query parameters when applied. */
export interface TimeRange {
  readonly from?: Date | string;
  readonly to?: Date | string;
}

/** Resolve entity property names to DB column names for a repository. */
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
  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;
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

  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;
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
  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;

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
  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;

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
  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;
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

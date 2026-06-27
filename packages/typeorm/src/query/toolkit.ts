import type { DataSource, ObjectLiteral, Repository } from 'typeorm';
import {
  approxCountDistinctAggExpr,
  candlestickAccessorExpr,
  candlestickAggExpr,
  distinctCountExpr,
  safeIdent,
  timeBucketExpr,
  TOOLKIT_PRESENCE_SQL,
  TimescaleError,
  TimescaleErrorCode,
} from '@blueprime/timescaledb-core';
import { toDate, toNumber, toBigIntString } from './result-mapper.js';

/**
 * `timescaledb_toolkit`-backed query helpers (candlesticks, approx_count_distinct).
 *
 * Every entry point runs a cached toolkit-presence check first and throws the stable
 * `TSDB_TOOLKIT_MISSING` error if the extension is absent — so consumers get a clear,
 * documented failure instead of a raw `function ... does not exist` from PostgreSQL.
 */

// Cache the presence check per DataSource (one round-trip, not per query).
const toolkitChecked = new WeakMap<DataSource, Promise<void>>();

/** Resolve once per DataSource; throws `TSDB_TOOLKIT_MISSING` when the extension is absent. */
export function assertToolkit(dataSource: DataSource): Promise<void> {
  let pending = toolkitChecked.get(dataSource);
  if (!pending) {
    pending = dataSource.query(TOOLKIT_PRESENCE_SQL).then((rows: unknown) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new TimescaleError(
          TimescaleErrorCode.TOOLKIT_MISSING,
          'timescaledb_toolkit is not installed on this database — run `CREATE EXTENSION timescaledb_toolkit;` (or use an image that bundles it) to use candlesticks / approx_count_distinct',
          {},
        );
      }
    });
    // Don't cache a rejection: a transient query failure shouldn't poison later calls.
    pending.catch(() => toolkitChecked.delete(dataSource));
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
  readonly vwap: number;
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
  readonly range?: { readonly from?: Date | string; readonly to?: Date | string };
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

  const resolve = (property: string): string =>
    repo.metadata.findColumnWithPropertyName(property)?.databaseName ?? property;
  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;
  const cs = candlestickAggExpr(
    timeColumn,
    resolve(options.priceColumn),
    resolve(options.volumeColumn),
  );
  const bucketExpr = timeBucketExpr({ interval: options.interval, column: timeColumn });

  const qb = repo
    .createQueryBuilder('e')
    .select(bucketExpr, 'bucket')
    .addSelect(candlestickAccessorExpr('open', cs), 'open')
    .addSelect(candlestickAccessorExpr('high', cs), 'high')
    .addSelect(candlestickAccessorExpr('low', cs), 'low')
    .addSelect(candlestickAccessorExpr('close', cs), 'close')
    .addSelect(candlestickAccessorExpr('volume', cs), 'volume')
    .addSelect(candlestickAccessorExpr('vwap', cs), 'vwap')
    .groupBy(bucketExpr);

  if (options.range?.from !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} >= :__tsFrom`, { __tsFrom: options.range.from });
  }
  if (options.range?.to !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} < :__tsTo`, { __tsTo: options.range.to });
  }
  qb.orderBy(bucketExpr, options.order ?? 'ASC');

  const rows = await qb.getRawMany<Record<string, unknown>>();
  return rows.map((r) => ({
    bucket: toDate(r.bucket, 'bucket'),
    open: toNumber(r.open, 'open'),
    high: toNumber(r.high, 'high'),
    low: toNumber(r.low, 'low'),
    close: toNumber(r.close, 'close'),
    volume: toNumber(r.volume, 'volume'),
    vwap: toNumber(r.vwap, 'vwap'),
  }));
}

export interface ApproxCountDistinctOptions {
  /** Column **property** name to estimate distinct cardinality of. */
  readonly column: string;
  /** Inclusive-from / exclusive-to time bounds on the time column (bound as parameters). */
  readonly range?: { readonly from?: Date | string; readonly to?: Date | string };
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

  const resolve = (property: string): string =>
    repo.metadata.findColumnWithPropertyName(property)?.databaseName ?? property;
  const expr = distinctCountExpr(approxCountDistinctAggExpr(resolve(options.column)));
  const qb = repo.createQueryBuilder('e').select(expr, 'n');

  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;
  if (options.range?.from !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} >= :__tsFrom`, { __tsFrom: options.range.from });
  }
  if (options.range?.to !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} < :__tsTo`, { __tsTo: options.range.to });
  }

  const row = await qb.getRawOne<{ n: unknown }>();
  return toBigIntString(row?.n, 'approx_count_distinct');
}

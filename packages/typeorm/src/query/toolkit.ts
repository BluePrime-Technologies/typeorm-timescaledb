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
import { toDate, toNumber, toNumberOrNull, toBigIntString } from './result-mapper.js';

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
          'timescaledb_toolkit is not installed on this database — run `CREATE EXTENSION timescaledb_toolkit;` (or use an image that bundles it) to use candlesticks / approx_count_distinct',
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

  // Compute candlestick_agg ONCE per bucket in an inner query, then apply the
  // accessors in the outer query — repeating the aggregate in each accessor would
  // make PostgreSQL evaluate it 6× per bucket. The inner builder handles the table,
  // WHERE, and parameter binding safely; we only wrap its SQL.
  const inner = repo.createQueryBuilder('e').select(bucketExpr, 'bucket').addSelect(cs, 'cs');
  if (options.range?.from !== undefined) {
    inner.andWhere(`${safeIdent(timeColumn)} >= :__tsFrom`, { __tsFrom: options.range.from });
  }
  if (options.range?.to !== undefined) {
    inner.andWhere(`${safeIdent(timeColumn)} < :__tsTo`, { __tsTo: options.range.to });
  }
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

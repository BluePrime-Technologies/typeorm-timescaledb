import { safeIdent } from '../identifier.js';
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

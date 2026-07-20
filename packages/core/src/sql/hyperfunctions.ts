import { safeIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { assertInterval } from '../interval.js';
import { numericLiteral } from './numeric.js';
import { TimescaleError, TimescaleErrorCode } from '../errors.js';

/**
 * Pure SQL **expression** builders for the base-extension hyperfunctions (no
 * `timescaledb_toolkit` required): `time_bucket`, `first`/`last`, `histogram`,
 * `approx_count_distinct`.
 *
 * Unlike the DDL builders in `hypertable.ts`, these return a single SQL *fragment*
 * meant to be dropped into a `SELECT` list (TypeORM's `addSelect`). They are the
 * single source of truth for the exact SQL the `TimescaleQueryBuilder` emits.
 *
 * Safety: every column flows through {@link safeIdent} (allow-list + quote);
 * intervals through {@link assertInterval}; string args (timezone, origin) through
 * {@link quoteLiteral}; numeric args are validated as finite JS numbers (a number
 * cannot carry an injection, but NaN/Infinity/exponent forms are rejected so only
 * well-formed SQL numerics are emitted).
 *
 * Target: TimescaleDB ≥ 2.18 (verified against 2.27).
 */

function positiveIntLiteral(value: number, role: string): string {
  // isSafeInteger (not isInteger) so a huge non-safe integer like 1e21 is rejected here — the
  // shared numericLiteral deliberately permits exponent forms, so this is the bound for integer args.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a positive integer, got: ${String(value)}`,
      { role, value: String(value) },
    );
  }
  return numericLiteral(value, role);
}

export interface TimeBucketExprInput {
  /** Bucket width as a PostgreSQL interval, e.g. `'1 hour'`. */
  readonly interval: string;
  /** Time/partition column to bucket (untrusted identifier — allow-listed). */
  readonly column: string;
  /**
   * IANA timezone, e.g. `'Europe/London'`. When set, the timezone variant
   * `time_bucket(width, ts, timezone[, origin][, offset])` is emitted so buckets
   * align to local calendar boundaries (DST-aware).
   */
  readonly timezone?: string;
  /** Bucket origin as a timestamp literal, e.g. `'2024-01-01'`. */
  readonly origin?: string;
  /** Bucket offset as an interval, e.g. `'30 minutes'`. */
  readonly offset?: string;
}

/**
 * Build a `time_bucket(...)` expression.
 *
 * Supported signatures (TimescaleDB):
 * - base: `time_bucket(width, ts)`
 * - offset: `time_bucket(width, ts, offset)`
 * - origin: `time_bucket(width, ts, origin)`
 * - timezone: `time_bucket(width, ts, tz[, origin][, offset])`
 *
 * Without a `timezone`, `origin` and `offset` are mutually exclusive (the two
 * non-tz overloads are disambiguated by argument type, so both cannot be passed
 * at once) — combine them by supplying a `timezone`.
 */
export function timeBucketExpr(input: TimeBucketExprInput): string {
  const width = `INTERVAL ${quoteLiteral(assertInterval(input.interval, 'time_bucket interval'))}`;
  const col = safeIdent(input.column, 'time_bucket column');
  const originSql =
    input.origin === undefined
      ? undefined
      : `TIMESTAMPTZ ${quoteLiteral(input.origin, 'time_bucket origin')}`;
  const offsetSql =
    input.offset === undefined
      ? undefined
      : `INTERVAL ${quoteLiteral(assertInterval(input.offset, 'time_bucket offset'))}`;

  if (input.timezone !== undefined) {
    const tz = quoteLiteral(input.timezone, 'time_bucket timezone');
    // Positional tz variant: width, ts, tz, origin, offset. `offset` without an
    // explicit `origin` needs a NULL placeholder to keep positions aligned.
    const args = [width, col, tz];
    if (originSql !== undefined || offsetSql !== undefined) {
      args.push(originSql ?? 'NULL::timestamptz');
    }
    if (offsetSql !== undefined) {
      args.push(offsetSql);
    }
    return `time_bucket(${args.join(', ')})`;
  }

  if (originSql !== undefined && offsetSql !== undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'time_bucket: supply a `timezone` to combine `origin` and `offset`; without one only a single offset OR origin is supported',
      {},
    );
  }
  if (originSql !== undefined) {
    return `time_bucket(${width}, ${col}, ${originSql})`;
  }
  if (offsetSql !== undefined) {
    return `time_bucket(${width}, ${col}, ${offsetSql})`;
  }
  return `time_bucket(${width}, ${col})`;
}

/**
 * `first(value, time)` — the value of `value` at the row with the **earliest**
 * `time` in the group. Note: this is value-at-time, NOT `min(value)`.
 */
export function firstExpr(valueColumn: string, timeColumn: string): string {
  return `first(${safeIdent(valueColumn, 'first value column')}, ${safeIdent(timeColumn, 'first time column')})`;
}

/**
 * `last(value, time)` — the value of `value` at the row with the **latest** `time`
 * in the group. Note: this is value-at-time, NOT `max(value)`.
 */
export function lastExpr(valueColumn: string, timeColumn: string): string {
  return `last(${safeIdent(valueColumn, 'last value column')}, ${safeIdent(timeColumn, 'last time column')})`;
}

export interface HistogramExprInput {
  readonly column: string;
  readonly min: number;
  readonly max: number;
  /** Number of buckets between `min` and `max` (positive integer). */
  readonly nbuckets: number;
}

/**
 * `histogram(value, min, max, nbuckets)` — returns an `int[]` of bucket counts
 * (with under/overflow buckets at the ends).
 */
export function histogramExpr(input: HistogramExprInput): string {
  const col = safeIdent(input.column, 'histogram column');
  const min = numericLiteral(input.min, 'histogram min');
  const max = numericLiteral(input.max, 'histogram max');
  const nbuckets = positiveIntLiteral(input.nbuckets, 'histogram nbuckets');
  if (input.min >= input.max) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `histogram min (${min}) must be strictly less than max (${max})`,
      { min, max },
    );
  }
  return `histogram(${col}, ${min}, ${max}, ${nbuckets})`;
}

export interface TimeBucketGapfillExprInput {
  /** Bucket width as a PostgreSQL interval, e.g. `'1 hour'`. */
  readonly interval: string;
  /** Time/partition column to bucket (untrusted identifier — allow-listed). */
  readonly column: string;
  /**
   * Explicit gapfill range as timestamp literals. Pass BOTH or neither — without
   * them the surrounding query's `WHERE` bounds drive the gapfill range (and are
   * then required by TimescaleDB).
   */
  readonly start?: string;
  readonly finish?: string;
}

/**
 * `time_bucket_gapfill(...)` — like `time_bucket` but emits a row for every bucket
 * in the range, including empty ones (so `locf`/`interpolate` can fill them).
 *
 * TimescaleDB requires the gapfill range to be bounded: pass explicit
 * `start`/`finish`, or constrain the query's time column in `WHERE`.
 */
export function timeBucketGapfillExpr(input: TimeBucketGapfillExprInput): string {
  const width = `INTERVAL ${quoteLiteral(assertInterval(input.interval, 'time_bucket_gapfill interval'))}`;
  const col = safeIdent(input.column, 'time_bucket_gapfill column');
  const { start, finish } = input;
  if ((start === undefined) !== (finish === undefined)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'time_bucket_gapfill: pass BOTH start and finish, or neither (the query WHERE bounds then drive the range)',
      {},
    );
  }
  if (start !== undefined && finish !== undefined) {
    // Reject an inverted range up front with a clear error (PG would otherwise
    // return zero rows or fail at run time). Parseable timestamps only; if either
    // is non-parseable we leave validation to PG rather than guess.
    const st = Date.parse(start);
    const fn = Date.parse(finish);
    if (!Number.isNaN(st) && !Number.isNaN(fn) && fn <= st) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `time_bucket_gapfill: finish (${finish}) must be after start (${start})`,
        { start, finish },
      );
    }
    const s = `TIMESTAMPTZ ${quoteLiteral(start, 'time_bucket_gapfill start')}`;
    const f = `TIMESTAMPTZ ${quoteLiteral(finish, 'time_bucket_gapfill finish')}`;
    return `time_bucket_gapfill(${width}, ${col}, ${s}, ${f})`;
  }
  return `time_bucket_gapfill(${width}, ${col})`;
}

/**
 * `locf(expr)` — last-observation-carried-forward over the gaps created by
 * `time_bucket_gapfill`. **Only valid inside a gapfill query.** `aggregateExpr`
 * must be an already-safe SQL fragment (e.g. built from an allow-listed aggregate
 * over a {@link safeIdent}-quoted column) — it is wrapped verbatim.
 */
export function locfExpr(aggregateExpr: string): string {
  return `locf(${aggregateExpr})`;
}

/**
 * `interpolate(expr)` — linear interpolation across gapfill gaps. **Only valid
 * inside a gapfill query.** `aggregateExpr` must be an already-safe SQL fragment.
 */
export function interpolateExpr(aggregateExpr: string): string {
  return `interpolate(${aggregateExpr})`;
}

// NOTE: `approx_count_distinct` is a `timescaledb_toolkit` function (NOT base) —
// verified against a live DB (`function approx_count_distinct(text) does not exist`
// on stock TimescaleDB). It lands in M2.2 alongside toolkit-presence detection and
// the `TSDB_TOOLKIT_MISSING` error, not here in the base-only M2.0 surface.

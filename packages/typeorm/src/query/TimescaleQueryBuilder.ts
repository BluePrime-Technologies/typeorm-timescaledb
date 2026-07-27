import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import {
  assertSafeIdentifier,
  firstExpr,
  histogramExpr,
  interpolateExpr,
  lastExpr,
  locfExpr,
  timeBucketExpr,
  timeBucketGapfillExpr,
  TimescaleError,
  TimescaleErrorCode,
  type HistogramExprInput,
  type TimeBucketExprInput,
  type TimeBucketGapfillExprInput,
} from '@blueprime/timescaledb-core';
import { standardAggregateExpr, type StandardAggregate } from './aggregate.js';

/** Options for {@link TimescaleQueryBuilder.timeBucket}. */
export interface TimeBucketSelectOptions {
  /** Also `GROUP BY` the bucket expression. Default `true`. */
  readonly group?: boolean;
  /** Add `ORDER BY bucket <dir>`. Omitted by default. */
  readonly order?: 'ASC' | 'DESC';
}

/**
 * A per-instance fluent wrapper around a TypeORM {@link SelectQueryBuilder} that
 * adds base-extension hyperfunction selections (`time_bucket`, `first`/`last`,
 * `histogram`, `approx_count_distinct`).
 *
 * **Raw-identifier tier:** column arguments are treated as DB column identifiers
 * and flow through the core allow-list (`safeIdent`) — this is the low-level escape
 * hatch. For the typed, property-name convenience use `repo.getTimeBucket(...)`.
 *
 * It **wraps** the builder and never patches `SelectQueryBuilder.prototype`, so the
 * package's no-global-mutation guarantee holds (other DataSources stay untouched).
 * Results are raw rows — hyperfunctions don't hydrate into entities; pair with the
 * coercion helpers in `./result-mapper`.
 */
export class TimescaleQueryBuilder<T extends ObjectLiteral> {
  /** `true` once a gapfill bucket was anchored with an explicit DESC order. */
  private gapfillDesc = false;

  constructor(private readonly qb: SelectQueryBuilder<T>) {}

  /** The wrapped TypeORM builder (escape hatch for `where`, params, joins, etc.). */
  get queryBuilder(): SelectQueryBuilder<T> {
    return this.qb;
  }

  /**
   * Anchor the query on `time_bucket(...) AS alias` and (by default) group by it.
   *
   * This **replaces** the SELECT list (via `.select`) rather than appending — a
   * grouped time-bucket query must not also project the entity's ungrouped columns
   * (Postgres would reject them as not in `GROUP BY`). Chain `.first`/`.histogram`/…
   * after it to add aggregate columns. For an aggregate query without a bucket,
   * reset the projection yourself via `.queryBuilder.select(...)`.
   */
  timeBucket(
    input: TimeBucketExprInput,
    alias = 'bucket',
    options?: TimeBucketSelectOptions,
  ): this {
    const expr = timeBucketExpr(input);
    this.qb.select(expr, assertSafeIdentifier(alias, 'alias'));
    if (options?.group !== false) {
      this.qb.addGroupBy(expr);
    }
    if (options?.order) {
      this.qb.addOrderBy(expr, options.order);
    }
    return this;
  }

  /** Add `first(value, time) AS alias` (value-at-earliest-time, not `min`). */
  first(valueColumn: string, timeColumn: string, alias: string): this {
    this.qb.addSelect(firstExpr(valueColumn, timeColumn), assertSafeIdentifier(alias, 'alias'));
    return this;
  }

  /** Add `last(value, time) AS alias` (value-at-latest-time, not `max`). */
  last(valueColumn: string, timeColumn: string, alias: string): this {
    this.qb.addSelect(lastExpr(valueColumn, timeColumn), assertSafeIdentifier(alias, 'alias'));
    return this;
  }

  /** Add `histogram(value, min, max, nbuckets) AS alias` (returns `int[]`). */
  histogram(input: HistogramExprInput, alias: string): this {
    this.qb.addSelect(histogramExpr(input), assertSafeIdentifier(alias, 'alias'));
    return this;
  }

  /**
   * Anchor on `time_bucket_gapfill(...)` — like {@link timeBucket} (replaces the
   * SELECT list, groups by the bucket), but emits empty buckets to be filled by
   * {@link locf}/{@link interpolate}.
   *
   * **You must bound the input window in `WHERE`** on this builder (e.g.
   * `.queryBuilder.where('time >= :from AND time < :to', …)`). `start`/`finish` set
   * the *output* gap range but do NOT filter the rows being aggregated, so without a
   * matching WHERE, data from earlier/later buckets leaks into the result. (The typed
   * `repo.getTimeBucket({ gapfill })` adds these bounds for you.)
   */
  timeBucketGapfill(
    input: TimeBucketGapfillExprInput,
    alias = 'bucket',
    options?: TimeBucketSelectOptions,
  ): this {
    const expr = timeBucketGapfillExpr(input);
    this.qb.select(expr, assertSafeIdentifier(alias, 'alias'));
    if (options?.group !== false) {
      this.qb.addGroupBy(expr);
    }
    // Default to ASC: locf/interpolate fill forward and need chronological buckets,
    // so an unordered gapfill query would silently produce wrong fills. Caller may
    // override with an explicit `order`, but then locf/interpolate are refused below.
    const order = options?.order ?? 'ASC';
    this.gapfillDesc = order === 'DESC';
    this.qb.addOrderBy(expr, order);
    return this;
  }

  /** Guard: locf/interpolate fill forward and are wrong under a DESC gapfill bucket. */
  private assertAscendingForFill(fn: string): void {
    if (this.gapfillDesc) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `${fn} fills forward and requires ascending bucket order — remove the DESC order from timeBucketGapfill`,
        {},
      );
    }
  }

  /** Add `locf(<agg>) AS alias` — carry the last value forward across gapfill gaps. */
  locf(metric: { fn: StandardAggregate; column?: string }, alias: string): this {
    this.assertAscendingForFill('locf');
    this.qb.addSelect(
      locfExpr(standardAggregateExpr(metric.fn, metric.column)),
      assertSafeIdentifier(alias, 'alias'),
    );
    return this;
  }

  /** Add `interpolate(<agg>) AS alias` — linearly interpolate across gapfill gaps. */
  interpolate(metric: { fn: StandardAggregate; column?: string }, alias: string): this {
    this.assertAscendingForFill('interpolate');
    this.qb.addSelect(
      interpolateExpr(standardAggregateExpr(metric.fn, metric.column)),
      assertSafeIdentifier(alias, 'alias'),
    );
    return this;
  }

  /** Execute and return raw rows (hyperfunction results are not entities). */
  getRawMany<R extends ObjectLiteral = ObjectLiteral>(): Promise<R[]> {
    return this.qb.getRawMany<R>();
  }

  /** Execute and return the first raw row, or `undefined`. */
  getRawOne<R extends ObjectLiteral = ObjectLiteral>(): Promise<R | undefined> {
    return this.qb.getRawOne<R>();
  }

  /** The generated SQL (for testing / debugging) — no execution. */
  getSql(): string {
    return this.qb.getSql();
  }
}

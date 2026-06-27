import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import {
  firstExpr,
  histogramExpr,
  interpolateExpr,
  lastExpr,
  locfExpr,
  timeBucketExpr,
  timeBucketGapfillExpr,
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
    this.qb.select(expr, alias);
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
    this.qb.addSelect(firstExpr(valueColumn, timeColumn), alias);
    return this;
  }

  /** Add `last(value, time) AS alias` (value-at-latest-time, not `max`). */
  last(valueColumn: string, timeColumn: string, alias: string): this {
    this.qb.addSelect(lastExpr(valueColumn, timeColumn), alias);
    return this;
  }

  /** Add `histogram(value, min, max, nbuckets) AS alias` (returns `int[]`). */
  histogram(input: HistogramExprInput, alias: string): this {
    this.qb.addSelect(histogramExpr(input), alias);
    return this;
  }

  /**
   * Anchor on `time_bucket_gapfill(...)` — like {@link timeBucket} (replaces the
   * SELECT list, groups by the bucket), but emits empty buckets to be filled by
   * {@link locf}/{@link interpolate}. Bound the time column in `WHERE` (or pass
   * `start`/`finish`) or TimescaleDB rejects it.
   */
  timeBucketGapfill(
    input: TimeBucketGapfillExprInput,
    alias = 'bucket',
    options?: TimeBucketSelectOptions,
  ): this {
    const expr = timeBucketGapfillExpr(input);
    this.qb.select(expr, alias);
    if (options?.group !== false) {
      this.qb.addGroupBy(expr);
    }
    if (options?.order) {
      this.qb.addOrderBy(expr, options.order);
    }
    return this;
  }

  /** Add `locf(<agg>) AS alias` — carry the last value forward across gapfill gaps. */
  locf(metric: { fn: StandardAggregate; column?: string }, alias: string): this {
    this.qb.addSelect(locfExpr(standardAggregateExpr(metric.fn, metric.column)), alias);
    return this;
  }

  /** Add `interpolate(<agg>) AS alias` — linearly interpolate across gapfill gaps. */
  interpolate(metric: { fn: StandardAggregate; column?: string }, alias: string): this {
    this.qb.addSelect(interpolateExpr(standardAggregateExpr(metric.fn, metric.column)), alias);
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

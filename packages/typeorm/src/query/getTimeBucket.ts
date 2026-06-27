import type { ObjectLiteral, Repository } from 'typeorm';
import {
  firstExpr,
  lastExpr,
  safeIdent,
  timeBucketExpr,
  TimescaleError,
  TimescaleErrorCode,
} from '@blueprime/timescaledb-core';

/** Standard SQL aggregates supported by {@link getTimeBucket} (allow-listed). */
export type TimeBucketAggFn = 'avg' | 'sum' | 'min' | 'max' | 'count';

/** One rolled-up metric column in a {@link getTimeBucket} query. */
export interface TimeBucketMetric {
  /** Output column alias. */
  readonly alias: string;
  /** Aggregate to apply. `count` may omit `column` (→ `count(*)`). */
  readonly fn: TimeBucketAggFn | 'first' | 'last';
  /** Entity **property** name (resolved to its DB column). Required except `count` with no column. */
  readonly column?: string;
  /** For `first`/`last`: the time property; defaults to the bucket time column. */
  readonly timeColumn?: string;
}

export interface GetTimeBucketOptions {
  /** Bucket width, e.g. `'1 hour'`. */
  readonly interval: string;
  /** Time-column **property** name; defaults to the entity's `@TimeColumn`. */
  readonly timeColumn?: string;
  /** Metrics to aggregate per bucket. */
  readonly metrics: readonly TimeBucketMetric[];
  /** Inclusive-from / exclusive-to time bounds (bound as parameters). */
  readonly range?: { readonly from?: Date | string; readonly to?: Date | string };
  /** Alias for the bucket column. Default `'bucket'`. */
  readonly bucketAlias?: string;
  readonly timezone?: string;
  readonly origin?: string;
  readonly offset?: string;
  /** Order rows by bucket. Default unordered. */
  readonly order?: 'ASC' | 'DESC';
}

/** A raw time-bucket result row: the bucket plus each metric alias. */
export type TimeBucketRow = Record<string, unknown> & { readonly bucket: unknown };

const AGGREGATES: ReadonlySet<string> = new Set(['avg', 'sum', 'min', 'max', 'count']);

function metricExpression(
  metric: TimeBucketMetric,
  resolve: (property: string, role: string) => string,
  defaultTimeColumn: string,
): string {
  const role = `metric "${metric.alias}"`;
  if (metric.fn === 'first' || metric.fn === 'last') {
    if (!metric.column) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `${role}: ${metric.fn} requires a column`,
        { alias: metric.alias },
      );
    }
    const value = resolve(metric.column, `${role} column`);
    const time = metric.timeColumn
      ? resolve(metric.timeColumn, `${role} timeColumn`)
      : defaultTimeColumn;
    return metric.fn === 'first' ? firstExpr(value, time) : lastExpr(value, time);
  }
  if (!AGGREGATES.has(metric.fn)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role}: unsupported aggregate "${String(metric.fn)}"`,
      { alias: metric.alias, fn: String(metric.fn) },
    );
  }
  if (metric.fn === 'count' && !metric.column) {
    return 'count(*)';
  }
  if (!metric.column) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role}: ${metric.fn} requires a column`,
      { alias: metric.alias },
    );
  }
  // `fn` is allow-listed above; column flows through safeIdent.
  return `${metric.fn}(${safeIdent(resolve(metric.column, `${role} column`))})`;
}

/**
 * Typed `time_bucket` convenience over a hypertable repository.
 *
 * Resolves entity **property** names to their DB column names (so `@Column({ name })`
 * renames work), allow-lists aggregates and identifiers, and binds range bounds as
 * parameters. Returns raw rows — coerce values with the `result-mapper` helpers.
 *
 * `defaultTimeColumn` is the resolved DB time column from the entity's metadata.
 */
export function getTimeBucket<T extends ObjectLiteral>(
  repo: Repository<T>,
  defaultTimeColumn: string,
  options: GetTimeBucketOptions,
): Promise<TimeBucketRow[]> {
  const resolve = (property: string, role: string): string => {
    const column = repo.metadata.findColumnWithPropertyName(property);
    // Fall back to the given name (then core's safeIdent validates it); covers
    // callers passing a DB column name directly.
    void role;
    return column ? column.databaseName : property;
  };

  const timeColumn = options.timeColumn
    ? resolve(options.timeColumn, 'timeColumn')
    : defaultTimeColumn;
  if (!options.metrics.length) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'getTimeBucket requires at least one metric',
      {},
    );
  }

  const bucketExpr = timeBucketExpr({
    interval: options.interval,
    column: timeColumn,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });
  const bucketAlias = options.bucketAlias ?? 'bucket';

  const qb = repo.createQueryBuilder('e').select(bucketExpr, bucketAlias).groupBy(bucketExpr);
  for (const metric of options.metrics) {
    qb.addSelect(metricExpression(metric, resolve, timeColumn), metric.alias);
  }
  if (options.range?.from !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} >= :__tsFrom`, { __tsFrom: options.range.from });
  }
  if (options.range?.to !== undefined) {
    qb.andWhere(`${safeIdent(timeColumn)} < :__tsTo`, { __tsTo: options.range.to });
  }
  if (options.order) {
    qb.orderBy(bucketExpr, options.order);
  }

  return qb.getRawMany<TimeBucketRow>();
}

import type { ObjectLiteral, Repository } from 'typeorm';
import {
  firstExpr,
  interpolateExpr,
  lastExpr,
  locfExpr,
  safeIdent,
  assertSafeIdentifier,
  timeBucketExpr,
  timeBucketGapfillExpr,
  TimescaleError,
  TimescaleErrorCode,
} from '@blueprime/timescaledb-core';
import { standardAggregateExpr } from './aggregate.js';

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
  /**
   * Fill empty gapfill buckets for this metric: `locf` (carry last value forward)
   * or `interpolate` (linear). Requires `gapfill` on the query.
   */
  readonly fill?: 'locf' | 'interpolate';
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
  /**
   * Emit a row for every bucket in the range (via `time_bucket_gapfill`), including
   * empty ones — pair with a metric `fill`. Requires bounds: either `start`+`finish`
   * here, or `range.from`+`range.to`. Incompatible with `timezone`/`origin`/`offset`.
   */
  readonly gapfill?: { readonly start?: Date | string; readonly finish?: Date | string };
  /** Order rows by bucket. Defaults to `ASC` when gapfilling (required for locf/interpolate). */
  readonly order?: 'ASC' | 'DESC';
}

/** A raw time-bucket result row: the bucket plus each metric alias. */
export type TimeBucketRow = Record<string, unknown> & { readonly bucket: unknown };

function metricBaseExpr(
  metric: TimeBucketMetric,
  resolve: (property: string) => string,
  defaultTimeColumn: string,
): string {
  if (metric.fn === 'first' || metric.fn === 'last') {
    if (!metric.column) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `metric "${metric.alias}": ${metric.fn} requires a column`,
        { alias: metric.alias },
      );
    }
    const value = resolve(metric.column);
    const time = metric.timeColumn ? resolve(metric.timeColumn) : defaultTimeColumn;
    return metric.fn === 'first' ? firstExpr(value, time) : lastExpr(value, time);
  }
  // standard aggregate — fn allow-listed + column quoted by standardAggregateExpr.
  return standardAggregateExpr(metric.fn, metric.column ? resolve(metric.column) : undefined);
}

function metricExpression(
  metric: TimeBucketMetric,
  resolve: (property: string) => string,
  defaultTimeColumn: string,
): string {
  const base = metricBaseExpr(metric, resolve, defaultTimeColumn);
  if (metric.fill === 'locf') return locfExpr(base);
  if (metric.fill === 'interpolate') return interpolateExpr(base);
  return base;
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
  // Map an entity property name to its DB column; fall back to the given name
  // (core's safeIdent then validates it) so callers may pass a DB column directly.
  const resolve = (property: string): string =>
    repo.metadata.findColumnWithPropertyName(property)?.databaseName ?? property;

  const timeColumn = options.timeColumn ? resolve(options.timeColumn) : defaultTimeColumn;
  if (!options.metrics.length) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'getTimeBucket requires at least one metric',
      {},
    );
  }

  const gapfill = options.gapfill;
  const hasFill = options.metrics.some((m) => m.fill !== undefined);
  if (!gapfill && hasFill) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'metric `fill` (locf/interpolate) requires `gapfill` on the query',
      {},
    );
  }
  if (hasFill && options.order === 'DESC') {
    // locf/interpolate fill forward; DESC ordering would invert their semantics.
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'order: "DESC" is incompatible with locf/interpolate fills (they require ascending buckets)',
      {},
    );
  }
  // interpolate on a count produces fractional "counts" between buckets — almost
  // always a mistake. locf (carry the integer forward) is the sane fill for counts.
  const badInterp = options.metrics.find((m) => m.fill === 'interpolate' && m.fn === 'count');
  if (badInterp) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `metric "${badInterp.alias}": interpolate on a count yields fractional counts — use fill: 'locf' instead`,
      { alias: badInterp.alias },
    );
  }

  let bucketExpr: string;
  if (gapfill) {
    if (
      options.timezone !== undefined ||
      options.origin !== undefined ||
      options.offset !== undefined
    ) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        'gapfill is incompatible with timezone/origin/offset',
        {},
      );
    }
    const { start, finish } = gapfill;
    // A lone start/finish would be silently dropped below — fail loudly instead.
    if ((start === undefined) !== (finish === undefined)) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        'gapfill: pass BOTH start and finish, or neither (then range.from+range.to drive the bounds)',
        {},
      );
    }
    const hasExplicit = start !== undefined && finish !== undefined;
    const hasRange = options.range?.from !== undefined && options.range?.to !== undefined;
    if (!hasExplicit && !hasRange) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        'gapfill requires bounds: pass gapfill.start+finish, or range.from+range.to',
        {},
      );
    }
    // Reject an inverted window on the range-driven path too (the core builder only
    // sees the explicit start/finish form). Best-effort: parseable timestamps only.
    if (!hasExplicit && hasRange) {
      const f = Date.parse(String(options.range?.from));
      const t = Date.parse(String(options.range?.to));
      if (!Number.isNaN(f) && !Number.isNaN(t) && t <= f) {
        throw new TimescaleError(
          TimescaleErrorCode.INVALID_ARGUMENT,
          `gapfill: range.to (${String(options.range?.to)}) must be after range.from (${String(options.range?.from)})`,
          {},
        );
      }
    }
    const tsLit = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v);
    bucketExpr = timeBucketGapfillExpr({
      interval: options.interval,
      column: timeColumn,
      ...(start !== undefined && finish !== undefined
        ? { start: tsLit(start), finish: tsLit(finish) }
        : {}),
    });
  } else {
    bucketExpr = timeBucketExpr({
      interval: options.interval,
      column: timeColumn,
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });
  }
  // Output aliases are caller-supplied and land in the SELECT list. TypeORM 0.3.x's Postgres driver
  // quotes an alias WITHOUT escaping embedded double quotes, so an unvalidated alias containing `"`
  // breaks out of the quoting and injects arbitrary select-list SQL. Validate through the same
  // allow-list every other identifier in this layer already uses.
  const bucketAlias = assertSafeIdentifier(options.bucketAlias ?? 'bucket', 'bucketAlias');

  // Postgres allows duplicate output column names, but a row object can only keep ONE — the last
  // wins, silently discarding the other column (a metric aliased `bucket` erases the time axis; two
  // metrics sharing an alias plot the wrong series). Reject it instead of returning wrong data.
  const seenAliases = new Set<string>([bucketAlias]);
  for (const metric of options.metrics) {
    const alias = assertSafeIdentifier(metric.alias, 'metric alias');
    if (seenAliases.has(alias)) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `duplicate output alias "${alias}" — the bucket alias and every metric alias must be distinct, ` +
          `otherwise one column silently overwrites the other in the result rows`,
        { alias },
      );
    }
    seenAliases.add(alias);
  }

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
  // gapfill's start/finish set the OUTPUT range but do NOT filter input rows — without
  // a matching WHERE, data from earlier/later buckets still aggregates in. Add the
  // bounds so the typed API is correct-by-default (range bounds above cover that case).
  if (gapfill?.start !== undefined && gapfill.finish !== undefined) {
    qb.andWhere(
      `${safeIdent(timeColumn)} >= :__gfStart AND ${safeIdent(timeColumn)} < :__gfFinish`,
      {
        __gfStart: gapfill.start,
        __gfFinish: gapfill.finish,
      },
    );
  }
  // gapfill needs buckets in ascending time order for locf/interpolate to fill correctly.
  const order = options.order ?? (gapfill ? 'ASC' : undefined);
  if (order) {
    qb.orderBy(bucketExpr, order);
  }

  return qb.getRawMany<TimeBucketRow>();
}

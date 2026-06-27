import type { DataSource, EntityTarget, ObjectLiteral, Repository } from 'typeorm';
import {
  TimescaleError,
  TimescaleErrorCode,
  validateHypertableMetadata,
} from '@blueprime/timescaledb-core';
import type { DriftItem, TimescaleEntityMetadata } from '@blueprime/timescaledb-core';
import { getTimescaleMetadata } from '../decorators/index.js';
import { TimescaleQueryBuilder } from '../query/TimescaleQueryBuilder.js';
import {
  getTimeBucket,
  type GetTimeBucketOptions,
  type TimeBucketRow,
} from '../query/getTimeBucket.js';
import {
  approxCountDistinct,
  getCandlesticks,
  type ApproxCountDistinctOptions,
  type Candle,
  type GetCandlesticksOptions,
} from '../query/toolkit.js';
import { assertSchema, type AssertSchemaOptions } from './assertSchema.js';

/** A TypeORM repository augmented (per instance) with its validated hypertable metadata. */
export interface TimescaleRepository<T extends ObjectLiteral> extends Repository<T> {
  /** Validated hypertable metadata for this entity. */
  readonly timescaleMetadata: TimescaleEntityMetadata;
  /**
   * A fluent {@link TimescaleQueryBuilder} over this repository for ad-hoc
   * hyperfunction queries (raw-identifier tier).
   */
  timescaleQueryBuilder(alias?: string): TimescaleQueryBuilder<T>;
  /**
   * Typed `time_bucket` convenience: aggregate rows into time buckets. Resolves
   * entity property names to DB columns; returns raw rows (coerce with the
   * `result-mapper` helpers).
   */
  getTimeBucket(options: GetTimeBucketOptions): Promise<TimeBucketRow[]>;
  /**
   * Typed OHLCV candlesticks (`candlestick_agg`). Requires `timescaledb_toolkit`
   * (throws `TSDB_TOOLKIT_MISSING` if absent).
   */
  getCandlesticks(options: GetCandlesticksOptions): Promise<Candle[]>;
  /**
   * Approximate distinct count via toolkit HyperLogLog
   * (`distinct_count(approx_count_distinct(col))`), returned as a string. Requires
   * `timescaledb_toolkit` (throws `TSDB_TOOLKIT_MISSING` if absent).
   */
  approxCountDistinct(options: ApproxCountDistinctOptions): Promise<string>;
}

/** A DataSource-scoped TimescaleDB context. Bound to ONE DataSource — never global. */
export interface TimescaleContext {
  readonly dataSource: DataSource;
  /** Get a hypertable repository. Throws if the entity is not a `@Hypertable`. */
  getRepository<T extends ObjectLiteral>(entity: EntityTarget<T>): TimescaleRepository<T>;
  /**
   * Verify the live database matches the `@Hypertable` entities on this DataSource.
   * Throws `TimescaleError(SCHEMA_DRIFT)` on drift (`mode: 'assert'`, default) or
   * logs and returns it (`mode: 'warn'`). Returns `[]` when in sync.
   */
  assertSchema(options?: AssertSchemaOptions): Promise<DriftItem[]>;
}

/**
 * Create a TimescaleDB context scoped to a single `DataSource`.
 *
 * This is the structural fix for the predecessor's fatal bug: there is NO global
 * state and NO prototype mutation. Repositories are augmented **per instance**
 * (`Object.assign` on the returned repository), so importing or using this package
 * can never alter `DataSource.prototype` / `Repository.prototype`, and two
 * DataSources in one process stay fully isolated.
 */
export function createTimescale(dataSource: DataSource): TimescaleContext {
  return {
    dataSource,
    getRepository<T extends ObjectLiteral>(entity: EntityTarget<T>): TimescaleRepository<T> {
      if (typeof entity !== 'function') {
        throw new TimescaleError(
          TimescaleErrorCode.INVALID_ARGUMENT,
          'getRepository requires the entity CLASS (so its @Hypertable metadata can be resolved), not a name or schema',
          { entity: String(entity) },
        );
      }
      const ctor = entity as (abstract new (...args: never[]) => unknown) & {
        readonly name: string;
      };
      const meta = getTimescaleMetadata(ctor);
      if (!meta) {
        throw new TimescaleError(
          TimescaleErrorCode.NOT_A_HYPERTABLE,
          `${ctor.name} is not a @Hypertable entity — decorate it with @Hypertable() to use a Timescale repository`,
          { entity: ctor.name },
        );
      }
      validateHypertableMetadata(meta, ctor.name);

      const repo = dataSource.getRepository<T>(entity);
      // validateHypertableMetadata guarantees a time column exists (from @TimeColumn
      // or options.timeColumn) — resolve it for the time_bucket convenience.
      const timeColumn = meta.timeColumn ?? meta.options.timeColumn;
      if (timeColumn === undefined) {
        throw new TimescaleError(
          TimescaleErrorCode.NO_TIME_COLUMN,
          `${ctor.name} has no resolvable time column`,
          { entity: ctor.name },
        );
      }
      // Augment a DELEGATING wrapper (Object.create), NOT the repository itself.
      // `dataSource.getRepository()` returns a cached singleton, so mutating it with
      // Object.assign would leak `getTimeBucket`/`timescaleMetadata` onto every later
      // plain `getRepository(Entity)`. Object.create keeps the cached repo untouched
      // (the wrapper inherits its methods via the prototype chain) — and we still
      // never touch Repository.prototype.
      const augmented = Object.create(repo) as TimescaleRepository<T>;
      return Object.assign(augmented, {
        timescaleMetadata: meta,
        timescaleQueryBuilder(alias = 'e'): TimescaleQueryBuilder<T> {
          return new TimescaleQueryBuilder<T>(repo.createQueryBuilder(alias));
        },
        getTimeBucket(options: GetTimeBucketOptions): Promise<TimeBucketRow[]> {
          return getTimeBucket(repo, timeColumn, options);
        },
        getCandlesticks(options: GetCandlesticksOptions): Promise<Candle[]> {
          return getCandlesticks(repo, timeColumn, options);
        },
        approxCountDistinct(options: ApproxCountDistinctOptions): Promise<string> {
          return approxCountDistinct(repo, timeColumn, options);
        },
      });
    },
    assertSchema(options?: AssertSchemaOptions): Promise<DriftItem[]> {
      return assertSchema(dataSource, options);
    },
  };
}

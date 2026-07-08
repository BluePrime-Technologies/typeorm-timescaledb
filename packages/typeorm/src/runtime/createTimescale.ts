import type { DataSource, EntityTarget, ObjectLiteral, Repository } from 'typeorm';
import {
  refreshContinuousAggregateSQL,
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
  getCounterAgg,
  getPercentileRanks,
  getPercentiles,
  getRegression,
  getDeadRanges,
  getHeartbeatHealth,
  getLiveRanges,
  getMostCommonValues,
  getStateAt,
  getStateDurations,
  getStatePeriods,
  getStateTimeline,
  getStats,
  getTimeWeight,
  getTopN,
  isLiveAt,
  type ApproxCountDistinctOptions,
  type Candle,
  type CounterSummary,
  type GetCandlesticksOptions,
  type GetCounterAggOptions,
  type GetPercentileRanksOptions,
  type GetPercentilesOptions,
  type GetRegressionOptions,
  type GetStateAtOptions,
  type GetStateDurationsOptions,
  type GetStatePeriodsOptions,
  type GetStateTimelineOptions,
  type GetStatsOptions,
  type GetTimeWeightOptions,
  type GetTopNOptions,
  type GetMostCommonValuesOptions,
  type HeartbeatHealth,
  type HeartbeatWindow,
  type IsLiveAtOptions,
  type MostCommonValue,
  type PercentileResult,
  type Period,
  type Regression,
  type StateDuration,
  type StateInterval,
  type StatsSummary,
  type TimeWeight,
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
  /**
   * Typed 1D statistics (`stats_agg`) — average/sum and sample/population moments.
   * `null` when the set is empty. Requires `timescaledb_toolkit`.
   */
  getStats(options: GetStatsOptions): Promise<StatsSummary | null>;
  /**
   * Typed 2D linear regression (`stats_agg(y, x)`) — slope/intercept/correlation/R².
   * `null` when the set is empty. Requires `timescaledb_toolkit`.
   */
  getRegression(options: GetRegressionOptions): Promise<Regression | null>;
  /**
   * Typed approximate percentiles (`percentile_agg`, uddsketch). `null` when the set
   * is empty. Requires `timescaledb_toolkit`.
   */
  getPercentiles(options: GetPercentilesOptions): Promise<PercentileResult | null>;
  /**
   * Typed approximate percentile ranks (`approx_percentile_rank`). `null` when the set
   * is empty. Requires `timescaledb_toolkit`.
   */
  getPercentileRanks(options: GetPercentileRanksOptions): Promise<number[] | null>;
  /**
   * Typed `counter_agg` summary (delta/rate/resets for a monotonic counter). `null`
   * when the set is empty. Requires `timescaledb_toolkit`.
   */
  getCounterAgg(options: GetCounterAggOptions): Promise<CounterSummary | null>;
  /**
   * Typed `time_weight` summary (time-weighted average + integral). `null` when the
   * set is empty. Requires `timescaledb_toolkit`.
   */
  getTimeWeight(options: GetTimeWeightOptions): Promise<TimeWeight | null>;
  /**
   * Time spent in each state (`state_agg` + `into_values`), in seconds. Requires
   * `timescaledb_toolkit`.
   */
  getStateDurations(options: GetStateDurationsOptions): Promise<StateDuration[]>;
  /**
   * Ordered timeline of state intervals (`state_agg` + `state_timeline`). Requires
   * `timescaledb_toolkit`.
   */
  getStateTimeline(options: GetStateTimelineOptions): Promise<StateInterval[]>;
  /**
   * The state in effect at a given instant (`state_agg` + `state_at`). `null` when out
   * of range / empty. Requires `timescaledb_toolkit`.
   */
  getStateAt(options: GetStateAtOptions): Promise<string | null>;
  /**
   * The periods during which a given state was in effect (`state_agg` +
   * `state_periods`). Requires `timescaledb_toolkit`.
   */
  getStatePeriods(options: GetStatePeriodsOptions): Promise<Period[]>;
  /**
   * The most common values with estimated frequency bounds (`mcv_agg` + `into_values`).
   * Requires `timescaledb_toolkit`.
   */
  getMostCommonValues(options: GetMostCommonValuesOptions): Promise<MostCommonValue[]>;
  /**
   * The top `n` most common values (`mcv_agg` + `topn`). Requires `timescaledb_toolkit`.
   */
  getTopN(options: GetTopNOptions): Promise<string[]>;
  /**
   * Liveness/uptime summary over a window (`heartbeat_agg`). `null` when there are no
   * heartbeats in the window. Requires `timescaledb_toolkit`.
   */
  getHeartbeatHealth(options: HeartbeatWindow): Promise<HeartbeatHealth | null>;
  /** The live `[startTime, endTime)` ranges (`heartbeat_agg` + `live_ranges`). */
  getLiveRanges(options: HeartbeatWindow): Promise<Period[]>;
  /** The dead `[startTime, endTime)` ranges (`heartbeat_agg` + `dead_ranges`). */
  getDeadRanges(options: HeartbeatWindow): Promise<Period[]>;
  /**
   * Whether the system was live at `at` (`heartbeat_agg` + `live_at`). `null` when there
   * are no heartbeats in the window. Requires `timescaledb_toolkit`.
   */
  isLiveAt(options: IsLiveAtOptions): Promise<boolean | null>;
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
  /**
   * Refresh a continuous aggregate over `[start, end)` (both optional → open bound /
   * full refresh) via `refresh_continuous_aggregate`. Runs **standalone** (this
   * procedure cannot run inside a transaction block). `view` is the CAGG name,
   * optionally `schema.view`.
   *
   * Note: it executes on its own pooled connection via `dataSource.query()`, so it is
   * NOT enrolled in any surrounding `dataSource.transaction(...)` callback — the refresh
   * commits independently and is not undone if that outer transaction later rolls back
   * (by necessity: the refresh cannot run inside a transaction). Call it outside a txn.
   */
  refreshContinuousAggregate(
    view: string,
    options?: { readonly start?: Date | string; readonly end?: Date | string },
  ): Promise<void>;
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
        getStats(options: GetStatsOptions): Promise<StatsSummary | null> {
          return getStats(repo, timeColumn, options);
        },
        getRegression(options: GetRegressionOptions): Promise<Regression | null> {
          return getRegression(repo, timeColumn, options);
        },
        getPercentiles(options: GetPercentilesOptions): Promise<PercentileResult | null> {
          return getPercentiles(repo, timeColumn, options);
        },
        getPercentileRanks(options: GetPercentileRanksOptions): Promise<number[] | null> {
          return getPercentileRanks(repo, timeColumn, options);
        },
        getCounterAgg(options: GetCounterAggOptions): Promise<CounterSummary | null> {
          return getCounterAgg(repo, timeColumn, options);
        },
        getTimeWeight(options: GetTimeWeightOptions): Promise<TimeWeight | null> {
          return getTimeWeight(repo, timeColumn, options);
        },
        getStateDurations(options: GetStateDurationsOptions): Promise<StateDuration[]> {
          return getStateDurations(repo, timeColumn, options);
        },
        getStateTimeline(options: GetStateTimelineOptions): Promise<StateInterval[]> {
          return getStateTimeline(repo, timeColumn, options);
        },
        getStateAt(options: GetStateAtOptions): Promise<string | null> {
          return getStateAt(repo, timeColumn, options);
        },
        getStatePeriods(options: GetStatePeriodsOptions): Promise<Period[]> {
          return getStatePeriods(repo, timeColumn, options);
        },
        getMostCommonValues(options: GetMostCommonValuesOptions): Promise<MostCommonValue[]> {
          return getMostCommonValues(repo, timeColumn, options);
        },
        getTopN(options: GetTopNOptions): Promise<string[]> {
          return getTopN(repo, timeColumn, options);
        },
        getHeartbeatHealth(options: HeartbeatWindow): Promise<HeartbeatHealth | null> {
          return getHeartbeatHealth(repo, timeColumn, options);
        },
        getLiveRanges(options: HeartbeatWindow): Promise<Period[]> {
          return getLiveRanges(repo, timeColumn, options);
        },
        getDeadRanges(options: HeartbeatWindow): Promise<Period[]> {
          return getDeadRanges(repo, timeColumn, options);
        },
        isLiveAt(options: IsLiveAtOptions): Promise<boolean | null> {
          return isLiveAt(repo, timeColumn, options);
        },
      });
    },
    assertSchema(options?: AssertSchemaOptions): Promise<DriftItem[]> {
      return assertSchema(dataSource, options);
    },
    async refreshContinuousAggregate(
      view: string,
      options?: { readonly start?: Date | string; readonly end?: Date | string },
    ): Promise<void> {
      // Bind start/end positionally only when provided; an omitted bound is NULL (open).
      const params: unknown[] = [];
      const startToken = options?.start != null ? `$${params.push(options.start)}` : 'NULL';
      const endToken = options?.end != null ? `$${params.push(options.end)}` : 'NULL';
      // Plain query() runs on a pooled connection in autocommit (no BEGIN/COMMIT), which
      // is required — refresh_continuous_aggregate() cannot run inside a transaction block.
      await dataSource.query(refreshContinuousAggregateSQL(view, startToken, endToken), params);
    },
  };
}

/**
 * typeorm-timescaledb — a multi-DataSource-safe TimescaleDB integration for TypeORM.
 *
 * Hypertable metadata is declared with decorators that write only to a
 * module-private WeakMap — never a prototype, never TypeORM's global metadata.
 */
// Unified schema DSL — TypeORM's modeling surface, re-exported so users import only from here.
export * from './orm.js';

export { Hypertable, TimeColumn, HypertablePrimaryKey } from './decorators/index.js';
export {
  ContinuousAggregate,
  BucketColumn,
  GroupColumn,
  AggregateColumn,
} from './decorators/index.js';
export type {
  ContinuousAggregateOptions,
  AggregateColumnOptions,
  RefreshPolicyOptions,
} from './decorators/index.js';
export { getTimescaleMetadata, hasTimescaleMetadata } from './decorators/index.js';
export { getContinuousAggregateMeta, hasContinuousAggregateMeta } from './decorators/index.js';
export type {
  ContinuousAggregateMeta,
  CaggAggregate,
  CaggRefreshPolicy,
} from './decorators/index.js';
export { createTimescale } from './runtime/createTimescale.js';
export type { TimescaleContext, TimescaleRepository } from './runtime/createTimescale.js';

// Query layer (M2): hyperfunctions via a per-instance QueryBuilder wrapper + typed
// raw-result coercion helpers. No prototype mutation.
export { TimescaleQueryBuilder } from './query/TimescaleQueryBuilder.js';
export type { TimeBucketSelectOptions } from './query/TimescaleQueryBuilder.js';
export type {
  GetTimeBucketOptions,
  TimeBucketMetric,
  TimeBucketAggFn,
  TimeBucketRow,
} from './query/getTimeBucket.js';
export type { StandardAggregate } from './query/aggregate.js';
export { assertToolkit } from './query/toolkit.js';
export type {
  Candle,
  GetCandlesticksOptions,
  ApproxCountDistinctOptions,
  TimeRange,
  GetStatsOptions,
  StatsSummary,
  GetRegressionOptions,
  Regression,
  GetPercentilesOptions,
  PercentileResult,
  GetPercentileRanksOptions,
  GetCounterAggOptions,
  CounterSummary,
  GetTimeWeightOptions,
  TimeWeight,
  GetStateDurationsOptions,
  StateDuration,
  GetStateTimelineOptions,
  StateInterval,
  GetStateAtOptions,
  GetStatePeriodsOptions,
  Period,
  GetMostCommonValuesOptions,
  MostCommonValue,
  GetTopNOptions,
  HeartbeatWindow,
  HeartbeatHealth,
  IsLiveAtOptions,
} from './query/toolkit.js';
export {
  toNumber,
  toNumberOrNull,
  toBigIntString,
  toDate,
  toNumberArray,
  mapRawRows,
} from './query/result-mapper.js';

export { assertSchema } from './runtime/assertSchema.js';
export type { AssertSchemaOptions } from './runtime/assertSchema.js';

// Migration generation — Django/Prisma-style codegen from @Hypertable metadata.
export {
  generateTimescaleMigration,
  renderTimescaleMigration,
  createTimescaleMigration,
} from './migrations/index.js';
export type { GeneratedMigration, GenerateMigrationOptions } from './migrations/index.js';

// NOTE: `./cli/*` is intentionally NOT re-exported here — it is the `typeorm-timescaledb`
// bin entrypoint, not part of the importable library surface (keeps the executable out
// of the tree-shakeable graph). The `cli/index.ts` barrel exists for tests only.

// Re-export the core metadata model + validation so consumers need one import.
export {
  validateHypertableMetadata,
  parseHypertableOptions,
  createContinuousAggregateSQL,
  refreshContinuousAggregateSQL,
  addContinuousAggregatePolicySQL,
  TimescaleError,
  TimescaleErrorCode,
} from '@blueprime/timescaledb-core';
export type {
  HypertableOptions,
  ColumnstoreOptions,
  RetentionOptions,
  SpacePartitionOptions,
  TimescaleEntityMetadata,
  DriftItem,
  StatsMethod,
  TimeWeightMethod,
  IntegralUnit,
  CreateContinuousAggregateInput,
  ContinuousAggregateColumn,
  ContinuousAggregateFn,
  ContinuousAggregatePolicyInput,
} from '@blueprime/timescaledb-core';

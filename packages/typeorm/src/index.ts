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
export type {
  HypertableInfo,
  ChunkInfo,
  ContinuousAggregateInfo,
  JobInfo,
  JobStats,
  ListChunksOptions,
  ListJobsOptions,
  AddJobOptions,
  AlterJobChanges,
} from './runtime/info.js';

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
  DownsampleOptions,
  DownsampledPoint,
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
  TDigestResult,
  GetTDigestPercentilesOptions,
  GetTDigestPercentileRanksOptions,
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

// Live-DB introspection (M4.0) — reduce a running TimescaleDB to the canonical SchemaStateIR.
export { introspect } from './runtime/introspect.js';
export type { IntrospectOptions } from './runtime/introspect.js';
// Desired-state compiler (M4.2) — reduce the `@Hypertable` decorators to the same SchemaStateIR,
// so the diff engine can compare desired (this) vs current (introspect()).
export { compileDesiredState } from './runtime/desired-state.js';
// Rename resolution (M4.2 S4) — `@Hypertable({ renamedFrom })` → the map `diffSchemaState` consumes
// so a renamed hypertable diffs to a single `renameHypertable` op, not drop-then-create.
export { collectRenames } from './runtime/renames.js';
// Direct-sync engine (M4.3c) — apply a typed Plan straight to a live DB, guarded + transactional.
export { applyDirect } from './runtime/apply.js';
// The `push` verb's programmatic form: introspect -> diff -> (optionally) apply, preview by default.
export { pushSchema } from './runtime/push.js';
export type { PushOptions, PushResult } from './runtime/push.js';
// The `pull` verb (M4.4b) — reproduce a live database's TimescaleDB layer as a migration. Read-only.
export { pullSchema, formatPullCoverage, PULL_BASE_DDL_CAVEAT } from './runtime/pull.js';
// Recompression planner (M4.4) — applies a changed columnstore layout to ALREADY-compressed chunks,
// which an ALTER alone does not touch. Guarded and resumable.
export {
  planRecompression,
  applyRecompression,
  formatRecompressionPlan,
} from './runtime/recompress.js';
export type {
  RecompressionPlan,
  RecompressionResult,
  RecompressionPrecision,
  RecompressionProgress,
  ApplyRecompressionOptions,
  StaleChunk,
} from './runtime/recompress.js';
export type { PullOptions, PullResult, PullCoverage } from './runtime/pull.js';
export type { ApplyDirection, ApplyDirectOptions, ApplyDirectResult } from './runtime/apply.js';

// Migration generation — Django/Prisma-style codegen from @Hypertable metadata.
export {
  generateTimescaleMigration,
  planToMigration,
  renderTimescaleMigration,
  renderTimescaleMigrationSql,
  createTimescaleMigration,
} from './migrations/index.js';
export type {
  GeneratedMigration,
  GenerateMigrationOptions,
  PlanMigrationOptions,
} from './migrations/index.js';
export { TimescaleSchemaBuilder } from './migrations/index.js';

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

// Static plan linter + the pass-through fragment guard. All three landed in the core in 0.7.0 and
// were listed under "Added" in the 0.7.0 changelog, but they were only ever reachable from
// `@blueprime/timescaledb-core` — a transitive dependency consumers do not declare. Re-exported here
// so they resolve from the package you actually install (see #222). `assertSafeFragment` especially
// is a security helper (it guards hand-built aggregate fragments), so reaching it only via an
// undeclared dependency was the least acceptable gap.
export {
  lintPlan,
  formatLintFindings,
  assertSafeFragment,
  // `ANALYZERS` completes the linter surface (#228). It was left behind by the first pass, which
  // split `docs/migration-guide.md`'s single import across two packages — `lintPlan` and
  // `formatLintFindings` resolved here while `ANALYZERS`, on the same line, did not. It is
  // deliberately public: "an analyzer suite whose contents are opaque invites you to assume a check
  // exists that does not".
  ANALYZERS,
  // Half of the documented preview-vs-converged idiom, whose other half (`pushSchema`) is already
  // exported from this package. `PushResult.applied === false` covers both "preview" and "already
  // converged"; `isEmptyPlan(plan)` is what tells them apart.
  isEmptyPlan,
} from '@blueprime/timescaledb-core';
// `lintPlan(plan)` runs over a `Plan` — the same object carried by `PushResult.plan` — and returns
// `LintFinding[]`; re-export those types so the linter surface is usable without a second import
// from core.
//
// `Plan`'s own member types come with it, or a caller can hold a `Plan` without being able to name
// what is inside it:
//   interface Plan { steps: readonly PlanStep[]; advisories?: readonly PlanAdvisory[] }
// `PlanAdvisory` is the load-bearing one — since structural CAGG diffing landed, a
// `not-expressible` advisory is what makes `check` exit 2, so any deploy gate that inspects
// `plan.advisories` needs to name it.
export type {
  LintFinding,
  LintSeverity,
  Analyzer,
  Plan,
  PlanStep,
  PlanAdvisory,
} from '@blueprime/timescaledb-core';

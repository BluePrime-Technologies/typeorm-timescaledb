export { assertSafeIdentifier, quoteIdent, quoteQualified, safeIdent } from './identifier.js';
export { quoteLiteral } from './literal.js';
export { assertInterval, assertPositiveInterval, INTERVAL_PATTERN } from './interval.js';
export { TimescaleError, TimescaleErrorCode } from './errors.js';
export { TIMESCALEDB_PRESENCE_SQL } from './sql/index.js';
export {
  createHypertableSQL,
  addColumnstorePolicySQL,
  addRetentionPolicySQL,
  addCompressionPolicySQL,
  alterCompressionPolicySQL,
  alterRetentionPolicySQL,
  renameHypertableSQL,
  setChunkIntervalSQL,
  alterColumnstoreConfigSQL,
  removeRetentionPolicySQL,
  removeCompressionPolicySQL,
  createContinuousAggregateSQL,
  renderContinuousAggregateSelect,
  refreshContinuousAggregateSQL,
  addContinuousAggregatePolicySQL,
} from './sql/index.js';
export type {
  MigrationStatement,
  CreateHypertableInput,
  ColumnstorePolicyInput,
  RetentionPolicyInput,
  AddCompressionPolicyInput,
  AlterPolicyInput,
  RenameTableInput,
  SetChunkIntervalInput,
  AlterColumnstoreConfigInput,
  RemovePolicyInput,
  ColumnstoreConfig,
  CreateContinuousAggregateInput,
  ContinuousAggregateColumn,
  ContinuousAggregateFn,
  ContinuousAggregatePolicyInput,
} from './sql/index.js';
export {
  timeBucketExpr,
  firstExpr,
  lastExpr,
  histogramExpr,
  timeBucketGapfillExpr,
  locfExpr,
  interpolateExpr,
} from './sql/index.js';
export type {
  TimeBucketExprInput,
  HistogramExprInput,
  TimeBucketGapfillExprInput,
} from './sql/index.js';
export {
  TOOLKIT_PRESENCE_SQL,
  candlestickAggExpr,
  candlestickAccessorExpr,
  approxCountDistinctAggExpr,
  distinctCountExpr,
  statsAgg1DExpr,
  statsAgg2DExpr,
  statsAccessor1DExpr,
  statsAccessor2DExpr,
  percentileAggExpr,
  approxPercentileExpr,
  approxPercentileRankExpr,
  percentileSketchAccessorExpr,
  counterAggExpr,
  counterAccessorExpr,
  timeWeightAggExpr,
  timeWeightAccessorExpr,
  timeWeightIntegralExpr,
  stateAggExpr,
  stateIntoValuesExpr,
  stateTimelineExpr,
  statePeriodsExpr,
  stateAtExpr,
  mcvAggExpr,
  mcvIntoValuesExpr,
  mcvTopNExpr,
  mcvMaxFrequencyExpr,
  mcvMinFrequencyExpr,
  heartbeatAggExpr,
  heartbeatAccessorExpr,
  heartbeatLiveAtExpr,
  heartbeatLiveRangesExpr,
  heartbeatDeadRangesExpr,
  lttbExpr,
  asapSmoothExpr,
  tdigestExpr,
  tdigestAccessorExpr,
} from './sql/index.js';
export type {
  CandlestickAccessor,
  StatsMethod,
  Stats1DAccessor,
  Stats2DAccessor,
  PercentileSketchAccessor,
  TDigestAccessor,
  CounterAccessor,
  TimeWeightMethod,
  TimeWeightAccessor,
  IntegralUnit,
  HeartbeatAccessor,
} from './sql/index.js';
export { compareHypertable, compareContinuousAggregate, formatDrift } from './drift.js';
export type {
  ExpectedHypertable,
  ActualHypertable,
  DriftItem,
  ExpectedContinuousAggregate,
  ActualContinuousAggregate,
} from './drift.js';
export {
  parseHypertableOptions,
  validateHypertableMetadata,
  HypertableOptionsSchema,
  ColumnstoreOptionsSchema,
  RetentionOptionsSchema,
  SpacePartitionOptionsSchema,
} from './metadata.js';
export type {
  HypertableOptions,
  ColumnstoreOptions,
  RetentionOptions,
  SpacePartitionOptions,
  TimescaleEntityMetadata,
} from './metadata.js';
export type {
  SchemaStateIR,
  HypertableState,
  DimensionState,
  ColumnstoreState,
  OrderByElement,
  PolicyState,
  CompressionOrRetentionPolicy,
  RefreshPolicy,
  UnmanagedPolicy,
  ContinuousAggregateState,
  IntervalOrInt,
} from './schema-state.js';
export {
  canonicalizeInterval,
  intervalsEqual,
  assertParsableInterval,
  parsePolicyConfig,
  policiesEqual,
  normalizeCaggDefinition,
  caggDefinitionsEqual,
  caggComparable,
  TIMESCALE_DEFAULTS,
} from './normalize.js';
export { compileOperation, compileOperations } from './operation.js';
export type {
  Operation,
  OperationKind,
  CreateHypertableOperation,
  AddColumnstorePolicyOperation,
  AddRetentionPolicyOperation,
  CreateContinuousAggregateOperation,
  AddContinuousAggregatePolicyOperation,
  AddCompressionPolicyOperation,
  AlterCompressionPolicyOperation,
  AlterRetentionPolicyOperation,
  RenameHypertableOperation,
  SetChunkIntervalOperation,
  AlterColumnstoreConfigOperation,
  RemoveRetentionPolicyOperation,
  RemoveCompressionPolicyOperation,
} from './operation.js';
export { diffSchemaState, isEmptyPlan, compilePlan } from './diff.js';
export type { Plan, PlanStep, PlanAdvisory, DiffOptions, CompiledPlan } from './diff.js';
export { classifyOperation } from './safety.js';
// Static linter (M4.4) — plan-level destructive + lock analysis. INFORMS; does not block.
export { lintPlan, formatLintFindings, ANALYZERS } from './lint.js';
export type { LintFinding, LintSeverity, Analyzer } from './lint.js';
export type { SafetyClass, OperationSafety } from './safety.js';
// Reproduce (M4.4b) — a live SchemaStateIR back into the operations that recreate it, for `pull`.
export { stateToOperations } from './reproduce.js';
export type { ReproduceResult, SkippedObject, SkipReason, SkippedFacet } from './reproduce.js';

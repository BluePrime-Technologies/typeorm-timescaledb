# API reference

This page summarizes the public API exported by `typeorm-timescaledb` in the
current pre-1.0 release line. The source of truth remains the package exports in
`packages/typeorm/src/index.ts` and `packages/typeorm/src/nestjs`.

## Import paths

Most users import from the package root:

```ts
import {
  Column,
  DataSource,
  Entity,
  Hypertable,
  HypertablePrimaryKey,
  PrimaryColumn,
  TimeColumn,
  createTimescale,
} from 'typeorm-timescaledb';
```

NestJS helpers are exported from the NestJS subpath:

```ts
import { TimescaleModule } from 'typeorm-timescaledb/nestjs';
```

Low-level SQL builder functions are exported by the core package:

```ts
import { statsAgg1DExpr } from '@blueprime/timescaledb-core';
```

## TypeORM re-exports

`typeorm-timescaledb` re-exports TypeORM's modeling surface so users can keep one
import path for the entity definitions used by this package. Common re-exports
include `DataSource`, `Entity`, `Column`, `PrimaryColumn`, and TypeORM
symbols/types exported by `packages/typeorm/src/orm.ts`.

The package does not globally mutate TypeORM. TypeORM still owns base table
creation and normal TypeORM migration behavior.

## Decorators and metadata helpers

- `Hypertable(options)` — declares TimescaleDB hypertable metadata for a TypeORM
  entity.
- `TimeColumn()` — marks the entity property used as the hypertable time
  dimension.
- `HypertablePrimaryKey()` — records primary-key columns that must include every
  partitioning column.
- `getTimescaleMetadata(target)` — returns stored TimescaleDB metadata for a
  decorated entity class, or `undefined`.
- `hasTimescaleMetadata(target)` — returns whether a class has `@Hypertable`
  metadata.

### Continuous aggregate decorators (0.4.0)

A continuous aggregate (CAGG) is declared on its own class — **not** a TypeORM
`@Entity`, since a CAGG is a materialized view, not a table:

- `ContinuousAggregate(options)` — class decorator declaring a CAGG.
  `options.name` is the view name (optionally `schema.view`); `options.source`
  is the `@Hypertable` entity (or another `@ContinuousAggregate` class, for a
  hierarchical CAGG) it aggregates; `options.bucket` is the bucket width (e.g.
  `'1 hour'`). Optional: `materializedOnly` (default `false` — real-time
  aggregation on), `timeColumn` (defaults to the source's `@TimeColumn`), and
  `refresh` (a `RefreshPolicyOptions` — `startOffset`, `endOffset`, and
  optional `scheduleInterval`, defaulting to the bucket width).
- `BucketColumn()` — property decorator marking the CAGG's `time_bucket(...)`
  output column.
- `GroupColumn()` — property decorator marking an extra `GROUP BY` key. Its
  output name is the **source column's physical name**, not the CAGG property
  name (unlike `@BucketColumn`/`@AggregateColumn`, whose output names are the
  property verbatim).
- `AggregateColumn(options)` — property decorator marking an aggregate output
  column. `options.fn` is an allow-listed aggregate function; `options.column`
  is the source property to aggregate (omit only for `fn: 'count'`).
- `getContinuousAggregateMeta(target)` / `hasContinuousAggregateMeta(target)` —
  metadata accessors mirroring `getTimescaleMetadata`/`hasTimescaleMetadata`
  for CAGG classes.

## Runtime context

### `createTimescale(dataSource)`

Creates a DataSource-scoped TimescaleDB context.

```ts
await AppDataSource.initialize();

const ts = createTimescale(AppDataSource);
const readings = ts.getRepository(Reading);
```

### `TimescaleContext`

```ts
interface TimescaleContext {
  readonly dataSource: DataSource;
  getRepository<T>(entity: EntityTarget<T>): TimescaleRepository<T>;
  assertSchema(options?: AssertSchemaOptions): Promise<DriftItem[]>;
  refreshContinuousAggregate(
    view: string,
    options?: { start?: Date | string; end?: Date | string },
  ): Promise<void>;
  listHypertables(): Promise<HypertableInfo[]>;
  listChunks(options?: ListChunksOptions): Promise<ChunkInfo[]>;
  listContinuousAggregates(): Promise<ContinuousAggregateInfo[]>;
  listJobs(options?: ListJobsOptions): Promise<JobInfo[]>;
  getJobStats(jobId: number): Promise<JobStats | null>;
  runJob(jobId: number): Promise<void>;
  addJob(proc: string, options: AddJobOptions): Promise<number>;
  alterJob(jobId: number, changes: AlterJobChanges): Promise<void>;
  deleteJob(jobId: number): Promise<void>;
}
```

Use `getRepository()` with the entity class, not a string table name. The
non-`getRepository`/`assertSchema` methods (added in 0.4.0) are DataSource-wide
operations — continuous-aggregate refresh and operational introspection — not
scoped to a single entity, which is why they live on the context rather than a
repository. See [Operational introspection](#operational-introspection-and-jobs-040)
below for the informational-view and jobs methods.

### `TimescaleRepository<T>`

A TypeORM repository wrapper augmented with validated hypertable metadata, schema
helpers, and the typed query layer. The augmentation is per repository wrapper;
the package does not mutate `Repository.prototype` or TypeORM's cached repository
singleton.

Important properties and methods include:

- `timescaleMetadata`
- `timescaleQueryBuilder(alias?)`
- `getTimeBucket(options)`
- toolkit-backed helpers such as `getCandlesticks()`, `approxCountDistinct()`,
  `getStats()`, `getRegression()`, `getPercentiles()`, `getTDigestPercentiles()`,
  `getCounterAgg()`, `getTimeWeight()`, `getStateDurations()`,
  `getMostCommonValues()`, `getHeartbeatHealth()`, `downsampleLTTB()`, and
  `downsampleASAP()`

## Continuous aggregates (0.4.0)

See [Decorators and metadata helpers](#continuous-aggregate-decorators-040)
above for `@ContinuousAggregate`/`@BucketColumn`/`@GroupColumn`/`@AggregateColumn`,
and [`TimescaleContext`](#timescalecontext) above for
`refreshContinuousAggregate()`. This section covers the remaining pieces:
migration generation and the re-exported core builders.

### Migration generation for continuous aggregates

`GenerateMigrationOptions.continuousAggregates` (see
[Migration generation](#migration-generation) below) accepts an array of
`@ContinuousAggregate` classes. They are not TypeORM entities, so they can't be
discovered from `entityMetadatas` — pass them explicitly:

```ts
const migration = generateTimescaleMigration(AppDataSource, {
  continuousAggregates: [ReadingHourly],
});
```

Each CAGG's `source` must be a `@Hypertable` entity registered on the
DataSource, or another `@ContinuousAggregate` in the same `continuousAggregates`
array (hierarchical CAGG). Generation topologically orders hierarchical CAGGs
(parent after child) and throws on a circular `source` dependency.

### Re-exported core builders

Unlike the toolkit SQL builders (see
[Core SQL builder exports](#core-sql-builder-exports) below), the
continuous-aggregate core builders **are** re-exported at the `typeorm-timescaledb`
package root, since migration generation needs them directly:

- `createContinuousAggregateSQL`
- `refreshContinuousAggregateSQL`
- `addContinuousAggregatePolicySQL`

Related exported types: `CreateContinuousAggregateInput`,
`ContinuousAggregateColumn`, `ContinuousAggregateFn`,
`ContinuousAggregatePolicyInput`.

### Drift detection

`assertSchema()` (see [Schema assertion](#schema-assertion) below) also checks
that each `@ContinuousAggregate` view exists and, when `refresh` is set, that
its policy is attached.

## Query layer

0.2.x introduced the base query layer: time buckets, `first`/`last`, `histogram`,
gap-filling, candlesticks, approximate distinct count, and raw-result coercion.
0.3.0 expanded repository helpers for the stable Toolkit aggregate families
implemented in this package. 0.4.0 adds continuous aggregates (see
[Continuous aggregates](#continuous-aggregates-040) above), downsampling,
T-Digest percentiles, and DataSource-wide operational introspection (see
[Operational introspection](#operational-introspection-and-jobs-040) below).

### `repo.getTimeBucket(options)`

Typed `time_bucket` convenience method. It resolves entity property names to DB
columns, validates supported aggregate names, binds range values as parameters,
and returns raw rows.

Related exported types:

- `GetTimeBucketOptions`
- `TimeBucketMetric`
- `TimeBucketAggFn`
- `TimeBucketRow`

Supported metric functions are `avg`, `sum`, `min`, `max`, `count`, `first`, and
`last`. `getTimeBucket()` also supports timezone/origin/offset variants and
gap-filling through `time_bucket_gapfill` with `locf` or `interpolate` metric
fills.

### `repo.timescaleQueryBuilder(alias?)`

Creates a per-instance fluent wrapper over a TypeORM `SelectQueryBuilder` for
lower-level hyperfunction queries. This is the raw-identifier tier: column
arguments are treated as database column identifiers and are allow-list
validated/quoted. Use `getTimeBucket()` for the higher-level entity-property API.

Related exports:

- `TimescaleQueryBuilder`
- `TimeBucketSelectOptions`
- `StandardAggregate`

The fluent builder exposes `timeBucket()`, `timeBucketGapfill()`, `first()`,
`last()`, `histogram()`, `locf()`, `interpolate()`, `getRawMany()`, `getRawOne()`,
and `getSql()`.

`histogram()` emits TimescaleDB's `histogram(value, min, max, nbuckets)` and
returns an `int[]` raw value; use `toNumberArray()` to coerce it.

### Result coercion helpers

Hyperfunction queries return raw database values. The package exports helpers for
stable JavaScript coercion:

- `toNumber`
- `toNumberOrNull`
- `toBigIntString`
- `toDate`
- `toNumberArray`
- `mapRawRows`

Use `toBigIntString()` for potentially large integer-like values to avoid
JavaScript precision loss. Use `toNumberArray()` for array outputs such as
`histogram()`.

### `assertToolkit(dataSource)`

Checks whether `timescaledb_toolkit` is installed for a DataSource. Toolkit-backed
repository methods call this before emitting toolkit SQL and throw
`TimescaleErrorCode.TOOLKIT_MISSING`; the public error string is
`TSDB_TOOLKIT_MISSING`.

### Toolkit-backed repository methods

The following methods require `timescaledb_toolkit`:

- `getCandlesticks(options): Promise<Candle[]>`
- `approxCountDistinct(options): Promise<string>`
- `getStats(options): Promise<StatsSummary | null>`
- `getRegression(options): Promise<Regression | null>`
- `getPercentiles(options): Promise<PercentileResult | null>`
- `getPercentileRanks(options): Promise<number[] | null>`
- `getTDigestPercentiles(options): Promise<TDigestResult | null>`
- `getTDigestPercentileRanks(options): Promise<number[] | null>`
- `getCounterAgg(options): Promise<CounterSummary | null>`
- `getTimeWeight(options): Promise<TimeWeight | null>`
- `getStateDurations(options): Promise<StateDuration[]>`
- `getStateTimeline(options): Promise<StateInterval[]>`
- `getStateAt(options): Promise<string | null>`
- `getStatePeriods(options): Promise<Period[]>`
- `getMostCommonValues(options): Promise<MostCommonValue[]>`
- `getTopN(options): Promise<string[]>`
- `getHeartbeatHealth(options): Promise<HeartbeatHealth | null>`
- `getLiveRanges(options): Promise<Period[]>`
- `getDeadRanges(options): Promise<Period[]>`
- `isLiveAt(options): Promise<boolean | null>`
- `downsampleLTTB(options): Promise<DownsampledPoint[]>`
- `downsampleASAP(options): Promise<DownsampledPoint[]>`

Related exported option/result types include `Candle`, `GetCandlesticksOptions`,
`ApproxCountDistinctOptions`, `GetStatsOptions`, `StatsSummary`,
`GetRegressionOptions`, `Regression`, `GetPercentilesOptions`,
`PercentileResult`, `GetPercentileRanksOptions`, `GetTDigestPercentilesOptions`,
`GetTDigestPercentileRanksOptions`, `TDigestResult`, `GetCounterAggOptions`,
`CounterSummary`, `GetTimeWeightOptions`, `TimeWeight`,
`GetStateDurationsOptions`, `StateDuration`, `GetStateTimelineOptions`,
`StateInterval`, `GetStateAtOptions`, `GetStatePeriodsOptions`, `Period`,
`GetMostCommonValuesOptions`, `MostCommonValue`, `GetTopNOptions`,
`HeartbeatWindow`, `HeartbeatHealth`, `IsLiveAtOptions`, `DownsampleOptions`,
and `DownsampledPoint`.

Key option fields by family:

- Candlesticks: `interval`, `priceColumn`, `volumeColumn`, optional `timeColumn`,
  optional `range`, optional `order`.
- Approximate distinct count: `column`, optional `range`, optional `timeColumn`.
- Statistics: `valueColumn`, optional `method`, optional `range`, optional
  `timeColumn`.
- Regression: `yColumn`, `xColumn`, optional `method`, optional `range`, optional
  `timeColumn`.
- Percentiles (UddSketch and T-Digest): `valueColumn`, percentile values or rank
  values, optional `range`, optional `timeColumn`; T-Digest also takes an
  optional `buckets` sketch-size (default `100`).
- Counter/time-weight: value columns plus optional `range` and `timeColumn`.
- State tracking: `valueColumn`, optional `range`, optional `timeColumn`; some
  methods also take `at` or `state`.
- Most-common-values: text value column plus sketch/top-N sizing options.
- Heartbeat/liveness: heartbeat/window options and optional `at` for `isLiveAt()`.
- Downsampling: `valueColumn`, `resolution` (target point count, integer 3 to
  1,000,000), optional `timeColumn`, optional `range`.

### Core SQL builder exports

Low-level SQL builders are exported from `@blueprime/timescaledb-core`, not from
`typeorm-timescaledb`. Use this tier when you need raw SQL expression builders
outside the TypeORM repository helpers:

```ts
import { statsAgg1DExpr, statsAccessor1DExpr } from '@blueprime/timescaledb-core';
```

`@blueprime/timescaledb-core` includes core builders/accessors for the same
implemented Toolkit families: stats/regression, UddSketch percentiles, counters,
time-weight, state tracking, most-common-values, and heartbeat helpers (0.3.0),
plus T-Digest (`tdigestExpr`, `tdigestAccessorExpr`) and downsampling
(`lttbExpr`, `asapSmoothExpr`) added in 0.4.0. The TypeORM package root
re-exports the related option types `StatsMethod`, `TimeWeightMethod`, and
`IntegralUnit`, but not these SQL builder functions themselves — unlike the
continuous-aggregate builders, which the root package does re-export (see
[Continuous aggregates](#continuous-aggregates-040) above), since migration
generation needs them directly.

## Operational introspection and jobs (0.4.0)

Read-only accessors over `timescaledb_information.*`, plus the jobs API. All are
methods on `TimescaleContext` (see above) — DataSource-wide, not entity-scoped —
not on a repository.

- `listHypertables(): Promise<HypertableInfo[]>` — every hypertable, with
  dimension/chunk counts and columnstore state.
- `listChunks(options?: ListChunksOptions): Promise<ChunkInfo[]>` — chunks,
  optionally filtered to one hypertable (`options.hypertable`).
- `listContinuousAggregates(): Promise<ContinuousAggregateInfo[]>` — every CAGG,
  with materialized-only and compression state.
- `listJobs(options?: ListJobsOptions): Promise<JobInfo[]>` — background jobs,
  optionally filtered to one hypertable/CAGG.
- `getJobStats(jobId: number): Promise<JobStats | null>` — one job's run
  history, or `null` if the id is unknown.
- `runJob(jobId: number): Promise<void>` — runs a job now via `run_job`.
  Executes standalone (autocommit) since a job's action may not run inside a
  transaction.
- `addJob(proc: string, options: AddJobOptions): Promise<number>` — registers a
  user-defined action job for an existing stored procedure
  `(job_id int, config jsonb)`; returns the new job id.
- `alterJob(jobId: number, changes: AlterJobChanges): Promise<void>` — changes
  an existing job. Only the fields set in `changes` are sent; `config`, when
  set, replaces the whole config rather than merging.
- `deleteJob(jobId: number): Promise<void>` — deletes a job.

Related exported types: `HypertableInfo`, `ChunkInfo`, `ListChunksOptions`,
`ContinuousAggregateInfo`, `JobInfo`, `ListJobsOptions`, `JobStats`,
`AddJobOptions`, `AlterJobChanges`.

`refreshContinuousAggregate()`, `runJob()`, and `addJob()`/`alterJob()`/
`deleteJob()` all run on a pooled connection outside any surrounding
transaction — the underlying TimescaleDB procedures cannot run inside one.

## Schema assertion

### `assertSchema(dataSource, options?)`

Checks the live database against the `@Hypertable` entities registered on an
initialized TypeORM `DataSource`.

It compares scoped TimescaleDB state such as:

- whether expected tables are hypertables
- dimension columns
- expected columnstore policy presence
- expected retention policy presence

It is a scoped sanity check, not a full database diff engine.

### `AssertSchemaOptions`

```ts
interface AssertSchemaOptions {
  readonly mode?: 'assert' | 'warn';
  readonly logger?: (message: string) => void;
}
```

Default behavior is `mode: 'assert'`, which throws on drift. Use `mode: 'warn'`
to log drift and return it instead.

## Migration generation

- `generateTimescaleMigration(dataSource, options?)` — generates an in-memory
  TimescaleDB migration from initialized DataSource metadata.
- `renderTimescaleMigration(migration)` — renders a generated migration as
  TypeORM migration TypeScript source.
- `createTimescaleMigration(migration)` — creates a runnable TypeORM
  `MigrationInterface` object from an in-memory generated migration.

```ts
interface GeneratedMigration {
  readonly name: string;
  readonly timestamp: number;
  readonly up: readonly string[];
  readonly down: readonly string[];
}

interface GenerateMigrationOptions {
  readonly name?: string;
  readonly timestamp?: number;
  /** `@ContinuousAggregate` classes to emit CAGG DDL for (0.4.0). See
   * [Continuous aggregates](#continuous-aggregates-040) above. */
  readonly continuousAggregates?: ReadonlyArray<abstract new (...args: never[]) => unknown>;
}
```

## CLI commands

The CLI is exposed through the package binary. It supports generating TimescaleDB
migration files, running pending migrations through TypeORM's
`DataSource.runMigrations()`, reverting the latest migration, and checking
migration status.

For TypeScript DataSource files, run the CLI through a TypeScript loader. For
compiled JavaScript DataSources, call the package binary directly.

The CLI is intentionally not re-exported as part of the root importable library
surface.

## NestJS API

Import NestJS helpers from:

```ts
import { TimescaleModule } from 'typeorm-timescaledb/nestjs';
```

- `TimescaleModule.forRoot(options)` registers a DataSource-scoped Timescale
  context.
- `TimescaleModule.forFeature(entities, name?)` registers one
  `TimescaleRepository` provider per `@Hypertable` entity class.
- `InjectTimescaleRepository(entity, name?)` injects a Timescale repository.
- `InjectTimescaleContext(name?)` injects the DataSource-scoped Timescale context.
- `getTimescaleRepositoryToken(entity, name?)` returns a repository provider token.
- `getTimescaleContextToken(name?)` returns a context provider token.
- `DEFAULT_TIMESCALE_NAME` is the default provider namespace.

## Core metadata and query types

The root package re-exports the main metadata/config types from
`@blueprime/timescaledb-core`:

- `HypertableOptions`
- `ColumnstoreOptions`
- `RetentionOptions`
- `SpacePartitionOptions`
- `TimescaleEntityMetadata`
- `DriftItem`
- `StatsMethod`
- `TimeWeightMethod`
- `IntegralUnit`
- `CreateContinuousAggregateInput`
- `ContinuousAggregateColumn`
- `ContinuousAggregateFn`
- `ContinuousAggregatePolicyInput`

Plus the TypeORM-package-level continuous-aggregate metadata types
`ContinuousAggregateMeta`, `CaggAggregate`, and `CaggRefreshPolicy` (the latter
also public as `RefreshPolicyOptions`, see
[Decorators and metadata helpers](#continuous-aggregate-decorators-040) above).

## Validation and errors

- `parseHypertableOptions(input)` parses and validates raw hypertable options.
- `validateHypertableMetadata(metadata, entityName?)` validates stored metadata.
- `TimescaleError` is the package-specific error class.
- `TimescaleErrorCode` classifies validation, migration generation, runtime,
  query-layer, and schema assertion failures.

## What is not part of this API

The current public API does not include automatic destructive migrations,
automatic live configuration rewrites, `@RollupColumn` ergonomic sugar for
hierarchical continuous-aggregate rollups (expressible today via
`@AggregateColumn`, see [Continuous aggregates](#continuous-aggregates-040)
above), validated cross-store references, experimental toolkit aggregates
(`gauge_agg`, `freq_agg`, `compact_state_agg`), stable Toolkit aggregates not
listed above, or complete TimescaleDB feature coverage.

For unsupported live schema changes, write explicit TypeORM migrations and review
the generated SQL before applying it.

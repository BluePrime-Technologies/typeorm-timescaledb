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

Continuous aggregates are out of scope for the diff engine below —
`compileDesiredState()` does not compile them, so `check`/`diffSchemaState`
never detect or convert CAGG drift. Emit and evolve CAGG DDL through
`generateTimescaleMigration` (or a hand-written migration), not the migration
engine.

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

`assertSchema()` (see [Schema assertion](#schema-assertion) below) can also
check that each `@ContinuousAggregate` view exists and, when `refresh` is set,
that its policy is attached — but **only for CAGGs you pass explicitly** via
`AssertSchemaOptions.continuousAggregates`. With no `continuousAggregates`
passed, `assertSchema()` checks `@Hypertable` entities only.

```ts
await ts.assertSchema({ continuousAggregates: [ReadingHourly] });
```

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

```ts
const ts = createTimescale(AppDataSource);

const hypertables = await ts.listHypertables();
const chunks = await ts.listChunks({ hypertable: 'reading' });
const caggs = await ts.listContinuousAggregates();
const jobs = await ts.listJobs({ hypertable: 'reading' });
const stats = await ts.getJobStats(jobs[0]!.jobId);
```

- `listHypertables()` — every hypertable, with dimension/chunk counts and
  whether columnstore is enabled.
- `listChunks(options?)` — chunks, optionally filtered to one hypertable
  (`options.hypertable`, bare name or `schema.name`); includes each chunk's
  range and compression state.
- `listContinuousAggregates()` — every CAGG, with its materialized-only and
  compression state.
- `listJobs(options?)` — background jobs (policies you configured, plus any
  user-defined action jobs), optionally filtered to one hypertable/CAGG.
- `getJobStats(jobId)` — one job's run history (last run, successes/failures,
  next scheduled start), or `null` if the id is unknown.

### Running and managing jobs

```ts
await ts.runJob(jobs[0]!.jobId); // run a job now, outside its schedule

const jobId = await ts.addJob('my_schema.my_action_proc', {
  scheduleInterval: '1 hour',
  config: { threshold: 100 },
});

await ts.alterJob(jobId, { scheduleInterval: '30 minutes' });
await ts.deleteJob(jobId);
```

- `runJob(jobId)` — runs a background job immediately via `run_job`. Executes
  standalone (autocommit): a job's action may not run inside a transaction, so
  this is not enrolled in a surrounding `dataSource.transaction(...)` call —
  same rule as `refreshContinuousAggregate()`.
- `addJob(proc, options)` — registers a **user-defined action job** running an
  existing stored procedure `(job_id int, config jsonb)`. Schema-qualify `proc`
  (`my_schema.my_proc`) to avoid relying on `search_path`. Returns the new job
  id.
- `alterJob(jobId, changes)` — changes an existing job. Only the fields you set
  are sent; anything omitted is left unchanged. If you set `config`, it
  **replaces** the whole config — it is not merged with the existing one.
- `deleteJob(jobId)` — deletes a job.

All of the above run on a pooled connection outside any surrounding transaction,
matching `refreshContinuousAggregate()`'s standalone-execution rule.

## Schema assertion

### `assertSchema(dataSource, options?)`

Checks the live database against the `@Hypertable` entities registered on an
initialized TypeORM `DataSource`.

It compares scoped TimescaleDB state such as:

- whether expected tables are hypertables
- dimension columns
- expected columnstore policy presence
- expected retention policy presence

It is a scoped sanity check, not a full database diff engine — for that, see
[Migration engine](#migration-engine) below.

### `AssertSchemaOptions`

```ts
interface AssertSchemaOptions {
  readonly mode?: 'assert' | 'warn';
  readonly logger?: (message: string) => void;
  /** `@ContinuousAggregate` classes to also check for drift (0.4.0). Opt-in — see
   * [Continuous aggregates](#continuous-aggregates-040) above. */
  readonly continuousAggregates?: ReadonlyArray<abstract new (...args: never[]) => unknown>;
}
```

Default behavior is `mode: 'assert'`, which throws on drift. Use `mode: 'warn'`
to log drift and return it instead.

## Migration engine

0.6.0 adds a second way to produce and apply TimescaleDB DDL: instead of only
deriving an additive migration from decorators, the engine reads what a live
database actually has, diffs it against your entities, and can converge it
directly — with every step safety-classified before anything runs. See the
[Migration guide](./migration-guide.md#migration-engine-060-diffing-a-live-database)
for the end-to-end workflow; this section is the API surface.

### Introspection and desired state

- `introspect(dataSource): Promise<SchemaStateIR>` — reduces a live,
  initialized TimescaleDB `DataSource` to a canonical `SchemaStateIR`
  (dimensions, columnstore config, compression/retention/refresh policies,
  continuous aggregates), normalized so Postgres's interval reformatting and
  engine-filled defaults never read as drift.
- `compileDesiredState(dataSource): SchemaStateIR` — reduces the `@Hypertable`
  decorators registered on a `DataSource` to the same `SchemaStateIR` shape, so
  it can be compared against `introspect()`'s output.
- `collectRenames(dataSource): ReadonlyMap<string, string>` — collects
  `@Hypertable({ renamedFrom })` declarations into the desired-table → old-table
  map that `diffSchemaState`'s `renames` option consumes.

### Diffing: `diffSchemaState`

```ts
import { diffSchemaState, isEmptyPlan, compilePlan } from 'typeorm-timescaledb';

function diffSchemaState(
  current: SchemaStateIR,
  desired: SchemaStateIR,
  options?: DiffOptions,
): Plan;
```

Compares `current` (from `introspect()`) against `desired` (from
`compileDesiredState()`) and returns an ordered `Plan` — the operations needed
to converge current toward desired. An unchanged schema yields an **empty
plan**.

```ts
interface DiffOptions {
  /** Desired table → current table, from `collectRenames()`. */
  readonly renames?: ReadonlyMap<string, string>;
  /**
   * Opt in to emitting the safe, reversible policy removals — `removeRetentionPolicy` /
   * `removeCompressionPolicy` — for a policy present in the database but absent from your
   * entities. Default `false`: no drop is ever emitted, so omitting a decorator option is
   * never silently destructive. Destructive drops (dropping a hypertable, disabling a
   * columnstore) are never emitted even with `allowDrops: true`.
   */
  readonly allowDrops?: boolean;
}

interface Plan {
  readonly steps: readonly PlanStep[];
}

interface PlanStep {
  readonly operation: Operation;
  readonly safety: SafetyClass;
  readonly reason: string;
}
```

`diffSchemaState` auto-diffs, on an existing hypertable: a missing
columnstore/retention policy, a changed compression or retention threshold, a
changed chunk interval, and a changed columnstore segment-by/order-by
configuration — plus hypertable renames via the `renames` map. It throws
`TimescaleError` rather than silently under-converging on a space-dimension
divergence, an integer-time policy threshold, or an ambiguous/colliding rename.
Continuous aggregates are out of scope (the diff is hypertable-scoped — see
[Continuous aggregates](#continuous-aggregates-040) above).

- `isEmptyPlan(plan): boolean` — `true` when `plan.steps.length === 0` (no
  drift). Reflects only what the diff engine currently detects, not a guarantee
  of full convergence.
- `compilePlan(plan): CompiledPlan` — compiles every step's operation to
  reversible SQL: `up` in step order, `down` in the exact reverse.

### Safety classification

```ts
type SafetyClass = 'online-safe' | 'needs-recompress' | 'one-way' | 'refuse-by-default';

interface OperationSafety {
  readonly safety: SafetyClass;
  readonly reason: string;
}

function classifyOperation(operation: Operation): OperationSafety; // @blueprime/timescaledb-core
```

- **`online-safe`** — applies without rewriting data or a notable lock, and is
  cleanly reversible (e.g. adding/removing a policy, a chunk-interval change, a
  rename).
- **`needs-recompress`** — not data-losing, but applying requires
  decompressing/recompressing existing chunks (a columnstore segment-by/order-by
  change).
- **`one-way`** — safe to apply but not cleanly reversible; `down()` is a
  non-destructive notice rather than a true undo (hypertable conversion,
  enabling the columnstore, creating a continuous aggregate).
- **`refuse-by-default`** — destructive or data-losing; never applied without
  an explicit opt-in (e.g. shortening a retention threshold).

### Applying: `applyDirect`

```ts
function applyDirect(
  dataSource: DataSource,
  plan: Plan,
  options?: ApplyDirectOptions,
): Promise<ApplyDirectResult>;

interface ApplyDirectOptions {
  /** Converge forward (`'up'`, default) or revert (`'down'`). */
  readonly direction?: 'up' | 'down';
  /** Apply `refuse-by-default` steps too. Default `false` — throws before touching the DB if the
   * plan contains any. */
  readonly allowRefuseByDefault?: boolean;
  /** Run every statement in one transaction (default `true`). */
  readonly transaction?: boolean;
}

interface ApplyDirectResult {
  readonly direction: 'up' | 'down';
  readonly statements: readonly string[];
  readonly stepCount: number;
}
```

Applies a `Plan` straight to a live database, transactionally, through the same
compile path as every other emitter. The `refuse-by-default` gate checks the
plan's operations directly via `classifyOperation` (not a caller-supplied
`step.safety`), so a hand-built `Plan` cannot mislabel a dangerous operation to
slip past it.

### `check`: the CLI drift gate

```sh
npx typeorm-timescaledb check -d src/data-source.ts
```

Introspects the live database, diffs it against your `@Hypertable`
declarations, prints a readable drift preview, and exits non-zero if drift is
found — distinct from the `status` verb, which reports pending _TypeORM_
migrations rather than live-schema drift. See [CLI commands](#cli-commands)
below.

## Migration generation

- `generateTimescaleMigration(dataSource, options?)` — generates an in-memory,
  additive/desired-state TimescaleDB migration from initialized DataSource
  metadata.
- `planToMigration(plan, options?)` — turns a diff `Plan` (from
  `diffSchemaState`, see [Migration engine](#migration-engine) above) into the
  same `GeneratedMigration` shape, so the engine's diff output becomes a
  committable migration rather than only a `check` preview.
- `renderTimescaleMigration(migration)` — renders a generated migration as
  TypeORM migration TypeScript source.
- `renderTimescaleMigrationSql(migration)` — renders a generated migration as a
  raw, reviewable `.sql` artifact (the `generate --output sql` emit target).
- `createTimescaleMigration(migration)` — creates a runnable TypeORM
  `MigrationInterface` object from an in-memory generated migration.
- `TimescaleSchemaBuilder` — a fluent, hand-authoring alternative to diffing:
  chain typed methods (`createHypertable`, `addRetentionPolicy`,
  `alterColumnstoreConfig`, …) and run the result inside an ordinary TypeORM
  migration via `up(queryRunner)` / `down(queryRunner)`, or call `.toPlan()` /
  `.build()` to inspect the safety-classified `Plan` or compiled SQL directly.
  It routes through the same compile path as every other emitter, so
  hand-authored SQL is byte-identical to the generated/diffed path.

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

interface PlanMigrationOptions {
  readonly name?: string;
  readonly timestamp?: number;
}
```

## CLI commands

The CLI is exposed through the package binary. It supports:

- `generate` — write a new additive/desired-state migration file from your
  `@Hypertable` entities (`--output ts|sql`, default `ts`).
- `run` — apply pending migrations through TypeORM's
  `DataSource.runMigrations()`.
- `revert` — revert the most recently applied migration.
- `status` — report whether any _TypeORM_ migrations are pending (a tracking
  question, not a live-schema comparison).
- `check` — the migration-engine drift gate: introspect the live database,
  diff it against your `@Hypertable` declarations, print the drift, and exit
  non-zero if any is found. See [Migration engine](#migration-engine) above.
  `status` and `check` answer different questions and are not interchangeable:
  a database can have zero pending TypeORM migrations and still have drifted
  from your entities (or vice versa, mid-rollout).

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

The migration engine's own types — `SchemaStateIR`, `Plan`, `PlanStep`,
`DiffOptions`, `CompiledPlan`, `SafetyClass`, `OperationSafety`, `Operation`
and its per-kind variants — are exported from `@blueprime/timescaledb-core`;
see [Migration engine](#migration-engine) above.

## Validation and errors

- `parseHypertableOptions(input)` parses and validates raw hypertable options.
- `validateHypertableMetadata(metadata, entityName?)` validates stored metadata.
- `TimescaleError` is the package-specific error class.
- `TimescaleErrorCode` classifies validation, migration generation, runtime,
  query-layer, and schema assertion failures.

## What is not part of this API

The current public API does not include automatic destructive migrations
(dropping a hypertable or disabling a columnstore is never emitted, even by the
migration engine's `allowDrops`/`allowRefuseByDefault` opt-ins), `@RollupColumn`
ergonomic sugar for hierarchical continuous-aggregate rollups (expressible
today via `@AggregateColumn`, see [Continuous aggregates](#continuous-aggregates-040)
above), structural diffing of continuous aggregates or in-place reconciliation
of space (hash) dimensions (both still need a hand-written migration — see
[Migration engine](#migration-engine) above), experimental toolkit aggregates
(`gauge_agg`, `freq_agg`, `compact_state_agg`), or stable Toolkit aggregates not
listed above.

`@blueprime/cross-store` (validated cross-**database** `@Resolve` references) is
a separate, independently versioned package — see the root
[README](../README.md#packages) — not part of this API surface.

For unsupported live schema changes, write explicit TypeORM migrations and review
the generated SQL before applying it.

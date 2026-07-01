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
}
```

Use `getRepository()` with the entity class, not a string table name.

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
  `getStats()`, `getRegression()`, `getPercentiles()`, `getCounterAgg()`,
  `getTimeWeight()`, `getStateDurations()`, `getMostCommonValues()`, and
  `getHeartbeatHealth()`

## Query layer

0.2.x introduced the base query layer: time buckets, `first`/`last`, `histogram`,
gap-filling, candlesticks, approximate distinct count, and raw-result coercion.
The 0.3.0 release scope expands repository helpers for the stable Toolkit
aggregate families implemented in this package.

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

Related exported option/result types include `Candle`, `GetCandlesticksOptions`,
`ApproxCountDistinctOptions`, `GetStatsOptions`, `StatsSummary`,
`GetRegressionOptions`, `Regression`, `GetPercentilesOptions`,
`PercentileResult`, `GetCounterAggOptions`, `CounterSummary`,
`GetTimeWeightOptions`, `TimeWeight`, `GetStateDurationsOptions`,
`StateDuration`, `GetStateTimelineOptions`, `StateInterval`, `GetStateAtOptions`,
`GetStatePeriodsOptions`, `Period`, `GetMostCommonValuesOptions`,
`MostCommonValue`, `GetTopNOptions`, `HeartbeatWindow`, `HeartbeatHealth`, and
`IsLiveAtOptions`.

Key option fields by family:

- Candlesticks: `interval`, `priceColumn`, `volumeColumn`, optional `timeColumn`,
  optional `range`, optional `order`.
- Approximate distinct count: `column`, optional `range`, optional `timeColumn`.
- Statistics: `valueColumn`, optional `method`, optional `range`, optional
  `timeColumn`.
- Regression: `yColumn`, `xColumn`, optional `method`, optional `range`, optional
  `timeColumn`.
- Percentiles: `valueColumn`, percentile values or rank values, optional `range`,
  optional `timeColumn`.
- Counter/time-weight: value columns plus optional `range` and `timeColumn`.
- State tracking: `valueColumn`, optional `range`, optional `timeColumn`; some
  methods also take `at` or `state`.
- Most-common-values: text value column plus sketch/top-N sizing options.
- Heartbeat/liveness: heartbeat/window options and optional `at` for `isLiveAt()`.

### Core SQL builder exports

Low-level SQL builders are exported from `@blueprime/timescaledb-core`, not from
`typeorm-timescaledb`. Use this tier when you need raw SQL expression builders
outside the TypeORM repository helpers:

```ts
import { statsAgg1DExpr, statsAccessor1DExpr } from '@blueprime/timescaledb-core';
```

The 0.3.0 release scope includes core builders/accessors for the same implemented
Toolkit families: stats/regression, UddSketch percentiles, counters, time-weight,
state tracking, most-common-values, and heartbeat helpers. The TypeORM package
root re-exports the related option types `StatsMethod`, `TimeWeightMethod`, and
`IntegralUnit`, but not the SQL builder functions themselves.

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

## Validation and errors

- `parseHypertableOptions(input)` parses and validates raw hypertable options.
- `validateHypertableMetadata(metadata, entityName?)` validates stored metadata.
- `TimescaleError` is the package-specific error class.
- `TimescaleErrorCode` classifies validation, migration generation, runtime,
  query-layer, and schema assertion failures.

## What is not part of this API

The current public API does not include automatic destructive migrations,
automatic live configuration rewrites, continuous aggregates, validated
cross-store references, experimental toolkit aggregates, stable Toolkit
aggregates that are not listed above, or complete TimescaleDB feature coverage.

For unsupported live schema changes, write explicit TypeORM migrations and review
the generated SQL before applying it.

# API reference

This page summarizes the public API exported by `typeorm-timescaledb` in the
current pre-1.0 foundation release.

Use this page as a navigation reference. The source of truth remains the package
exports in `packages/typeorm/src/index.ts` and `packages/typeorm/src/nestjs`.
Future docs-site work can replace this page with generated TypeDoc output, but
this reference intentionally documents only the API that is exported today.

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

## TypeORM re-exports

`typeorm-timescaledb` re-exports TypeORM's modeling surface so users can keep one
import path for the entity definitions used by this package.

Common re-exports include:

- `DataSource`
- `Entity`
- `Column`
- `PrimaryColumn`
- TypeORM types and helpers exported by `packages/typeorm/src/orm.ts`

The package does not globally mutate TypeORM. TypeORM still owns base table
creation and normal TypeORM migration behavior.

## Decorators

### `Hypertable(options)`

Declares TimescaleDB hypertable metadata for a TypeORM entity.

```ts
@Entity('reading')
@Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['sensorId'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})
export class Reading {}
```

Use this on the entity class. The metadata is read by migration generation,
runtime repository access, schema assertion, and the query layer.

### `TimeColumn()`

Marks the entity property that should be used as the hypertable time dimension.

```ts
@PrimaryColumn({ type: 'timestamptz' })
@TimeColumn()
time!: Date;
```

The time column must correspond to a real TypeORM column.

### `HypertablePrimaryKey()`

Records a TypeORM primary-key column as part of the hypertable-aware primary key
metadata used by this package.

```ts
@PrimaryColumn({ type: 'timestamptz' })
@TimeColumn()
@HypertablePrimaryKey()
time!: Date;
```

When a hypertable entity declares a primary key, TimescaleDB requires that key to
include every partitioning column. That means the time column and, when
`spacePartition` is configured, the space-partition column must both be marked
with `@HypertablePrimaryKey()`.

## Metadata helpers

### `getTimescaleMetadata(target)`

Returns the stored TimescaleDB metadata for a decorated entity class, or
`undefined` when the class has no hypertable metadata.

### `hasTimescaleMetadata(target)`

Returns whether a class has `@Hypertable` metadata.

## Runtime context

### `createTimescale(dataSource)`

Creates a DataSource-scoped TimescaleDB context.

```ts
await AppDataSource.initialize();

const ts = createTimescale(AppDataSource);
const readings = ts.getRepository(Reading);
```

The context is bound to one TypeORM `DataSource`. It does not patch TypeORM
globals or shared prototypes.

### `TimescaleContext`

The object returned by `createTimescale(dataSource)`.

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
helpers, and the 0.2.x query layer.

Important properties and methods include:

- `timescaleMetadata`
- `timescaleQueryBuilder(alias?)`
- `getTimeBucket(options)`
- toolkit-backed helpers such as `getCandlesticks()`, `approxCountDistinct()`,
  `getStats()`, `getRegression()`, `getPercentiles()`, `getCounterAgg()`,
  `getTimeWeight()`, `getStateDurations()`, `getMostCommonValues()`, and
  `getHeartbeatHealth()`

The augmentation is per repository wrapper. The package does not mutate
`Repository.prototype` or TypeORM's cached repository singleton.

## Query layer

The 0.2.x query layer is exported from the package root and exposed through the
repository returned by `createTimescale(dataSource).getRepository(Entity)`.

### `repo.getTimeBucket(options)`

Typed `time_bucket` convenience method. It resolves entity property names to DB
columns, validates supported aggregate names, binds range values as parameters,
and returns raw rows.

```ts
const rows = await readings.getTimeBucket({
  interval: '1 hour',
  range: {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  },
  metrics: [
    { alias: 'avgValue', fn: 'avg', column: 'value' },
    { alias: 'lastValue', fn: 'last', column: 'value' },
    { alias: 'count', fn: 'count' },
  ],
});
```

Related exported types:

- `GetTimeBucketOptions`
- `TimeBucketMetric`
- `TimeBucketAggFn`
- `TimeBucketRow`

Supported metric functions are `avg`, `sum`, `min`, `max`, `count`, `first`, and
`last`.

`getTimeBucket()` also supports timezone/origin/offset variants and gap-filling
through `time_bucket_gapfill` with `locf` or `interpolate` metric fills.

### `repo.timescaleQueryBuilder(alias?)`

Creates a per-instance fluent wrapper over a TypeORM `SelectQueryBuilder` for
lower-level hyperfunction queries.

```ts
const rows = await readings
  .timescaleQueryBuilder('r')
  .timeBucket({ interval: '1 hour', column: 'time' })
  .last('value', 'time', 'lastValue')
  .queryBuilder.where('r."time" >= :from AND r."time" < :to', {
    from: new Date('2026-01-01T00:00:00Z'),
    to: new Date('2026-01-02T00:00:00Z'),
  })
  .getRawMany();
```

This is the raw-identifier tier: column arguments are treated as database column
identifiers and are allow-list validated/quoted. Use `getTimeBucket()` for the
higher-level entity-property API.

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
- State tracking: `stateColumn`, optional `range`, optional `timeColumn`; some
  methods also take `at` or `state`.
- Most-common-values: text value column plus sketch/top-N sizing options.
- Heartbeat/liveness: heartbeat/window options and optional `at` for `isLiveAt()`.

## Schema assertion

### `assertSchema(dataSource, options?)`

Checks the live database against the `@Hypertable` entities registered on an
initialized TypeORM `DataSource`.

```ts
await AppDataSource.initialize();
await assertSchema(AppDataSource);
```

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

### `generateTimescaleMigration(dataSource, options?)`

Generates an in-memory TimescaleDB migration from the `@Hypertable` entities
registered on an initialized TypeORM `DataSource`.

The generated migration contains ordered `up` SQL statements and non-destructive
`down` SQL statements. It does not apply anything to the database.

### `renderTimescaleMigration(migration)`

Renders a generated migration as TypeORM migration TypeScript source.

### `createTimescaleMigration(migration)`

Creates a runnable TypeORM `MigrationInterface` object from an in-memory generated
migration.

### `GeneratedMigration`

```ts
interface GeneratedMigration {
  readonly name: string;
  readonly timestamp: number;
  readonly up: readonly string[];
  readonly down: readonly string[];
}
```

### `GenerateMigrationOptions`

```ts
interface GenerateMigrationOptions {
  readonly name?: string;
  readonly timestamp?: number;
}
```

## CLI commands

The CLI is exposed through the package binary:

```sh
npx typeorm-timescaledb --help
```

For TypeScript DataSource files, run the CLI through a TypeScript loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

Supported workflow:

- generate a TimescaleDB migration file from entity metadata
- run pending migrations through TypeORM's `DataSource.runMigrations()`
- revert the latest migration through TypeORM's undo migration behavior
- check migration status through TypeORM's migration status behavior

The CLI is intentionally not re-exported as part of the root importable library
surface.

## NestJS API

Import NestJS helpers from:

```ts
import { TimescaleModule } from 'typeorm-timescaledb/nestjs';
```

### `TimescaleModule`

Registers a DataSource-scoped Timescale context with `forRoot()` and repository
providers with `forFeature()`.

```ts
@Module({
  imports: [
    TimescaleModule.forRoot({
      dataSource: AppDataSource,
    }),
    TimescaleModule.forFeature([Reading]),
  ],
})
export class ReadingsModule {}
```

For named or multi-DataSource contexts, pass the same name to both calls:

```ts
@Module({
  imports: [
    TimescaleModule.forRoot({
      name: 'analytics',
      dataSource: AnalyticsDataSource,
    }),
    TimescaleModule.forFeature([Reading], 'analytics'),
  ],
})
export class AnalyticsReadingsModule {}
```

### `TimescaleModuleOptions`

Options object used by `TimescaleModule.forRoot(options)`. Common fields include
`dataSource`, `name`, `assert`, `logger`, and `global`.

### `TimescaleModule.forFeature(entities, name?)`

Registers one `TimescaleRepository` provider per `@Hypertable` entity class. It
requires a matching `forRoot()` registration in the same module graph, or a
`forRoot({ global: true })` registration.

### `InjectTimescaleRepository(entity, name?)`

NestJS injection decorator for a Timescale repository provider.

### `InjectTimescaleContext(name?)`

NestJS injection decorator for the DataSource-scoped Timescale context.

### `getTimescaleRepositoryToken(entity, name?)`

Returns the provider token for a Timescale repository.

### `getTimescaleContextToken(name?)`

Returns the provider token for a Timescale context.

### `DEFAULT_TIMESCALE_NAME`

Default provider namespace used by the NestJS integration.

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

### `parseHypertableOptions(input)`

Parses and validates raw hypertable options using the core metadata schema.

### `validateHypertableMetadata(metadata, entityName?)`

Validates stored hypertable metadata and throws `TimescaleError` when invalid.

### `TimescaleError`

Package-specific error class used for validation, migration generation, runtime,
query-layer, and schema assertion failures.

### `TimescaleErrorCode`

Enum-like error-code export used to classify package errors. Common codes include
unsafe identifiers, missing toolkit extension, invalid arguments, missing time
columns, non-hypertable entities, and schema drift.

## What is not part of this API

The current public API does not include automatic destructive migrations,
automatic live configuration rewrites, continuous aggregates, validated
cross-store references, experimental toolkit aggregates, or complete TimescaleDB
feature coverage.

For unsupported live schema changes, write explicit TypeORM migrations and review
the generated SQL before applying it.

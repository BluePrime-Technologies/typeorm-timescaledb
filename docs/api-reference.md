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
runtime repository access, and schema assertion.

### `TimeColumn()`

Marks the entity property that should be used as the hypertable time dimension.

```ts
@PrimaryColumn({ type: 'timestamptz' })
@TimeColumn()
time!: Date;
```

The time column must correspond to a real TypeORM column.

### `HypertablePrimaryKey()`

Marks the time column as part of the hypertable-aware primary key model used by
this package.

```ts
@PrimaryColumn({ type: 'timestamptz' })
@TimeColumn()
@HypertablePrimaryKey()
time!: Date;
```

## Metadata helpers

### `getTimescaleMetadata(target)`

Returns the stored TimescaleDB metadata for a decorated entity class, or
`undefined` when the class has no hypertable metadata.

```ts
const metadata = getTimescaleMetadata(Reading);
```

### `hasTimescaleMetadata(target)`

Returns whether a class has `@Hypertable` metadata.

```ts
if (hasTimescaleMetadata(Reading)) {
  // Reading is known to this package as a hypertable entity.
}
```

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

A TypeORM repository instance augmented with validated hypertable metadata.

```ts
const readings = ts.getRepository(Reading);
console.log(readings.timescaleMetadata);
```

The augmentation is per repository instance. It is not added to
`Repository.prototype`.

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

```ts
const drift = await assertSchema(AppDataSource, {
  mode: 'warn',
  logger: console.warn,
});
```

## Migration generation

### `generateTimescaleMigration(dataSource, options?)`

Generates an in-memory TimescaleDB migration from the `@Hypertable` entities
registered on an initialized TypeORM `DataSource`.

```ts
await AppDataSource.initialize();

const migration = generateTimescaleMigration(AppDataSource, {
  name: 'Timescale',
});
```

The generated migration contains ordered `up` SQL statements and non-destructive
`down` SQL statements. It does not apply anything to the database.

### `renderTimescaleMigration(migration)`

Renders a generated migration as TypeORM migration TypeScript source.

```ts
const source = renderTimescaleMigration(migration);
```

The rendered file implements TypeORM's `MigrationInterface`.

### `createTimescaleMigration(migration)`

Creates a runnable TypeORM `MigrationInterface` object from an in-memory generated
migration.

```ts
const typeormMigration = createTimescaleMigration(migration);
```

This is useful for programmatic workflows. Most users should use the CLI to write
reviewable migration files.

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

`name` controls the class-name prefix. `timestamp` exists for reproducible output
and tests; normal CLI usage uses the current time.

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

Registers TimescaleDB repository/context providers for NestJS applications.

```ts
@Module({
  imports: [
    TimescaleModule.forFeature({
      dataSource: AppDataSource,
      entities: [Reading],
    }),
  ],
})
export class ReadingsModule {}
```

Use the NestJS guide for complete integration patterns.

### `TimescaleModuleOptions`

Options object used when registering the NestJS module. It identifies the
DataSource and entities that should receive Timescale providers.

### `InjectTimescaleRepository(entity, name?)`

NestJS injection decorator for a Timescale repository provider.

```ts
constructor(
  @InjectTimescaleRepository(Reading)
  private readonly readings: TimescaleRepository<Reading>,
) {}
```

### `InjectTimescaleContext(name?)`

NestJS injection decorator for the DataSource-scoped Timescale context.

```ts
constructor(
  @InjectTimescaleContext()
  private readonly timescale: TimescaleContext,
) {}
```

### `getTimescaleRepositoryToken(entity, name?)`

Returns the provider token for a Timescale repository.

### `getTimescaleContextToken(name?)`

Returns the provider token for a Timescale context.

### `DEFAULT_TIMESCALE_NAME`

Default provider namespace used by the NestJS integration.

## Core metadata types

The root package re-exports the main metadata/config types from
`@blueprime/timescaledb-core`:

### `HypertableOptions`

Configuration accepted by `@Hypertable()`.

Common fields include:

- `timeColumn`
- `chunkInterval`
- `spacePartition`
- `columnstore`
- `retention`

### `ColumnstoreOptions`

Columnstore configuration for a hypertable.

Common fields include:

- `segmentBy`
- `orderBy`
- `compressAfter`

### `RetentionOptions`

Retention policy configuration.

Common field:

- `dropAfter`

### `SpacePartitionOptions`

Optional secondary hash partition configuration.

Common fields:

- `column`
- `partitions`

### `TimescaleEntityMetadata`

Validated metadata stored for one hypertable entity.

### `DriftItem`

One schema assertion drift item returned by `assertSchema()` in warn mode or
attached to `TimescaleError(SCHEMA_DRIFT)` in assert mode.

## Validation and errors

### `parseHypertableOptions(input)`

Parses and validates raw hypertable options using the core metadata schema.

### `validateHypertableMetadata(metadata, entityName?)`

Validates stored hypertable metadata and throws `TimescaleError` when invalid.

### `TimescaleError`

Package-specific error class used for validation, migration generation, runtime,
and schema assertion failures.

### `TimescaleErrorCode`

Enum-like error-code export used to classify package errors. Common codes include
invalid arguments, missing time columns, non-hypertable entities, and schema
drift.

## What is not part of this API

The current public API does not include automatic destructive migrations,
automatic live configuration rewrites, continuous aggregates, hyperfunction query
expressions, or complete TimescaleDB feature coverage.

For unsupported live schema changes, write explicit TypeORM migrations and review
the generated SQL before applying it.

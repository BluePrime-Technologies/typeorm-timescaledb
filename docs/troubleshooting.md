# Troubleshooting

This page collects common setup, migration, runtime, query-layer, and NestJS
problems for `typeorm-timescaledb`.

Use this page as the first stop when something does not work. Each section gives
a symptom, likely cause, fix, and where to read next.

## Quick triage checklist

Before debugging a specific error, confirm these basics:

- You are running a supported Node version. See [Compatibility](compatibility.md).
- The project has compatible `typeorm`, `pg`, and `reflect-metadata` versions.
- Your database is TimescaleDB, not plain PostgreSQL.
- The `timescaledb` extension exists in the target database.
- TypeORM creates the base table before the TimescaleDB migration runs.
- The DataSource includes both the entity files and the generated migration files.
- TypeScript DataSource files are loaded with a TypeScript loader such as `tsx`,
  or you point the CLI at compiled JavaScript.

## Installation and package setup

### Import or runtime errors after install

**Symptom**

The application fails to start after installing the package, or TypeScript cannot
resolve expected imports.

**Likely cause**

One of the required peer dependencies is missing or outside the supported range.
Common missing packages are `typeorm`, `pg`, or `reflect-metadata`.

**Fix**

Install the package with the required TypeORM/PostgreSQL dependencies:

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

Then check the supported version ranges in [Compatibility](compatibility.md).

**Read next**

- [Installation](installation.md)
- [Compatibility](compatibility.md)

### Decorators or metadata do not behave as expected

**Symptom**

Entities compile, but decorators or metadata-dependent behavior does not work as
expected.

**Likely cause**

`reflect-metadata` is not imported before entity/decorator usage, or the project
TypeScript configuration is not set up for decorators.

**Fix**

Import `reflect-metadata` once near the application entry point or DataSource
setup before entities are loaded:

```ts
import 'reflect-metadata';
```

Also confirm your TypeScript decorator settings match the TypeORM setup your app
already uses.

**Read next**

- [Installation](installation.md)
- [Quickstart](quickstart.md)

## CLI and DataSource loading

### TypeScript DataSource cannot be loaded

**Symptom**

The CLI cannot load a `.ts` DataSource file, or Node reports that it does not
understand TypeScript syntax.

**Likely cause**

The CLI uses native dynamic `import()`. Node cannot import `.ts` files directly
without a TypeScript loader.

**Fix**

Run the CLI through `tsx` or another TypeScript loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

Or compile first and point `-d` at JavaScript:

```sh
npx typeorm-timescaledb generate -d dist/data-source.js -o dist/migrations
npx typeorm-timescaledb run -d dist/data-source.js
```

**Read next**

- [Migration guide](migration-guide.md)
- [Tutorial](tutorial.md)

### Environment variables are not loaded

**Symptom**

The DataSource loads, but connection values such as database name, port, or
password are missing or wrong.

**Likely cause**

The CLI imports your DataSource module. It does not automatically load your
project's `.env` file unless your DataSource code or command does that.

**Fix**

Use the same environment-loading strategy your application uses. For examples,
you can:

- export environment variables before running the CLI;
- load them in your DataSource file;
- run the command through a dotenv wrapper;
- compile a DataSource that already uses your app's config loader.

**Read next**

- [Docker Compose local setup](../examples/docker-compose-local/README.md)
- [Runnable quickstart example](../examples/quickstart/README.md)

### CLI runs but reports no pending migrations

**Symptom**

`generate` creates a migration file, but `run` reports no pending migrations.

**Likely cause**

The generated file path is not included in the TypeORM `DataSource` `migrations`
option. The `run` command delegates to TypeORM's `dataSource.runMigrations()`;
it does not read the output directory passed to `generate`.

**Fix**

Make sure the generated migration directory is included in the DataSource:

```ts
export const AppDataSource = new DataSource({
  // ...
  migrations: ['src/migrations/*.{ts,js}'],
});
```

Then run the CLI with the same DataSource.

**Read next**

- [Migration guide](migration-guide.md)

## Migration generation

### No hypertable entities found

**Symptom**

Migration generation completes without producing expected hypertable SQL, or the
CLI reports that no hypertable entities were found.

**Likely cause**

The entity is not registered in the DataSource, or the class does not have
`@Hypertable()` metadata.

**Fix**

Check that:

- the entity class uses `@Hypertable(...)`;
- the entity is included in the DataSource `entities` list;
- the DataSource path used by the CLI is the same one used by your app;
- the compiled JavaScript path includes the entity files when running from `dist`.

**Read next**

- [Quickstart](quickstart.md)
- [API reference](api-reference.md)

### Base table missing

**Symptom**

The generated migration fails because the target table does not exist.

**Likely cause**

`typeorm-timescaledb` adds the TimescaleDB layer. It does not create the base
TypeORM table.

**Fix**

Create the base table first through TypeORM's own migration workflow or your
existing schema setup. Then run the generated TimescaleDB migration.

In production, prefer explicit TypeORM migrations over `synchronize: true`.

**Read next**

- [Migration guide](migration-guide.md)
- [Production guide](production-guide.md)

### Generated hypertable conversion targets a table that already has rows

**Symptom**

You want to convert an existing populated table into a hypertable.

**Likely cause**

Generated hypertable conversion assumes an empty base table. Existing data needs
a deliberate migration and data-movement plan.

**Fix**

Do not rely on the generated conversion as the safe path for populated tables.
Write a hand-authored migration and test it against a realistic database copy.

**Read next**

- [Production guide](production-guide.md)
- [Migration guide](migration-guide.md)

## TimescaleDB setup

### TimescaleDB extension missing

**Symptom**

A migration fails because TimescaleDB functions such as hypertable creation are
not available.

**Likely cause**

The target database is missing the `timescaledb` extension, or the database is
plain PostgreSQL rather than TimescaleDB.

**Fix**

Create the extension before running generated migrations:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Do this through your database setup, an earlier migration, or an administrative
step approved by your team.

**Read next**

- [Migration guide](migration-guide.md)
- [Docker Compose local setup](../examples/docker-compose-local/README.md)

### Docker port conflicts

**Symptom**

The local TimescaleDB container does not start, or Docker reports that the port is
already allocated.

**Likely cause**

Another PostgreSQL or TimescaleDB instance is already using the host port, often
`5432`.

**Fix**

Change the host port in your `.env` or Compose configuration, for example:

```env
POSTGRES_PORT=55432
```

Then make sure your DataSource uses the same port.

**Read next**

- [Docker Compose local setup](../examples/docker-compose-local/README.md)
- [Tutorial](tutorial.md)

## Runtime and schema checks

### `assertSchema()` fails at startup

**Symptom**

The app starts, initializes the DataSource, then fails during `assertSchema()`.

**Likely cause**

The live database does not match the TimescaleDB metadata expected by the entity
configuration, or a required TimescaleDB migration has not been applied.

**Fix**

Check whether the expected generated migrations have run. If the database was
changed manually, compare the manual changes against your entity metadata.

Use warn mode temporarily when you need to log drift without stopping the process:

```ts
await assertSchema(AppDataSource, {
  mode: 'warn',
  logger: console.warn,
});
```

Use assert mode when drift should block startup:

```ts
await assertSchema(AppDataSource, { mode: 'assert' });
```

**Read next**

- [Production guide](production-guide.md)
- [API reference](api-reference.md)

### `assertSchema()` did not catch a database change

**Symptom**

A database change happened, but `assertSchema()` did not report it.

**Likely cause**

`assertSchema()` is a targeted sanity check, not a full database diff engine. It
only checks the package-scoped TimescaleDB state currently supported by the
library.

**Fix**

Use `assertSchema()` for supported drift checks, but do not treat it as a full
replacement for migration review, database inspection, or production monitoring.
For unsupported changes, write explicit checks or manual migrations as needed.

**Read next**

- [Production guide](production-guide.md)
- [Limitations](limitations.md)

## Config changes and manual migrations

### Changing retention, columnstore, chunk interval, or dimensions does not generate the change you expected

**Symptom**

After changing entity metadata, the generated migration does not fully alter or
remove existing TimescaleDB configuration.

**Likely cause**

The migration model is additive and desired-state oriented for the supported
TimescaleDB layer. It is not yet a full live configuration reconcile engine.

**Fix**

Use hand-written migrations for changes such as:

- changing an existing chunk interval;
- changing existing columnstore segment/order settings;
- changing an existing retention interval;
- removing a policy from metadata;
- reworking dimensions or space partitioning;
- changing TimescaleDB objects created outside the package.

**Read next**

- [Production guide](production-guide.md)
- [Migration guide](migration-guide.md)

### Generated `down()` does not undo everything

**Symptom**

Reverting a generated migration does not fully reverse all TimescaleDB effects.

**Likely cause**

Generated `down()` methods are intentionally non-destructive. Some TimescaleDB
operations cannot be safely reversed automatically without data loss or expensive
data movement.

**Fix**

Treat generated `down()` methods as conservative rollback helpers, not as a
promise to undo every physical database effect. Write manual rollback logic only
when your team has reviewed and accepted the data implications.

**Read next**

- [Production guide](production-guide.md)
- [Migration guide](migration-guide.md)

## Query layer and toolkit helpers

### `TSDB_TOOLKIT_MISSING`

**Symptom**

A toolkit-backed method fails with `TSDB_TOOLKIT_MISSING`.

**Likely cause**

The method requires the `timescaledb_toolkit` extension, but the extension is not
installed in the target database.

**Fix**

Install or enable `timescaledb_toolkit` in the database where the query runs, or
avoid toolkit-backed helpers for that environment.

Base hypertable and migration features require TimescaleDB. Toolkit-backed query
helpers require the additional toolkit extension.

**Read next**

- [Query layer guide](query-layer.md)
- [Compatibility](compatibility.md)

### Raw query results are strings, arrays, dates, or nulls

**Symptom**

Hyperfunction query results are not hydrated entity instances, or numeric-looking
values arrive as strings/nulls.

**Likely cause**

TimescaleDB hyperfunctions return raw database values. PostgreSQL drivers may
return large integers, timestamps, and arrays in shapes that need explicit
coercion.

**Fix**

Use the exported coercion helpers where appropriate:

```ts
import { toDate, toNumber, toBigIntString, toNumberArray } from 'typeorm-timescaledb';

const bucket = toDate(row.bucket, 'bucket');
const avgValue = toNumber(row.avgValue, 'avgValue');
const distinctSensors = toBigIntString(row.distinctSensors, 'distinctSensors');
const histogram = toNumberArray(row.valueBuckets, 'valueBuckets');
```

**Read next**

- [Query layer guide](query-layer.md)
- [API reference](api-reference.md)

### Gapfill query fails or gives unexpected buckets

**Symptom**

A gapfill query fails validation or returns a bucket range you did not expect.

**Likely cause**

Gap-filling requires bounded time ranges. Filled metrics such as `locf` and
`interpolate` also have ordering and metric compatibility rules.

**Fix**

Provide `range.from` and `range.to`, or provide `gapfill.start` and
`gapfill.finish`. Avoid descending order for filled gapfill metrics, and do not
use interpolation for count metrics.

**Read next**

- [Query layer guide](query-layer.md)

## NestJS

### Repository injection fails

**Symptom**

NestJS cannot resolve a Timescale repository provider.

**Likely cause**

The module graph does not include matching `TimescaleModule.forRoot(...)` and
`TimescaleModule.forFeature(...)` registrations, or the wrong context name is
used.

**Fix**

For the default context, register both root and feature modules:

```ts
TimescaleModule.forRoot({ dataSource: AppDataSource });
TimescaleModule.forFeature([Reading]);
```

For named contexts, use the same name everywhere:

```ts
TimescaleModule.forRoot({ name: 'analytics', dataSource: AnalyticsDataSource });
TimescaleModule.forFeature([Reading], 'analytics');
```

And inject with the same name:

```ts
@InjectTimescaleRepository(Reading, 'analytics')
private readonly readings: TimescaleRepository<Reading>;
```

**Read next**

- [NestJS guide](nestjs-guide.md)
- [API reference](api-reference.md)

### Multiple DataSources behave unexpectedly

**Symptom**

A plain TypeORM DataSource appears to receive Timescale behavior, or a Timescale
repository is resolved from the wrong connection.

**Likely cause**

The wrong DataSource or NestJS context name is being used in registration or
injection.

**Fix**

Keep each Timescale context explicitly named and pass the same name to `forRoot`,
`forFeature`, and injection helpers. The package is designed to avoid global
TypeORM mutation, so unexpected cross-DataSource behavior usually points to app
wiring rather than prototype patching.

**Read next**

- [NestJS guide](nestjs-guide.md)
- [Production guide](production-guide.md)

## Upgrade issues

### Upgrade changes query or migration behavior

**Symptom**

After upgrading the package, query helpers, generated migrations, or type exports
behave differently than expected.

**Likely cause**

The project may be relying on a behavior that changed, or it may be mixing docs
from one release line with packages from another.

**Fix**

Read `CHANGELOG.md` for the version you are adopting. Confirm the installed
package version and compare it with the docs branch or release tag you are using.
Run typechecking, tests, integration tests, and `assertSchema()` in staging before
production rollout.

**Read next**

- [Production guide](production-guide.md)
- [Feature status](feature-status.md)

## When to open an issue

Open an issue when:

- the same problem happens in a minimal reproduction;
- the docs say a workflow is supported but it does not work;
- an error message is unclear or misleading;
- a generated migration appears unsafe for the supported scope;
- a supported TypeORM, Node, or TimescaleDB version fails unexpectedly.

Include:

- package version;
- Node version;
- TypeORM version;
- TimescaleDB version;
- whether `timescaledb_toolkit` is installed;
- DataSource configuration shape;
- entity metadata;
- generated migration snippet if relevant;
- full error message and stack trace.

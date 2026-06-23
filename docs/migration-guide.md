# Migration guide

`typeorm-timescaledb` is migration-driven. It generates reviewable TimescaleDB
migrations from supported entity metadata.

## Responsibility split

TypeORM is responsible for the base table:

- Entity definition.
- Base `CREATE TABLE`.
- Regular TypeORM schema changes.

`typeorm-timescaledb` is responsible for the TimescaleDB layer:

- Converting the table into a hypertable.
- Applying chunk interval configuration.
- Applying columnstore configuration and policies.
- Applying retention policies.
- Applying space/hash partitioning.

## Database prerequisite

The target database must have the TimescaleDB extension enabled before the
generated migration calls TimescaleDB functions:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Create the extension through your database setup, an earlier migration, or a
manual administrative step.

## DataSource migrations configuration

The `generate` command writes a migration file to the output directory you pass
with `-o`. The `run` command does not read `-o`; it delegates to TypeORM's
`dataSource.runMigrations()`.

That means the generated path must also be included in the DataSource
`migrations` option, or the run step can report no pending migrations.

```ts
export const AppDataSource = new DataSource({
  // ...the rest of your DataSource options
  migrations: ["src/migrations/*.{ts,js}"],
});
```

## Generate

Compiled JavaScript DataSource:

```sh
npx typeorm-timescaledb generate -d dist/data-source.js -o dist/migrations
```

TypeScript DataSource with a loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
```

## Run

Compiled JavaScript DataSource:

```sh
npx typeorm-timescaledb run -d dist/data-source.js
```

TypeScript DataSource with a loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

## Revert

```sh
npx typeorm-timescaledb revert -d dist/data-source.js
```

Generated `down()` methods are intentionally non-destructive. They should not
drop data or undo hypertable conversion in a destructive way.

## Empty-table assumption for generated hypertable conversion

Generated hypertable conversion assumes the base table is empty. If the TypeORM
base table already contains rows, do not rely on the generated conversion as the
safe path.

For existing data, write a hand-authored migration and data-migration plan that
explicitly handles TimescaleDB conversion and data movement for your table.

## Manual migrations

Removing or altering existing TimescaleDB configuration is not fully auto-diffed
yet. Use hand-written migrations for changes such as removing a policy, changing
an existing chunk interval, or reworking dimensions.

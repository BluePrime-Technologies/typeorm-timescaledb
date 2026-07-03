# Article: Migration safety in typeorm-timescaledb

Working title: **Why typeorm-timescaledb uses reviewable migrations instead of schema magic**

## Audience

Backend engineers, platform teams, and maintainers who want to understand the
package's production-safety model before adopting it.

## Draft

Time-series database features can be powerful, but production database changes
should not be surprising.

`typeorm-timescaledb` is designed around that idea. It brings supported
TimescaleDB workflows into TypeORM, but it does not try to hide database changes
behind runtime magic.

The package follows a clear production model:

1. TypeORM creates and owns the base table.
2. `typeorm-timescaledb` adds the supported TimescaleDB layer.
3. TimescaleDB changes are generated as reviewable migration files.
4. Generated rollback behavior is intentionally non-destructive.
5. Runtime schema checks are targeted sanity checks, not a full diff engine.
6. Risky or unsupported changes belong in hand-written migrations.

## Why TypeORM creates the base table

TypeORM already has a model for entities, columns, indexes, relations, and normal
migration execution. `typeorm-timescaledb` does not replace that model.

Instead, it treats the TypeORM-created table as the base relational object and
then layers supported TimescaleDB behavior on top.

This keeps the responsibility boundary clear:

- TypeORM owns ordinary table lifecycle.
- `typeorm-timescaledb` owns supported TimescaleDB metadata and migration
  generation.

That boundary also makes the package easier to reason about in applications with
multiple DataSources or existing TypeORM conventions.

## Why generated migrations are reviewable

Production teams normally expect database changes to be visible before they are
applied. They want to know what SQL will run, when it will run, and how it will be
rolled out.

`typeorm-timescaledb` follows that pattern by generating migration files rather
than silently mutating the database at application boot.

A safe workflow looks like this:

1. Add or update TimescaleDB metadata on the entity.
2. Generate a migration.
3. Read the generated migration.
4. Test it locally or in staging against a real TimescaleDB database.
5. Commit it.
6. Review it in a pull request.
7. Deploy it through the normal migration pipeline.

This is especially important for hypertables, retention policies, columnstore
policies, dimensions, and long-lived production data.

## Why `down()` is non-destructive

Rollback is not always simple in TimescaleDB.

Some operations involve data layout, background jobs, policies, or hypertable
state. Automatically reversing them can be unsafe, expensive, or impossible
without business context.

For that reason, generated `down()` methods are conservative. They should not be
read as a promise that every physical database effect will be fully reversed.

The intent is:

- avoid silent data loss;
- avoid pretending unsafe reversals are safe;
- allow non-destructive cleanup where appropriate;
- leave high-risk reversal behavior to hand-written migrations.

If a rollback needs product knowledge, data movement, or downtime planning, it
should be explicit.

## Where `assertSchema()` fits

`assertSchema()` helps catch supported drift between entity metadata and the live
TimescaleDB state.

It can be used at boot time:

```ts
import { assertSchema } from 'typeorm-timescaledb';

await AppDataSource.initialize();
await assertSchema(AppDataSource, { mode: 'assert' });
```

Or in warn mode:

```ts
await assertSchema(AppDataSource, {
  mode: 'warn',
  logger: console.warn,
});
```

This is useful, but it is not a full database diff engine. It does not replace
migration review, database monitoring, or manual inspection for unsupported
TimescaleDB objects.

## When to write a manual migration

Use a hand-written migration when the change requires operational judgment.
Examples include:

- changing an existing chunk interval;
- changing existing retention policy behavior;
- replacing columnstore segment/order settings;
- reworking dimensions or space partitioning;
- converting a table that already has rows;
- removing TimescaleDB objects created outside the package;
- performing destructive or data-moving rollback work.

The manual migration should use normal TypeORM migration structure and explicit
`queryRunner.query(...)` calls. Keep it small, reviewed, and tested.

## The launch message

The safety model is simple:

`typeorm-timescaledb` helps TypeORM teams adopt supported TimescaleDB workflows
without turning production schema changes into hidden runtime behavior.

It is not a magic auto-diff engine. It is a reviewable, production-minded bridge
between TypeORM and TimescaleDB.

## Links to include before publishing

- Production guide
- Migration guide
- Troubleshooting guide
- API reference
- Supply-chain trust guide

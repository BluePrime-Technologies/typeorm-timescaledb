# Production guide

This guide explains how to use `typeorm-timescaledb` safely in real TypeORM
applications.

The package is production-minded, but it is still pre-1.0 and intentionally
conservative. It gives teams reviewable TimescaleDB migrations, scoped runtime
access, and targeted drift checks. It does not try to silently rewrite live
TimescaleDB configuration for every metadata change.

## Production model

Use this mental model in production:

1. TypeORM creates and owns the base relational table.
2. `typeorm-timescaledb` adds the TimescaleDB layer on top of that table.
3. TimescaleDB changes are generated as reviewable migrations.
4. Generated `down()` methods avoid destructive rollback behavior.
5. Runtime helpers are scoped to the TypeORM `DataSource` you pass in.
6. `assertSchema()` is a targeted sanity check, not a full schema diff engine.
7. Existing live configuration changes may require hand-written migrations.

This split keeps the package compatible with normal TypeORM workflows while still
making TimescaleDB-specific behavior explicit and reviewable.

## Why TypeORM creates the base table

TypeORM already owns entity modeling, columns, indexes, regular relations, and
base table creation. `typeorm-timescaledb` does not replace that responsibility.

Keep using TypeORM for ordinary table lifecycle work:

- entity definitions;
- regular `CREATE TABLE` behavior;
- non-TimescaleDB columns and indexes;
- TypeORM-owned migrations;
- normal TypeORM migration ordering.

That means the base table must exist before a generated TimescaleDB migration can
convert it into a hypertable. You can create the base table with TypeORM's own
migration workflow, or with your project's existing database setup process.

In production, prefer explicit TypeORM migrations over `synchronize: true`.
Generated TimescaleDB migrations assume a predictable table shape and should be
reviewed as part of the same database-change process as other migrations.

## Why this package adds the TimescaleDB layer

TimescaleDB features are not ordinary TypeORM table options. A hypertable,
columnstore policy, retention policy, or space partition is database-specific
behavior that TypeORM does not model directly.

`typeorm-timescaledb` reads entity metadata such as `@Hypertable()` and
`@TimeColumn()` and generates the TimescaleDB-specific setup for the supported
scope:

- hypertable conversion;
- chunk interval configuration;
- optional space/hash partitioning;
- columnstore configuration and policy setup;
- retention policy setup.

The boundary is deliberate:

- TypeORM owns the base table.
- `typeorm-timescaledb` owns the supported TimescaleDB layer.

That boundary makes the generated SQL easier to reason about and avoids surprising
changes to TypeORM itself.

## Why migrations are reviewable

The package does not silently apply TimescaleDB changes at runtime. Instead, it
creates migration files that can be committed, reviewed, tested, and deployed
through your existing process.

A production migration flow should look like this:

1. Update the entity metadata.
2. Generate a TimescaleDB migration.
3. Read the generated migration file.
4. Run the migration locally against a real TimescaleDB database.
5. Commit the reviewed migration.
6. Let CI run formatting, typechecking, unit tests, and integration tests.
7. Apply the migration through your normal deployment pipeline.

This makes database changes visible. The generated file is an artifact your team
owns after generation; it should not be treated as an invisible runtime side
effect.

## Why generated `down()` is non-destructive

Generated rollback code is intentionally conservative. TimescaleDB operations can
involve live data, background jobs, compressed data, dimensions, and policies.
Some operations cannot be safely reversed automatically without data loss or
expensive data movement.

For that reason, generated `down()` methods should not be expected to undo every
physical database effect. They are designed to avoid destructive behavior such as
silently dropping data, rewriting live hypertables, or pretending a conversion can
always be reversed safely.

Examples of the intended philosophy:

- removing a policy job may be reasonable when the operation is non-destructive;
- undoing hypertable conversion automatically is not assumed safe;
- changing existing dimensions or chunk intervals is not auto-reconciled;
- data-moving or destructive rollback steps belong in hand-written migrations.

When a rollback requires business context, write it manually and review it like
any other production data migration.

## How to use `assertSchema()`

`assertSchema()` is a boot-time sanity check for the TimescaleDB metadata this
package knows how to inspect. Use it to catch obvious drift between your entity
metadata and the live database.

You can call it directly:

```ts
import { assertSchema } from 'typeorm-timescaledb';

await AppDataSource.initialize();
await assertSchema(AppDataSource);
```

Or through the scoped Timescale context:

```ts
import { createTimescale } from 'typeorm-timescaledb';

await AppDataSource.initialize();

const ts = createTimescale(AppDataSource);
await ts.assertSchema();
```

Use assert mode when the application should fail fast on detected drift:

```ts
await assertSchema(AppDataSource, { mode: 'assert' });
```

Use warn mode when you want to record drift but keep the process running:

```ts
const drift = await assertSchema(AppDataSource, {
  mode: 'warn',
  logger: console.warn,
});
```

`assertSchema()` is useful for checking package-scoped TimescaleDB state such as:

- whether expected tables are hypertables;
- whether expected dimension columns exist;
- whether expected columnstore policy jobs exist;
- whether expected retention policy jobs exist.

It is not a full database diff engine. Do not rely on it to detect every possible
manual database change, every policy variation, every changed chunk interval, or
every unsupported TimescaleDB object.

## How to handle config changes not yet auto-diffed

The generated migration model is additive and desired-state oriented for the
supported TimescaleDB layer. It is good at adding supported configuration from
entity metadata. It is not yet a full reconcile engine for every change to live
TimescaleDB configuration.

Treat these changes as manual-review situations:

- changing an existing chunk interval;
- changing existing columnstore segment/order settings;
- changing an existing retention policy interval;
- removing a policy from metadata;
- reworking dimensions or space partitioning;
- converting a table that already has rows;
- changing TimescaleDB objects that were created outside this package.

A safe production process is:

1. Identify the live object that already exists.
2. Decide whether the change is additive, altering, data-moving, or destructive.
3. Prefer a hand-written migration for altering or removal behavior.
4. Test the migration on a copy or local reproduction of the database.
5. Run `assertSchema()` after the migration when applicable.
6. Document the operational decision in the migration or PR description.

If the package does not generate the exact change you need, do not force it
through metadata alone. Write the migration explicitly.

## How to write manual migrations when needed

Use normal TypeORM migrations for manual TimescaleDB changes. Keep them explicit,
small, and reviewed.

A safe manual migration should include:

- a clear migration name;
- the exact TimescaleDB operation being changed;
- a non-destructive rollback when possible;
- comments explaining any irreversible behavior;
- local testing against a real TimescaleDB database.

Example shape:

```ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AdjustTimescalePolicy0000000000000 implements MigrationInterface {
  name = 'AdjustTimescalePolicy0000000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Put the reviewed TimescaleDB operation here.
    // Keep this explicit and tested before production deployment.
    await queryRunner.query('/* reviewed TimescaleDB SQL */');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only include rollback behavior that is safe for your data and workload.
    await queryRunner.query('/* reviewed non-destructive rollback SQL */');
  }
}
```

Avoid hiding risky operational decisions inside generated files. If a change needs
human judgment, make that judgment visible in a hand-written migration.

## How to upgrade safely

Use the same discipline for package upgrades that you use for database changes.

Recommended upgrade flow:

1. Read `CHANGELOG.md` for the version you are adopting.
2. Check `docs/feature-status.md` for shipped and planned scope.
3. Upgrade the package in a branch.
4. Run typechecking and unit tests.
5. Run integration tests against a real TimescaleDB instance.
6. Regenerate migrations only when entity metadata changed or the release notes
   tell you to do so.
7. Review any generated migration before committing it.
8. Apply migrations in a staging environment.
9. Run `assertSchema()` against staging.
10. Deploy through the same migration pipeline used for other database changes.

Do not combine an application upgrade, package upgrade, and large schema rewrite
unless your team can test and roll back the whole change safely.

## Production checklist

Before using the package in production, confirm that:

- TypeORM creates the base tables before TimescaleDB migrations run.
- The TimescaleDB extension exists before generated migrations call TimescaleDB
  functions.
- Generated migrations are committed and reviewed.
- Generated `down()` methods are understood as conservative and non-destructive.
- Manual migrations exist for unsupported altering/removal operations.
- Integration tests run against a real TimescaleDB database.
- `assertSchema()` is used where boot-time drift checks are useful.
- Upgrade notes and changelog entries are reviewed before package upgrades.
- Operationally risky changes are documented in the migration PR.

## What this guide does not promise

This guide does not claim that `typeorm-timescaledb` automatically handles every
TimescaleDB production scenario. The current package does not promise:

- a full entity-to-database diff engine;
- automatic destructive migrations;
- automatic live configuration rewrites;
- automatic data migration for existing populated tables;
- complete TimescaleDB feature coverage.

For unsupported or high-risk changes, use hand-written migrations and your normal
production database review process.

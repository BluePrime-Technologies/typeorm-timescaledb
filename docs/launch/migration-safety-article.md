# Migration safety article draft

> Working title: Why `typeorm-timescaledb` uses reviewable migrations instead of hidden database changes

Time-series database changes are operationally important. A hypertable conversion, retention policy, columnstore policy, or dimension change can affect data layout, background jobs, storage behavior, and rollback expectations.

That is why `typeorm-timescaledb` is designed around reviewable migrations instead of hidden runtime changes.

## The core safety model

The package uses a simple production model:

1. TypeORM creates the base relational table.
2. `typeorm-timescaledb` adds the supported TimescaleDB layer.
3. TimescaleDB changes are generated as TypeORM migrations.
4. Teams review those migrations before applying them.
5. Generated rollback behavior stays conservative.
6. High-risk changes use hand-written migrations.

This keeps TimescaleDB behavior visible and avoids surprising production database changes at application startup.

## Why TypeORM creates the base table

TypeORM already owns normal entity modeling, columns, indexes, and table creation. `typeorm-timescaledb` does not try to replace that system.

Instead, the package focuses on the TimescaleDB-specific layer that TypeORM does not model directly: hypertables, retention policies, columnstore setup, and related metadata.

This gives teams a clear ownership boundary:

- TypeORM owns the base table.
- `typeorm-timescaledb` owns the supported TimescaleDB layer.

## Why generated migrations are reviewable

Production teams usually want database changes to be:

- visible in code review;
- version-controlled;
- tested in CI or staging;
- deployed through a known migration pipeline;
- auditable after the fact.

A generated migration file fits that workflow. A hidden runtime database rewrite does not.

With `typeorm-timescaledb`, generation is only the beginning. The generated migration becomes an artifact your team reviews and owns.

## Why `down()` is non-destructive

A rollback function can be dangerous when it pretends every operation is safely reversible.

TimescaleDB operations may involve live data, background jobs, compression or columnstore state, dimensions, chunks, and policies. Some changes cannot be undone automatically without business context.

For that reason, generated `down()` methods are intentionally conservative. They may remove non-destructive policy state when appropriate, but they should not be expected to reverse every physical database effect.

If a rollback requires data movement, table rewrites, or business judgment, write it manually.

## What `assertSchema()` is for

`assertSchema()` is a runtime sanity check for the TimescaleDB metadata this package knows how to inspect.

Use it to catch supported drift such as expected hypertables or expected policy jobs. Use assert mode when drift should fail startup, and warn mode when you only want to log drift.

It is not a full database diff engine. It does not replace migration review, database monitoring, or hand-written checks for unsupported objects.

## Config changes still need judgment

Some changes should be treated as manual-review situations:

- changing an existing chunk interval;
- changing retention policy behavior;
- changing existing columnstore order or segment settings;
- removing policies from metadata;
- changing dimensions or space partitioning;
- converting a table that already has production data;
- changing objects created outside this package.

For these cases, write a hand-authored TypeORM migration with explicit TimescaleDB SQL and test it against a realistic database.

## Safe upgrade workflow

When upgrading the package:

1. Read the changelog.
2. Confirm the version scope in the docs.
3. Upgrade in a branch.
4. Run typechecking and tests.
5. Run integration tests against TimescaleDB.
6. Review any generated migration.
7. Apply migrations in staging first.
8. Run `assertSchema()` where useful.
9. Deploy through the normal migration pipeline.

Do not combine a package upgrade and a large live schema rewrite unless your team can test and roll back the full change safely.

## The principle

`typeorm-timescaledb` should make supported TimescaleDB workflows easier, but not invisible.

The goal is not magic. The goal is a clear, reviewable path from TypeScript metadata to TimescaleDB behavior that production teams can reason about.

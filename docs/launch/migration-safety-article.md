# Article draft: Migration safety in typeorm-timescaledb

Working title: **Why typeorm-timescaledb uses reviewable migrations instead of runtime magic**

## Audience

Backend engineers, platform teams, reviewers, and engineering managers who care
about production database safety.

## Draft

Database libraries can be convenient, but convenience becomes risky when it hides
schema changes from the team responsible for production data.

`typeorm-timescaledb` intentionally uses a reviewable migration model. The goal is
not to make TimescaleDB disappear. The goal is to let TypeORM teams adopt
TimescaleDB behavior while keeping database changes visible, explicit, and safe to
review.

## The responsibility boundary

The package follows a clear split:

- TypeORM owns the base relational table.
- `typeorm-timescaledb` adds the supported TimescaleDB layer.

That means a normal TypeORM migration should create the table, columns, indexes,
and ordinary relational structure. Then `typeorm-timescaledb` can generate the
TimescaleDB-specific migration for supported hypertable metadata, retention,
columnstore, and partitioning behavior.

This is important because TypeORM already has a table model and migration system.
The package does not replace that system. It extends the workflow where
TimescaleDB-specific behavior begins.

## Why generated migrations are reviewable

A hypertable conversion or retention policy is a real database decision. It
should not be a hidden side effect of application startup.

A production team should be able to ask:

- What SQL will run?
- Which table will it affect?
- Is it additive or destructive?
- Does it require a maintenance window?
- How will rollback work?
- Has this been tested against real TimescaleDB?

Reviewable migrations make those questions answerable before deployment.

## Why `down()` is conservative

Generated `down()` methods are intentionally non-destructive.

TimescaleDB objects can involve live data, background jobs, compression or
columnstore behavior, hypertable dimensions, and policy state. Not every change
can be reversed automatically without risk.

For that reason, generated rollback behavior should not pretend to undo every
physical database effect. Removing a policy can be reasonable when it is safe.
Automatically reversing a hypertable conversion or rewriting a live table is not a
safe default.

When rollback requires business context, the team should write that migration by
hand.

## Where `assertSchema()` fits

`assertSchema()` is a targeted runtime sanity check. It helps detect supported
drift between entity metadata and the live TimescaleDB state.

Use it when you want startup or deployment checks such as:

```ts
import { assertSchema } from 'typeorm-timescaledb';

await AppDataSource.initialize();
await assertSchema(AppDataSource, { mode: 'assert' });
```

Use warn mode when drift should be logged but should not fail the process:

```ts
await assertSchema(AppDataSource, {
  mode: 'warn',
  logger: console.warn,
});
```

The important caveat: `assertSchema()` is not a full database diff engine. It is a
package-scoped sanity check for supported TimescaleDB metadata.

## When manual migrations are the right answer

Manual migrations are not a failure of the package. They are the correct tool when
a change requires production judgment.

Use hand-written migrations for situations such as:

- changing an existing chunk interval;
- replacing or removing a retention policy;
- changing columnstore segment/order behavior on an existing table;
- reworking dimensions or space partitioning;
- converting a populated table;
- altering TimescaleDB objects created outside the package;
- doing anything data-moving or destructive.

A good manual migration should be small, explicit, tested, and reviewed.

## Safe upgrade workflow

Treat package upgrades like database changes:

1. Read the changelog.
2. Confirm compatibility.
3. Upgrade in a branch.
4. Run typecheck and tests.
5. Run integration tests against TimescaleDB.
6. Regenerate migrations only when metadata changed or the release notes require
   it.
7. Review generated migrations.
8. Test in staging.
9. Run `assertSchema()` where applicable.
10. Deploy through the normal migration pipeline.

## The design principle

`typeorm-timescaledb` is designed around one principle: TimescaleDB behavior should
be explicit enough for production teams to trust.

The package gives TypeORM users a structured path to TimescaleDB, but it avoids
pretending that production database changes are risk-free.

That is why the workflow is reviewable, conservative, and honest about what still
requires manual migration work.

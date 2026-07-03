# Short demo script

Use this script for a 2 to 5 minute product demo, launch video, internal walkthrough, or community post.

## Demo goal

Show that `typeorm-timescaledb` gives TypeORM developers a reviewable path to TimescaleDB hypertables and time-series helpers without hiding database changes.

## Demo outline

### 1. Opening

"This is `typeorm-timescaledb`, a TypeORM-first integration for TimescaleDB. The goal is to let TypeScript teams keep normal TypeORM workflows while adding supported TimescaleDB behavior through reviewable migrations."

### 2. Show the entity

Open the `Reading` entity.

Point out:

- it is still a normal TypeORM entity;
- `@Hypertable()` declares TimescaleDB metadata;
- `@TimeColumn()` marks the time dimension;
- the package does not globally mutate TypeORM.

Suggested narration:

"TypeORM still owns the base table. The TimescaleDB metadata tells the package what Timescale layer to add after the table exists."

### 3. Generate the migration

Run the migration generation command from the tutorial or example project.

Suggested narration:

"Instead of silently changing the database at runtime, the package generates a normal TypeORM migration. This is important because production teams need to review database changes."

### 4. Open the migration

Show the generated file briefly.

Point out:

- it is a TypeORM migration file;
- the SQL is visible;
- the file can be committed and reviewed;
- rollback behavior is conservative.

### 5. Run the migration

Run the migration against the local TimescaleDB database.

Suggested narration:

"The run command delegates to TypeORM's migration runner, so this fits into the migration workflow teams already use."

### 6. Verify the hypertable

Run a query against `timescaledb_information.hypertables`.

Suggested narration:

"Now we can see that the TypeORM-created table has the TimescaleDB hypertable layer."

### 7. Show a query helper or grouped query

Show a simple time-bucket query or point to the query-layer guide.

Suggested narration:

"For analytics workflows, the package also includes query helpers for common TimescaleDB patterns such as buckets, gapfill, candlesticks, approximate distinct counts, and supported toolkit helper families."

### 8. Show production-safety docs

Open the production guide.

Mention:

- generated migrations are reviewable;
- `down()` is non-destructive by design;
- `assertSchema()` can check supported drift;
- config changes that are not auto-diffed should be manual migrations.

### 9. Closing

"The key idea is not magic. The key idea is a clear boundary: TypeORM owns the base table, `typeorm-timescaledb` adds the supported TimescaleDB layer, and your team reviews the migration before it touches production."

## Short version

Use this when you only have one minute:

"`typeorm-timescaledb` helps TypeORM teams use TimescaleDB without hiding database changes. You model a TypeORM entity, add TimescaleDB metadata, generate a reviewable migration, run it through TypeORM, and verify the hypertable. It also includes NestJS support, schema assertions, and typed query helpers. It is pre-1.0, so high-risk config changes still belong in hand-written migrations."

## Links to show during demo

- README
- Installation guide
- Quickstart
- 10-minute tutorial
- Docker Compose local setup
- Runnable quickstart example
- Production guide
- Troubleshooting guide
- Query layer guide

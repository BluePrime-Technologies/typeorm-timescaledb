# Short demo script

This script is for a 2-5 minute launch demo, live walkthrough, or short product
video.

## Goal

Show that `typeorm-timescaledb` lets a TypeORM developer move from an entity to a
reviewable TimescaleDB migration and a basic time-series query workflow.

## Setup before recording

Have these ready:

- repository cloned;
- dependencies installed;
- local TimescaleDB running through Docker Compose;
- `.env` configured;
- terminal panes for code, migration command, and database verification;
- docs open to the quickstart or tutorial.

## Script

### 1. Opening

"This is `typeorm-timescaledb`, a TypeORM-first integration for TimescaleDB. The
idea is simple: keep the TypeORM workflow, but add supported TimescaleDB behavior
through reviewable migrations and typed helpers."

### 2. Show the entity

Open the `Reading` entity.

"Here we have a normal TypeORM entity. The TimescaleDB-specific intent is declared
with `@Hypertable()` and `@TimeColumn()`."

Point out:

- time column;
- primary key shape;
- chunk interval;
- value column.

Say:

"TypeORM still creates the base table. This package adds the supported
TimescaleDB layer on top."

### 3. Show the DataSource

Open the DataSource.

"The DataSource is still a normal TypeORM DataSource. The important production
setting is that migrations are explicit and `synchronize` is disabled."

### 4. Generate the migration

Run:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate \
  -d src/data-source.ts \
  -o src/migrations \
  -n add-reading-hypertable
```

Say:

"The output is a TypeORM migration file. It is meant to be opened, reviewed,
committed, and deployed through the same process as other database changes."

### 5. Run the migration

Run:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

Say:

"The run command delegates to TypeORM's migration runner, so this fits into an
existing TypeORM migration workflow."

### 6. Verify the hypertable

Run a database check such as:

```sql
SELECT hypertable_name FROM timescaledb_information.hypertables;
```

Say:

"Now the base TypeORM table has the TimescaleDB hypertable layer."

### 7. Show query helper

Open a small query example.

Say:

"The query layer helps with common TimescaleDB query patterns like time buckets,
gapfill, histograms, candlesticks, and toolkit-backed helpers where supported."

Mention that raw results should be coerced with helpers like `toDate()` and
`toNumber()`.

### 8. Production safety close

Say:

"The package is pre-1.0, so the docs are explicit about what is supported. It
does not promise complete TimescaleDB coverage or automatic live config
auto-diffing. For production changes, read the production guide, review generated
migrations, and write manual migrations when needed."

### 9. Call to action

"Start with the quickstart or the 10-minute tutorial, run the Docker example, and
open an issue with real workflows you want supported next."

## Optional 30-second version

"`typeorm-timescaledb` brings TimescaleDB workflows into TypeORM. You define a
normal TypeORM entity, add TimescaleDB metadata, generate a reviewable migration,
and run it through TypeORM's migration pipeline. The package also includes NestJS
support, typed query helpers, production guidance, troubleshooting docs, and
package smoke tests. It is pre-1.0, so the docs are clear about supported scope
and when manual migrations are required."

## Demo links to show

- README
- Quickstart
- Tutorial
- Docker Compose local setup
- Runnable quickstart example
- Production guide
- Troubleshooting guide

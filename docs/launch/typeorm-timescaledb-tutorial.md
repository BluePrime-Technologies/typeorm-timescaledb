# Tutorial draft: TimescaleDB with TypeORM

Working title: **Using TimescaleDB with TypeORM, without leaving TypeORM migrations**

## Goal

Show a developer how to use `typeorm-timescaledb` in a TypeORM project from entity
metadata to reviewable TimescaleDB migration.

This article should feel practical and copyable. It can reuse the repository's
quickstart and 10-minute tutorial, but it should be written as an external blog
or docs-site article.

## What you will build

A small `Reading` entity that stores time-series sensor values in PostgreSQL with
TimescaleDB hypertable behavior.

By the end, the reader should understand:

- TypeORM creates the base table;
- `typeorm-timescaledb` adds the TimescaleDB layer;
- generated migrations are reviewed before running;
- TimescaleDB setup is explicit, not hidden runtime behavior.

## Prerequisites

- Node.js supported by the package.
- A TypeORM project using PostgreSQL.
- A TimescaleDB database.
- The `timescaledb` extension enabled in that database.
- Basic TypeORM DataSource familiarity.

For local setup, point readers to the Docker Compose guide.

## Install

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

Import `reflect-metadata` once before entities are loaded:

```ts
import 'reflect-metadata';
```

## Define the entity

```ts
import { Column, Entity, PrimaryColumn } from 'typeorm-timescaledb';
import { Hypertable, TimeColumn } from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({
  timeColumn: 'time',
  chunkTimeInterval: '1 day',
})
export class Reading {
  @PrimaryColumn('timestamptz')
  @TimeColumn()
  time!: Date;

  @PrimaryColumn('text')
  sensorId!: string;

  @Column('double precision')
  value!: number;
}
```

The entity is still a TypeORM entity. The TimescaleDB metadata tells the package
how to generate the supported hypertable layer.

## Configure the DataSource

```ts
import { DataSource } from 'typeorm-timescaledb';
import { Reading } from './entities/Reading.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  database: process.env.POSTGRES_DB ?? 'app',
  entities: [Reading],
  migrations: ['src/migrations/*.{ts,js}'],
  synchronize: false,
});
```

For production, keep `synchronize: false` and use explicit migrations.

## Create the base table

TypeORM owns the base relational table. Create that table with your existing
TypeORM migration workflow.

The important concept is the boundary:

- TypeORM creates `reading` with normal columns and keys.
- `typeorm-timescaledb` converts the supported table into a hypertable and adds
  the supported TimescaleDB configuration.

## Generate the TimescaleDB migration

For TypeScript DataSource files, run the CLI through a TypeScript loader such as
`tsx`:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate \
  -d src/data-source.ts \
  -o src/migrations \
  -n AddReadingHypertable
```

Open the generated migration before running it. It should be treated as a
reviewable database artifact, not hidden runtime behavior.

## Run migrations

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run \
  -d src/data-source.ts
```

The `run` command delegates to TypeORM's migration runner. That means your
DataSource `migrations` pattern must include the generated file.

## Verify the hypertable

In a local database, verify with TimescaleDB's information views:

```sql
SELECT hypertable_name
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'reading';
```

For application startup checks, use `assertSchema()`:

```ts
import { assertSchema } from 'typeorm-timescaledb';

await AppDataSource.initialize();
await assertSchema(AppDataSource, { mode: 'assert' });
```

Use `mode: 'warn'` when you want to log supported drift without failing startup.

## Query time-series data

Use TypeORM for ordinary writes and reads. Use the query layer for supported
TimescaleDB time-series query patterns such as time buckets, gapfill, and
supported toolkit-backed helpers.

Example article direction:

```ts
import { createTimescale } from 'typeorm-timescaledb';

const ts = createTimescale(AppDataSource);
const readings = ts.getRepository(Reading);

// Build supported time-series queries with the query layer.
```

Keep this tutorial focused on the migration workflow. Point to the query-layer
guide for deeper query examples.

## Production safety notes

Before using this in production:

- review generated migrations;
- keep `down()` behavior conservative and non-destructive;
- use manual migrations for unsupported config changes;
- run integration tests against real TimescaleDB;
- use `assertSchema()` as a targeted sanity check, not a full diff engine.

## Where to go next

- Quickstart
- 10-minute tutorial
- Docker Compose local setup
- Runnable quickstart example
- Migration guide
- Production guide
- Troubleshooting guide

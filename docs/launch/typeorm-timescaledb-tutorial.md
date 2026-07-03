# TimescaleDB + TypeORM tutorial draft

> Working title: Use TimescaleDB with TypeORM without losing reviewable migrations

This tutorial shows the public launch version of the core `typeorm-timescaledb` workflow: define a TypeORM entity, add TimescaleDB metadata, generate a migration, run it, and verify the hypertable.

Use this as an article-style tutorial for developer communities, blog platforms, or documentation-site launch content.

## What you will build

You will model sensor readings as a TypeORM entity and convert the table into a TimescaleDB hypertable through a generated migration.

The important idea is the ownership boundary:

- TypeORM creates the base table.
- `typeorm-timescaledb` adds the supported TimescaleDB layer.
- You review the generated migration before applying it.

## Prerequisites

You need:

- Node.js supported by the package;
- TypeORM;
- PostgreSQL driver package `pg`;
- a TimescaleDB database;
- the `timescaledb` extension enabled;
- `reflect-metadata` configured as required by TypeORM.

For local testing, use the Docker Compose guide or runnable quickstart example in the repository.

## Install

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

## Create the entity

```ts
import { Column, Entity, PrimaryColumn } from 'typeorm-timescaledb';
import { Hypertable, TimeColumn } from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({
  timeColumn: 'time',
  chunkInterval: '1 day',
  retention: { dropAfter: '30 days' },
})
export class Reading {
  @PrimaryColumn('text')
  sensorId!: string;

  @TimeColumn()
  time!: Date;

  @Column('double precision')
  value!: number;
}
```

The entity is still a TypeORM entity. The TimescaleDB-specific metadata tells `typeorm-timescaledb` what supported TimescaleDB layer should be added after the base table exists.

## Configure the DataSource

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm-timescaledb';
import { Reading } from './entities/Reading.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.POSTGRES_USER ?? 'timescale',
  password: process.env.POSTGRES_PASSWORD ?? 'timescale',
  database: process.env.POSTGRES_DB ?? 'app',
  entities: [Reading],
  migrations: ['src/migrations/*.{ts,js}'],
  synchronize: false,
});
```

For production-like workflows, keep `synchronize: false` and use explicit migrations.

## Create the base table

TypeORM should create the base relational table before the TimescaleDB migration runs. Use your normal TypeORM migration workflow or your existing database setup process.

A simplified base table migration might create the `reading` table with `sensorId`, `time`, and `value` columns.

## Generate the TimescaleDB migration

If your DataSource is TypeScript, run the CLI through a TypeScript loader such as `tsx`:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate \
  -d src/data-source.ts \
  -o src/migrations \
  -n AddReadingHypertable
```

The output is a TypeORM migration file. Read it before committing it.

## Run the migration

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

The run command delegates to TypeORM's migration runner, so the generated migration must be included in your `DataSource.migrations` configuration.

## Verify the hypertable

Use TimescaleDB's information views:

```sql
SELECT hypertable_name
FROM timescaledb_information.hypertables
WHERE hypertable_name = 'reading';
```

You should see the `reading` hypertable.

## Add a runtime assertion

You can add a startup sanity check for supported TimescaleDB metadata:

```ts
import { assertSchema } from 'typeorm-timescaledb';

await AppDataSource.initialize();
await assertSchema(AppDataSource, { mode: 'assert' });
```

Use `mode: 'warn'` if you want to log drift without failing startup.

## Query time-series data

Use TypeORM for normal reads and writes. Use the query-layer helpers when you need TimescaleDB expressions such as time buckets or toolkit-backed analytics.

Example shape:

```ts
import { createTimescale } from 'typeorm-timescaledb';

const ts = createTimescale(AppDataSource);
const readings = ts.getRepository(Reading);

const rows = await readings
  .queryBuilder('reading')
  .select("time_bucket('1 hour', reading.time)", 'bucket')
  .addSelect('avg(reading.value)', 'avgValue')
  .groupBy('bucket')
  .orderBy('bucket', 'ASC')
  .getRawMany();
```

Use the query-layer guide for the typed helper APIs and result coercion helpers.

## Production notes

Before using this workflow in production:

- review generated migrations;
- test against a real TimescaleDB database;
- avoid generated conversion for populated tables unless you have reviewed the migration plan;
- use hand-written migrations for unsupported config changes;
- run `assertSchema()` where drift checks are useful;
- read the production guide.

## Next steps

Continue with:

- the 10-minute tutorial;
- Docker Compose local setup;
- runnable quickstart example;
- production guide;
- troubleshooting guide.

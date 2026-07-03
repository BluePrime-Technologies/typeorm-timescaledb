# Tutorial: Use TimescaleDB with TypeORM

This launch tutorial is a public-facing article version of the developer docs. It
should be published only after links are updated to the final repository/docs
URLs.

## Goal

Show a TypeORM developer how to add TimescaleDB behavior without abandoning the
TypeORM workflow.

By the end, the reader should understand:

- TypeORM creates the base table.
- `typeorm-timescaledb` adds the supported TimescaleDB layer.
- migrations are generated as reviewable files;
- production changes should still go through normal migration review.

## Prerequisites

- Node.js supported by the package
- PostgreSQL with TimescaleDB enabled
- A TypeORM project using PostgreSQL
- `reflect-metadata` configured for TypeORM

For local testing, use the Docker Compose setup or runnable quickstart example in
the repository.

## 1. Install the package

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

Use the compatibility guide to confirm supported TypeORM, Node.js, PostgreSQL,
and TimescaleDB versions.

## 2. Define a time-series entity

This example stores sensor readings.

```ts
import { Column, Entity, PrimaryColumn } from "typeorm-timescaledb";
import { Hypertable, TimeColumn } from "typeorm-timescaledb";

@Entity()
@Hypertable({
  timeColumn: "time",
  chunkInterval: "1 day",
})
export class Reading {
  @PrimaryColumn("timestamptz")
  @TimeColumn()
  time!: Date;

  @PrimaryColumn("text")
  sensorId!: string;

  @Column("double precision")
  value!: number;
}
```

The important design point is the split of responsibility:

- TypeORM sees a normal entity and owns the base table.
- `typeorm-timescaledb` reads the TimescaleDB metadata and generates supported
  TimescaleDB setup.

## 3. Register the entity in your DataSource

```ts
import "reflect-metadata";
import { DataSource } from "typeorm-timescaledb";
import { Reading } from "./entities/Reading.js";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? "5432"),
  username: process.env.POSTGRES_USER ?? "timescale",
  password: process.env.POSTGRES_PASSWORD ?? "timescale",
  database: process.env.POSTGRES_DB ?? "app",
  entities: [Reading],
  migrations: ["src/migrations/*.{ts,js}"],
  synchronize: false,
});
```

For production, keep `synchronize: false` and use explicit migrations.

## 4. Create the base table

`typeorm-timescaledb` does not replace TypeORM's table creation model. Create the
base table with your normal TypeORM migration process or your existing schema
setup.

This keeps table ownership clear and avoids surprising global TypeORM behavior.

## 5. Generate the TimescaleDB migration

When your DataSource is TypeScript, run the CLI through a TypeScript loader such
as `tsx`:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate \
  -d src/data-source.ts \
  -o src/migrations \
  -n AddReadingHypertable
```

If you compile first, point the CLI at compiled JavaScript:

```sh
npx typeorm-timescaledb generate -d dist/data-source.js -o dist/migrations
```

Open the generated migration and review it before committing.

## 6. Run the migration

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

The run command delegates to TypeORM's migration runner. Make sure your
DataSource `migrations` glob includes the generated file.

## 7. Add a startup sanity check

Use `assertSchema()` to catch supported drift between entity metadata and the
live TimescaleDB state.

```ts
import { assertSchema } from "typeorm-timescaledb";

await AppDataSource.initialize();
await assertSchema(AppDataSource, { mode: "assert" });
```

For softer rollout, use warn mode:

```ts
await assertSchema(AppDataSource, {
  mode: "warn",
  logger: console.warn,
});
```

`assertSchema()` is not a full database diff engine. It is a targeted sanity
check for the TimescaleDB state this package knows how to inspect.

## 8. Query time-series data

The query layer gives typed helpers for common TimescaleDB expressions and raw
result coercion.

```ts
import { createTimescale, toDate, toNumber } from "typeorm-timescaledb";

const ts = createTimescale(AppDataSource);
const readings = ts.getRepository(Reading);

const rows = await readings.getTimeBucket({
  interval: "1 hour",
  range: {
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2026-01-02T00:00:00Z"),
  },
  metrics: [{ alias: "avgValue", fn: "avg", column: "value" }],
});

const first = rows[0];
const bucket = toDate(first.bucket, "bucket");
const avgValue = toNumber(first.avgValue, "avgValue");
```

Raw database results may need coercion because PostgreSQL drivers can return
numeric values, dates, arrays, and nulls in driver-specific shapes.

## Production notes

Before using this flow in production, read the production guide. In particular:

- generated migrations should be reviewed;
- generated `down()` methods are intentionally non-destructive;
- existing live configuration changes may require manual migrations;
- changing policies, dimensions, or chunk intervals should be treated as a
  deliberate database operation.

## Where to go next

- Quickstart
- 10-minute tutorial
- Docker Compose local setup
- Runnable quickstart example
- Production guide
- Troubleshooting guide
- API reference

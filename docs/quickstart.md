# Quickstart

This quickstart shows the shortest path from a TypeORM entity to a TimescaleDB
migration.

For a complete local walkthrough with Docker, full files, expected output,
insert/query verification, and cleanup, use the [10-minute tutorial](tutorial.md).

## 1. Define an entity

```ts
import {
  Entity,
  PrimaryColumn,
  Column,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
} from "typeorm-timescaledb";

@Entity("reading")
@Hypertable({
  chunkInterval: "1 day",
  columnstore: {
    segmentBy: ["sensorId"],
    orderBy: [{ column: "time", direction: "DESC" }],
    compressAfter: "7 days",
  },
  retention: { dropAfter: "90 days" },
})
export class Reading {
  @PrimaryColumn({ type: "timestamptz" })
  @TimeColumn()
  @HypertablePrimaryKey()
  time!: Date;

  @Column({ type: "text" })
  sensorId!: string;

  @Column({ type: "double precision" })
  value!: number;
}
```

## 2. Prepare the database and DataSource

`typeorm-timescaledb` adds the TimescaleDB layer. Your TypeORM setup still owns
the base `CREATE TABLE` step through `synchronize` or a TypeORM migration.

The target database must already have the TimescaleDB extension enabled:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Also make sure your TypeORM DataSource includes the generated migrations path.
The `run` command delegates to `dataSource.runMigrations()`, so it only applies
migrations that the DataSource already knows about.

```ts
export const AppDataSource = new DataSource({
  // ...the rest of your DataSource options
  migrations: ["src/migrations/*.{ts,js}"],
});
```

You can also point generation at an existing migrations directory that is already
configured in the DataSource.

## 3. Generate the TimescaleDB migration

If the DataSource path is a compiled JavaScript file, call the published binary
directly:

```sh
npx typeorm-timescaledb generate -d dist/data-source.js -o dist/migrations
```

If the DataSource path is a TypeScript file, run the CLI with a TypeScript loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
```

A `.ts` DataSource path without a loader fails because the CLI loads the
DataSource with native dynamic `import()`.

## 4. Apply the migration

Use the same DataSource format you used for generation.

Compiled JavaScript example:

```sh
npx typeorm-timescaledb run -d dist/data-source.js
```

TypeScript loader example:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

## 5. Use the runtime context

```ts
import { createTimescale } from "typeorm-timescaledb";

const ts = createTimescale(dataSource);
const readings = ts.getRepository(Reading);
await ts.assertSchema();
```

`assertSchema()` is useful as a boot-time sanity check, but it is not a full
database diff engine. See the [Production guide](production-guide.md) for its
current comparison scope.

## Next

Continue to the [10-minute tutorial](tutorial.md) when you want a full local
setup with TimescaleDB, complete TypeScript files, expected output, insert/query
steps, and cleanup.

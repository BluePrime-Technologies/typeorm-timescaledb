# 10-minute tutorial

This tutorial walks from a clean local project to a working TypeORM entity backed
by TimescaleDB.

You will:

1. Create a demo project.
2. Start TimescaleDB locally.
3. Configure TypeScript.
4. Define a hypertable entity.
5. Create the DataSource.
6. Create the base table.
7. Generate the TimescaleDB migration.
8. Run the TimescaleDB migration.
9. Insert and query a row.
10. Understand what `assertSchema()` checks here.

## Prerequisites

- Node `^20.19.0 || >=22.12.0`.
- Docker with Compose support.
- npm.

This tutorial uses TypeScript files directly with `tsx`. The CLI examples keep
both migration generation and migration execution on the TypeScript-loader path
because generated TimescaleDB migration files are TypeScript source files.

## 1. Create a demo project

```sh
mkdir typeorm-timescaledb-demo
cd typeorm-timescaledb-demo
npm init -y
npm pkg set type=module
```

The `type=module` setting is required for this tutorial because `tsconfig.json`
uses `module: "NodeNext"` and the scripts below use top-level `await`.

Install runtime dependencies:

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

Install TypeScript tooling for the tutorial:

```sh
npm install -D typescript tsx @types/node
```

Create folders:

```sh
mkdir -p docker src/entities src/migrations
```

## 2. Start TimescaleDB locally

Create `docker/init.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: timescale/timescaledb:2.18.0-pg16
    environment:
      POSTGRES_USER: timescale
      POSTGRES_PASSWORD: timescale
      POSTGRES_DB: tutorial
    ports:
      - '5432:5432'
    volumes:
      - ./docker/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
```

Port conflict warning: this tutorial maps PostgreSQL to local port `5432`. If
you already have PostgreSQL running on that port and Docker reports that the
address is already in use, change the compose mapping to another host port, for
example:

```yaml
ports:
  - '55432:5432'
```

If you use a different host port, use that same value in `src/data-source.ts`
when you create the DataSource below:

```ts
port: 55432,
```

Start the database:

```sh
docker compose up -d
```

Confirm the extension is available in the target database:

```sh
docker compose exec db psql -U timescale -d tutorial -c "\dx timescaledb"
```

Expected result: the command prints a `timescaledb` extension row.

## 3. Configure TypeScript

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

## 4. Define a hypertable entity

Create `src/entities/Reading.ts`:

```ts
import {
  Column,
  Entity,
  Hypertable,
  HypertablePrimaryKey,
  PrimaryColumn,
  TimeColumn,
} from 'typeorm-timescaledb';

@Entity('reading')
@Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['sensorId'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})
export class Reading {
  @PrimaryColumn({ type: 'timestamptz' })
  @TimeColumn()
  @HypertablePrimaryKey()
  time!: Date;

  @Column({ type: 'text' })
  sensorId!: string;

  @Column({ type: 'double precision' })
  value!: number;
}
```

## 5. Create the DataSource

Create `src/data-source.ts`:

```ts
import 'reflect-metadata';
import { DataSource } from 'typeorm-timescaledb';
import { Reading } from './entities/Reading.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  username: 'timescale',
  password: 'timescale',
  database: 'tutorial',
  entities: [Reading],
  migrations: ['src/migrations/*.{ts,js}'],
  synchronize: false,
  logging: false,
});
```

The `migrations` option is important. The `generate` command writes a TypeScript
migration file to `src/migrations`, and the `run` command delegates to TypeORM's
`dataSource.runMigrations()`. If the DataSource does not include the generated
migration path, `run` can report that there are no pending migrations.

## 6. Create the base table

`typeorm-timescaledb` adds the TimescaleDB layer. TypeORM still owns the base
`CREATE TABLE` step.

For this tutorial only, create a small script that synchronizes the base TypeORM
table. In production, prefer normal TypeORM migrations for base table changes.

Create `src/create-base-table.ts`:

```ts
import { AppDataSource } from './data-source.js';

await AppDataSource.initialize();
await AppDataSource.synchronize();
await AppDataSource.destroy();

console.log('Base TypeORM table created.');
```

Run it:

```sh
npx tsx src/create-base-table.ts
```

Expected output:

```txt
Base TypeORM table created.
```

## 7. Generate the TimescaleDB migration

Because this tutorial points `-d` at a `.ts` DataSource file, run the CLI through
a TypeScript loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
```

Expected result: a new TypeScript migration file appears under `src/migrations`.

Check it:

```sh
ls src/migrations
```

The file name includes a timestamp and will differ on each run. It should look
similar to:

```txt
1700000000000-Timescale.ts
```

Open it: it is a standard TypeORM `MigrationInterface` containing the concrete
TimescaleDB statements for the `reading` hypertable metadata, such as hypertable
creation, columnstore policy setup, and retention policy setup. Treat it as a
generated artifact you review and commit; regenerate rather than hand-editing.

Generated TimescaleDB migration files are TypeScript source files. Keep the
`run` step below on the same TypeScript-loader path unless your application build
has compiled those migration files to JavaScript and your DataSource points at
the compiled output.

## 8. Run the TimescaleDB migration

Run the generated migration with the same TypeScript loader approach:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

Expected result: TypeORM reports that it ran the pending migration.

Confirm that TimescaleDB sees the hypertable:

```sh
docker compose exec db psql -U timescale -d tutorial -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
```

Expected result: the output includes `reading`.

## 9. Insert and query a row

Create `src/demo.ts`:

```ts
import { createTimescale } from 'typeorm-timescaledb';
import { AppDataSource } from './data-source.js';
import { Reading } from './entities/Reading.js';

await AppDataSource.initialize();

const ts = createTimescale(AppDataSource);
await ts.assertSchema();

const readings = ts.getRepository(Reading);

await readings.insert({
  time: new Date(),
  sensorId: 'sensor-1',
  value: 42.5,
});

const latest = await readings.find({
  order: { time: 'DESC' },
  take: 1,
});

console.log(latest);

await AppDataSource.destroy();
```

Run it:

```sh
npx tsx src/demo.ts
```

Expected result: the command prints one `Reading` row with `sensor-1` and
`42.5`.

## 10. What `assertSchema()` checks here

`assertSchema()` is useful as a scoped boot-time sanity check, but it is not a
full database diff engine.

Treat it as a targeted check for the metadata currently compared by the package,
such as expected hypertables, expected dimension columns, and expected
columnstore/retention policy jobs. Do not rely on it to catch every changed
chunk interval, ordering change, retention interval change, or extra policy.

## Common problems

### `ERR_UNKNOWN_FILE_EXTENSION` for `src/data-source.ts`

The CLI loads the DataSource with native dynamic `import()`. Use `tsx` or another
TypeScript loader for `.ts` DataSource files, or point `-d` at compiled
JavaScript only after your build emits compiled DataSource and migration files.

### `Cannot find module '.../entities/Reading.js'` for `src/data-source.ts`

On Node versions with native type stripping enabled by default (currently `≥
22.18` and `≥ 23.6`), running the CLI directly with `node` (no `tsx`) against a
`.ts` DataSource _does_ import the file — but native type stripping does not
remap `.js`-suffixed import specifiers back to their sibling `.ts` files the way
`tsx` does, so an import like `./entities/Reading.js` fails to resolve even
though `Reading.ts` exists. Run the CLI through `tsx` (as in this tutorial) or
another loader that remaps `.js` specifiers to `.ts`, or point `-d` at compiled
JavaScript whose imports already resolve to compiled output.

### `No pending migrations`

Confirm that `src/data-source.ts` includes the generated directory in the
`migrations` option:

```ts
migrations: ['src/migrations/*.{ts,js}'];
```

### `create_hypertable` is missing

Confirm the target database has the extension:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

### The base table does not exist

Run the base table step again:

```sh
npx tsx src/create-base-table.ts
```

### The base table already has data

Generated hypertable conversion assumes an empty table. Existing data needs a
hand-written migration and data-migration plan.

## Cleanup

Stop and remove the local database container:

```sh
docker compose down -v
```

Remove the demo project directory when finished.

## Next

- Read the [Migration guide](migration-guide.md) before using this in a real app.
- Read the [Production guide](production-guide.md) before relying on generated
  migrations in production.
- Read [Limitations](limitations.md) to understand what is not shipped in 0.1.x.

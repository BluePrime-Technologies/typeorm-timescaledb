# Docker Compose local TimescaleDB setup

This example gives developers a reusable local TimescaleDB database for trying
`typeorm-timescaledb` without configuring a remote database.

It is intentionally small: it only starts TimescaleDB, enables the extension, and
shows the exact environment and TypeORM DataSource settings to use from an app,
tutorial, or example project.

## What this includes

- TimescaleDB container.
- Safe local environment variables.
- TimescaleDB extension initialization SQL.
- Copyable TypeORM DataSource config.
- Setup command.
- Migration command.
- Test command.
- Cleanup command.

## Files

```txt
examples/docker-compose-local/
  .env.example
  docker-compose.yml
  init.sql
  data-source.ts
  README.md
```

## 1. Prepare environment variables

From this directory:

```sh
cp .env.example .env
```

The defaults are safe for local development:

```env
POSTGRES_USER=timescale
POSTGRES_PASSWORD=timescale
POSTGRES_DB=typeorm_timescaledb_local
POSTGRES_PORT=5432
TIMESCALEDB_IMAGE=timescale/timescaledb:2.18.0-pg16
```

Do not use these credentials in production.

## 2. Start TimescaleDB

```sh
docker compose up -d
```

The container runs `init.sql` on first database creation:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

That means the local database is ready for `create_hypertable` and other
TimescaleDB functions.

## 3. Test the local database

Check container health:

```sh
docker compose ps
```

Check the extension:

```sh
docker compose exec timescaledb psql -U timescale -d typeorm_timescaledb_local -c "\dx timescaledb"
```

Expected result: the output includes a `timescaledb` extension row.

## 4. Use the DataSource config

Use `data-source.ts` as the starting point for a local TypeORM project:

```ts
import "reflect-metadata";
import { DataSource } from "typeorm-timescaledb";

const port = Number(process.env.POSTGRES_PORT ?? "5432");

export const LocalTimescaleDataSource = new DataSource({
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "localhost",
  port,
  username: process.env.POSTGRES_USER ?? "timescale",
  password: process.env.POSTGRES_PASSWORD ?? "timescale",
  database: process.env.POSTGRES_DB ?? "typeorm_timescaledb_local",
  entities: ["src/entities/*.{ts,js}"],
  migrations: ["src/migrations/*.{ts,js}"],
  synchronize: false,
  logging: false,
});
```

Keep the `migrations` path aligned with where your generated migration files are
written. The `typeorm-timescaledb run` command delegates to TypeORM's
`dataSource.runMigrations()`.

## 5. Migration command

For a TypeScript DataSource, run the CLI through a TypeScript loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

Generated TimescaleDB migrations are TypeScript source files. If your application
runs compiled JavaScript, generate into source, compile the app, and make sure the
compiled DataSource points at the compiled migration output.

## 6. Verify hypertables after migration

After running a migration that creates a hypertable, verify it with:

```sh
docker compose exec timescaledb psql -U timescale -d typeorm_timescaledb_local -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
```

Expected result: the output includes the hypertable name generated from your
entity metadata.

## 7. Stop and clean up

Stop the container but keep the database volume:

```sh
docker compose down
```

Remove the container and local database volume:

```sh
docker compose down -v
```

## Notes

- TypeORM still owns the base `CREATE TABLE` step.
- `typeorm-timescaledb` adds the TimescaleDB layer through generated migrations.
- The TimescaleDB extension must exist before running generated migrations.
- Generated hypertable conversion assumes an empty base table. Existing data
  requires a hand-written migration plan.

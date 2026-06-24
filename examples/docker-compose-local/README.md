# Docker Compose local TimescaleDB setup

This example gives developers a local TimescaleDB database for trying
`typeorm-timescaledb` without configuring a remote database.

It intentionally avoids a nested `package.json` because `examples/*` is part of
the repository pnpm workspace. The commands below are meant to be copied into a
real app, tutorial project, or local experiment that already installs
`typeorm-timescaledb`.

## What this includes

- TimescaleDB container.
- Environment variables.
- DataSource config.
- Setup command.
- Migration command.
- Test command.

## Files

```txt
examples/docker-compose-local/
  .env.example
  docker-compose.yml
  init.sql
  data-source.ts
  README.md
```

## TimescaleDB container

`docker-compose.yml` starts one TimescaleDB service named `timescaledb`.

The service:

- Uses `timescale/timescaledb:2.18.0-pg16` by default.
- Persists data in the `timescaledb-data` volume.
- Publishes PostgreSQL on the configured local port.
- Runs `init.sql` on first database creation.
- Adds a `pg_isready` healthcheck.

## Environment variables

Create a local `.env` file from the example:

```sh
cp .env.example .env
```

Default values:

```env
POSTGRES_USER=timescale
POSTGRES_PASSWORD=timescale
POSTGRES_DB=typeorm_timescaledb_local
POSTGRES_PORT=5432
TIMESCALEDB_IMAGE=timescale/timescaledb:2.18.0-pg16
```

These values are for local development only.

## DataSource config

Use `data-source.ts` as a starting point for a local TypeORM DataSource:

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

Keep the `migrations` path aligned with the directory where generated migration
files are written.

## Setup command

From `examples/docker-compose-local`:

```sh
cp .env.example .env
docker compose up -d
```

The first startup runs `init.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

That prepares the local database for generated TimescaleDB migrations.

## Migration command

For a TypeScript DataSource, run the CLI through a TypeScript loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

If the DataSource is compiled JavaScript, call the published binary directly:

```sh
npx typeorm-timescaledb generate -d dist/data-source.js -o dist/migrations
npx typeorm-timescaledb run -d dist/data-source.js
```

## Test command

Check the container health:

```sh
docker compose ps
```

Check that TimescaleDB is installed in the local database:

```sh
docker compose exec timescaledb psql -U timescale -d typeorm_timescaledb_local -c "\dx timescaledb"
```

After running a generated migration, check hypertables:

```sh
docker compose exec timescaledb psql -U timescale -d typeorm_timescaledb_local -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
```

## Cleanup command

Stop the container but keep the local volume:

```sh
docker compose down
```

Remove the container and local volume:

```sh
docker compose down -v
```

## Notes

- TypeORM still owns the base `CREATE TABLE` step.
- `typeorm-timescaledb` adds the TimescaleDB layer through generated migrations.
- The TimescaleDB extension must exist before generated migrations run.
- Generated hypertable conversion assumes an empty base table.

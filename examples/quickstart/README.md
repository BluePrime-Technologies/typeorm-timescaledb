# Runnable quickstart example

This is a standalone mini-project that demonstrates the shortest working path
from a TypeORM entity to a TimescaleDB hypertable managed by
`typeorm-timescaledb`.

It is intentionally excluded from the repository pnpm workspace so it can keep a
normal example `package.json` without changing the root monorepo lockfile.

## What this example does

- Starts a local TimescaleDB container.
- Creates the TimescaleDB extension.
- Defines one TypeORM entity with `@Hypertable` metadata.
- Creates the base table with TypeORM for local demo purposes.
- Generates a TimescaleDB migration.
- Runs the generated migration.
- Inserts and queries one row.
- Verifies that TimescaleDB sees the hypertable.

## Prerequisites

- Node `>=22.12.0`.
- Docker with Compose support.
- npm.

## Setup

Install dependencies:

```sh
npm install
```

Create a local environment file:

```sh
cp .env.example .env
```

Start TimescaleDB and wait for the healthcheck:

```sh
npm run db:up
```

Expected output: Docker Compose starts a `db` container and reports it as healthy.

## Run the quickstart

Run the full path:

```sh
npm run quickstart
```

This command runs, in order:

1. `npm run db:up`
2. `npm run table:create`
3. `npm run migration:generate`
4. `npm run migration:run`
5. `npm run demo`
6. `npm run verify:hypertable`

Expected output includes:

```txt
Base TypeORM table created.
```

The demo step prints one row similar to:

```txt
[
  Reading {
    time: 2026-01-01T00:00:00.000Z,
    sensorId: 'sensor-1',
    value: 42.5
  }
]
```

The hypertable verification step should include:

```txt
 reading
```

## Run each step manually

Create the base table:

```sh
npm run table:create
```

Generate the TimescaleDB migration:

```sh
npm run migration:generate
```

Expected result: a timestamped TypeScript migration appears under
`src/migrations`, for example:

```txt
1700000000000-Timescale.ts
```

Run the generated migration:

```sh
npm run migration:run
```

Run the demo insert/query script:

```sh
npm run demo
```

Verify the hypertable:

```sh
npm run verify:hypertable
```

## Port conflicts

This example maps PostgreSQL to local port `5432`. If you already have
PostgreSQL running locally and Docker reports that the address is already in use,
change `.env`:

```env
POSTGRES_PORT=55432
```

Then update `src/data-source.ts` to use the same port:

```ts
port: Number(process.env.POSTGRES_PORT ?? '5432'),
```

The default DataSource already reads `POSTGRES_PORT`, so no code change is needed
when you export the environment value before running scripts. The npm scripts
load `.env` automatically with `dotenv-cli`.

## Cleanup

Stop and remove the container and local database volume:

```sh
npm run db:down
```

Remove installed dependencies if desired:

```sh
rm -rf node_modules package-lock.json
```

## Notes

- TypeORM owns the base `CREATE TABLE` step.
- `typeorm-timescaledb` adds the TimescaleDB layer through generated migrations.
- Generated migrations are TypeScript source files.
- Generated hypertable conversion assumes an empty base table.
- For production, prefer normal TypeORM migrations for base table changes instead
  of `synchronize()`.

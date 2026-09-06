# Installation

Install the public package with TypeORM, PostgreSQL driver, and `reflect-metadata`:

```sh
npm install typeorm-timescaledb typeorm pg reflect-metadata
```

## Requirements

- Node `>=22.12.0`.
- TypeORM `^0.3.20 || ^1.0.0`.
- TimescaleDB `>= 2.18`.
- PostgreSQL driver package such as `pg`.
- `reflect-metadata` loaded once by the application.

## Package shape

The package ships:

- ESM entrypoint.
- CommonJS entrypoint.
- TypeScript declarations.
- CLI binary: `typeorm-timescaledb`.
- Optional NestJS subpath: `typeorm-timescaledb/nestjs`.

## Peer dependencies

NestJS packages are optional peers. Install them only when using the NestJS integration.

## Next

Continue to the [Quickstart](quickstart.md) to define a hypertable entity and generate a TimescaleDB migration.

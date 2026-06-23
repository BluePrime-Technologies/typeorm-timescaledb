# Compatibility

This page lists the public compatibility surface for the current package scope.

## Runtime support

| Area        | Supported range                        |
| ----------- | -------------------------------------- |
| Node.js     | `^20.19.0 \|\| >=22.12.0`              |
| TypeORM     | `^0.3.20 \|\| ^1.0.0`                  |
| TimescaleDB | `>= 2.18`                              |
| NestJS      | Optional peers declared by the package |

## Package formats

`typeorm-timescaledb` ships:

- ESM build.
- CommonJS build.
- TypeScript declarations.
- CLI binary.
- Optional NestJS subpath export.

## Database compatibility

The package expects a PostgreSQL database with TimescaleDB installed. TimescaleDB features such as hypertables, columnstore policies, retention policies, and space partitioning require TimescaleDB support in the target database.

## CI expectation

Compatibility claims should remain aligned with package metadata and CI matrix coverage. When either changes, update this page and npm-facing docs together.

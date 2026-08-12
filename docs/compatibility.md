# Compatibility

This page lists the public compatibility surface for the current package scope.

## Runtime support

| Area        | Supported range                        |
| ----------- | -------------------------------------- |
| Node.js     | `^20.19.0 \|\| >=22.12.0`              |
| TypeORM     | `^0.3.20 \|\| ^1.0.0`                  |
| PostgreSQL  | 16, 17, 18                             |
| TimescaleDB | `>= 2.18`, tested through 2.29.1       |
| NestJS      | Optional peers declared by the package |

### What "tested" means here

The support claim above is what CI actually exercises, not an aspiration. Every version in the
matrix is a pinned tag, so re-running an old build runs the same server it ran the first time:

| TimescaleDB | PostgreSQL | Why this version is in the matrix                                                       |
| ----------- | ---------- | --------------------------------------------------------------------------------------- |
| 2.18.0      | 16         | The floor. The columnstore DDL we emit landed in 2.18.0.                                |
| 2.19.0      | 16         | `compression_settings.relid` re-keys from the compressed twin to the user-facing chunk. |
| 2.26.0      | 17         | `_timescaledb_catalog.chunk.dropped` removed.                                           |
| 2.29.1      | 17         | The ceiling.                                                                            |
| 2.29.1      | 18         | The PostgreSQL 18 axis.                                                                 |

PostgreSQL 18 is supported: TimescaleDB has supported it since 2.23.0, and the full integration
suite passes against 2.29.1-pg18. It was previously untested and undeclared purely because the
matrix's ceiling was the floating `latest-pg17` tag, which pinned the PG axis to 17 as a side effect.

A **scheduled weekly job** runs the suite against the floating `latest-pg17` and `latest-pg18` as an
early warning for upstream catalog changes. It is deliberately non-blocking: nothing has shipped
against `latest` and no claim on this page covers it. When it breaks, the fix is to add a pinned
matrix row for the new version and update this table.

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

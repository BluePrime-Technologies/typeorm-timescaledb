# Troubleshooting

This page collects common first-use problems and where to look next.

## TypeScript DataSource cannot be loaded

The CLI uses native dynamic import. If the `-d` DataSource file is TypeScript, run the CLI through a TypeScript loader such as `tsx` or `ts-node`, or point `-d` at compiled JavaScript.

## Base table missing

`typeorm-timescaledb` adds the TimescaleDB layer. The base table must already be created by TypeORM through `synchronize` or a TypeORM migration.

## No hypertable entities found

Check that the entity is included in the DataSource entity list and that the entity uses `@Hypertable` metadata.

## TimescaleDB extension missing

Confirm the database is running TimescaleDB and that the extension is available in the target database.

## TypeORM or Node version mismatch

Check [Compatibility](compatibility.md) for the supported version ranges.

## NestJS injection issues

When using multiple DataSources, confirm the same context name is used during module registration and repository injection.

## More to add

This page should expand over time as users report setup, migration, and runtime problems.

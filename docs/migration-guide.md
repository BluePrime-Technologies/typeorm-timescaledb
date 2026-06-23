# Migration guide

`typeorm-timescaledb` is migration-driven. It generates reviewable TimescaleDB migrations from supported entity metadata.

## Responsibility split

TypeORM is responsible for the base table:

- Entity definition.
- Base `CREATE TABLE`.
- Regular TypeORM schema changes.

`typeorm-timescaledb` is responsible for the TimescaleDB layer:

- Converting the table into a hypertable.
- Applying chunk interval configuration.
- Applying columnstore configuration and policies.
- Applying retention policies.
- Applying space/hash partitioning.

## Generate

```sh
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations
```

## Run

```sh
npx typeorm-timescaledb run -d src/data-source.ts
```

## Revert

```sh
npx typeorm-timescaledb revert -d src/data-source.ts
```

Generated `down()` methods are intentionally non-destructive. They should not drop data or undo hypertable conversion in a destructive way.

## Manual migrations

Removing or altering existing TimescaleDB configuration is not fully auto-diffed yet. Use hand-written migrations for changes such as removing a policy or changing an existing chunk interval.

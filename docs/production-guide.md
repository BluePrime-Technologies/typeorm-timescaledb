# Production guide

This guide explains how to use the current 0.1.x scope safely in real TypeORM
projects.

## Production model

- TypeORM owns the base table.
- `typeorm-timescaledb` adds the TimescaleDB layer.
- Generated migrations are reviewable.
- Generated `down()` methods are non-destructive.
- Runtime access is scoped to a `DataSource`.
- `assertSchema()` is a targeted boot-time sanity check, not a full database diff
  engine.

## Migration safety

Generated migrations are additive and desired-state oriented. They are designed
to apply supported TimescaleDB configuration idempotently.

Use hand-written migrations when removing or altering existing TimescaleDB
configuration.

Generated hypertable conversion assumes an empty base table. Existing tables
with rows need a hand-authored migration and data-migration plan.

## Current drift-check scope

`assertSchema()` should be treated as a targeted check for the metadata currently
compared by the package.

It can check for issues such as:

- Whether expected hypertables exist.
- Whether expected dimension columns exist.
- Whether columnstore policy jobs exist when expected.
- Whether retention policy jobs exist when expected.

It should not be described as a full drift detector for every metadata change.
For example, do not rely on it to catch every changed chunk interval,
`segmentBy`/`orderBy` change, retention interval change, or extra policy.

## Operational recommendations

- Review generated migrations before applying them.
- Run integration tests against a real TimescaleDB instance.
- Create the TimescaleDB extension before applying generated migrations.
- Use `assertSchema()` as a scoped boot-time sanity check where useful.
- Keep TypeORM migrations and TimescaleDB migrations ordered deliberately.
- Document manual migrations that change existing policies or dimensions.

## Not yet covered

This skeleton will later expand into deployment guidance, rollback examples,
upgrade notes, and production troubleshooting.

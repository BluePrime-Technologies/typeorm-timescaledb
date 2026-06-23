# Limitations

`typeorm-timescaledb` is a pre-1.0 foundation release. It is useful today for the supported scope, but it is not a complete TimescaleDB abstraction yet.

## Not shipped in 0.1.x

The following features are planned or future scope, not shipped functionality:

- Continuous aggregates.
- Hyperfunction query expressions.
- Full entity-to-database diff engine.
- Validated cross-store references.
- Automatic destructive or altering migrations.
- Complete TimescaleDB feature coverage.

## Migration limitations

Generated migrations are additive and desired-state oriented. They apply supported TimescaleDB configuration idempotently.

Removing or altering existing TimescaleDB configuration is not fully auto-diffed yet. Use a hand-written migration for changes such as:

- Removing a retention policy.
- Changing an existing chunk interval.
- Reworking dimensions.
- Reversing TimescaleDB configuration that could affect live data.

## Base table ownership

TypeORM remains responsible for creating and changing base tables. This package adds the TimescaleDB layer on top.

## Documentation status

The documentation skeleton exists first so users can see the intended docs structure. Some pages are starter pages and will be expanded in later steps.

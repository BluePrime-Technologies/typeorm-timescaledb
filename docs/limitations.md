# Limitations

`typeorm-timescaledb` is a pre-1.0 foundation release. It is useful today for the
supported scope, but it is not a complete TimescaleDB abstraction yet.

See [Feature status](feature-status.md) for the authoritative, versioned
breakdown of what is shipped, what is in the current release scope, and what is
planned. This page covers structural limitations that are expected to hold
across releases rather than a version-pinned feature list.

## Not yet shipped

The following features are planned or future scope, not shipped functionality:

- Continuous aggregates.
- Full entity-to-database diff engine.
- Validated cross-store references.
- Complete TimescaleDB feature coverage.

Automatic destructive migrations are not planned as a public promise. Changes
that could drop data, destructively reverse hypertable conversion, or make unsafe
alterations require explicit hand-written migrations controlled by the user.

## Migration limitations

Generated migrations are additive and desired-state oriented. They apply
supported TimescaleDB configuration idempotently.

Removing or altering existing TimescaleDB configuration is not fully auto-diffed
yet. Use a hand-written migration for changes such as:

- Removing a retention policy.
- Changing an existing chunk interval.
- Reworking dimensions.
- Reversing TimescaleDB configuration that could affect live data.

## Existing data limitation

Generated hypertable conversion assumes the base table is empty. If the base
TypeORM table already contains rows, write a hand-authored migration and
migration plan that explicitly handles the existing data.

## Base table ownership

TypeORM remains responsible for creating and changing base tables. This package
adds the TimescaleDB layer on top.

## Documentation status

The documentation skeleton exists first so users can see the intended docs
structure. Some pages are starter pages and will be expanded in later steps.

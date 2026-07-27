# Limitations

`typeorm-timescaledb` is a pre-1.0 foundation release. It is useful today for the
supported scope, but it is not a complete TimescaleDB abstraction yet.

This page focuses on structural/design limitations that are not primarily a
matter of unshipped features. See [Feature status](feature-status.md) for the
full, version-tracked breakdown of what is currently shipped versus planned.

## Not yet shipped

The following features are planned or future scope, not shipped functionality:

- `@RollupColumn` ergonomic sugar for hierarchical continuous aggregates.
  (Continuous aggregates themselves — including hierarchical CAGGs and refresh
  policies — shipped in 0.4.0; hierarchical rollups are already expressible via
  `@AggregateColumn`.)
- `gauge_agg`, `freq_agg`, and `compact_state_agg` — these currently live in the
  `timescaledb_toolkit`'s `toolkit_experimental` schema, so they are not yet
  surfaced as stable constructs.
- Stable Toolkit aggregates not yet covered by the typed query layer. (T-Digest
  percentiles shipped in 0.4.0.)
- Structural diffing of continuous aggregates.
- In-place reconciliation of space (hash) dimensions.
- Validated cross-store references.
- Complete TimescaleDB feature coverage.

Automatic destructive migrations are not planned as a public promise. Changes
that could drop data, destructively reverse hypertable conversion, or make unsafe
alterations require explicit hand-written migrations controlled by the user.

## Migration limitations

`generate` emits a desired-state migration from your entities and applies
supported TimescaleDB configuration idempotently. Separately, the migration
engine (`check`, `introspect` + `diffSchemaState`, `applyDirect`) reconciles a
live database against your entities and DOES auto-diff:

- Compression and retention thresholds.
- The time-dimension chunk interval.
- The columnstore segment-by / order-by configuration.
- Renames declared via `@Hypertable({ renamedFrom })`.
- Removing a retention or compression policy — only when drops are explicitly
  enabled (`allowDrops`), and always reversibly.

A hand-written migration is still required for:

- Dropping a hypertable or disabling a columnstore (never auto-generated).
- Adding, removing, or re-partitioning a space (hash) dimension — a divergence
  here is reported as an error naming the remedy, not silently ignored.
- Structural changes to continuous aggregates (they are not diffed).
- Any reversal of TimescaleDB configuration that could affect live data.

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

# Overview

`typeorm-timescaledb` is a TypeORM-native TimescaleDB integration for TypeScript teams.

It lets you describe supported TimescaleDB behavior with typed entity metadata, then generate reviewable migrations from that metadata instead of hand-writing TimescaleDB SQL for every workflow.

## What it supports today

The current release line (0.8.x) supports:

- TimescaleDB hypertables.
- Time columns.
- Hypertable-aware primary keys.
- Columnstore configuration and policies.
- Retention policies.
- Space/hash partitioning.
- Migration generation.
- CLI migration commands.
- Per-DataSource runtime context through `createTimescale`.
- Schema drift detection through `assertSchema`.
- NestJS integration.
- Dual ESM and CommonJS packaging.
- TypeScript declarations.

## What it is not yet

This package is not a complete TimescaleDB abstraction yet. Continuous aggregates (0.4.0), hyperfunction query expressions (0.3.x) and the entity-to-database diff engine (0.6.0) all ship today — see [feature status](feature-status.md) for the authoritative list.

Still out of scope here: `@RollupColumn` sugar for hierarchical aggregates, the `toolkit_experimental` aggregates (`gauge_agg`, `freq_agg`, `compact_state_agg`), destructive auto-migrations, automatic reconciliation of space (hash) dimensions, and complete coverage of every TimescaleDB feature. Validated cross-store references ship separately as `@blueprime/cross-store`, not as part of this package's surface.

## Design principles

- Keep TypeORM as the base table owner.
- Add the TimescaleDB layer through reviewable migrations.
- Avoid global mutation.
- Scope runtime behavior to the supplied `DataSource`.
- Keep generated rollbacks non-destructive.
- Make limitations explicit.

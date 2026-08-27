# Overview

`typeorm-timescaledb` is a TypeORM-native TimescaleDB integration for TypeScript teams.

It lets you describe supported TimescaleDB behavior with typed entity metadata, then generate reviewable migrations from that metadata instead of hand-writing TimescaleDB SQL for every workflow.

## What it supports today

The current release line (0.7.x) supports:

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

This package is not a complete TimescaleDB abstraction yet. Continuous aggregates, hyperfunction query expressions, a full entity-to-database diff engine, validated cross-store references, and complete TimescaleDB feature coverage are future scope.

## Design principles

- Keep TypeORM as the base table owner.
- Add the TimescaleDB layer through reviewable migrations.
- Avoid global mutation.
- Scope runtime behavior to the supplied `DataSource`.
- Keep generated rollbacks non-destructive.
- Make limitations explicit.

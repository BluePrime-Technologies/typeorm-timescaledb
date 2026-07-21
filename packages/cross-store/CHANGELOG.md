# Changelog — @blueprime/cross-store

All notable changes to `@blueprime/cross-store` are documented here. This package is versioned
**independently** of `typeorm-timescaledb` / `@blueprime/timescaledb-core`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-21

First published release. Application-level validated cross-**database** `@Resolve` references —
referential integrity between two separate database instances that cannot share a SQL foreign key.

### Added

- **`ReferenceRegistry`** — anti-injection allowlist of `(store, table, column)` triples (+ scope
  columns), with deep-frozen entries and conflict-detecting registration.
- **`resolveReferences` + `assertAllResolved`** — batch-first resolve engine (one `findMany` per
  `(store, table, column, scope)` group); adapter failure surfaces `ADAPTER_UNAVAILABLE` and is never
  collapsed into `REFERENCE_NOT_FOUND`; validators fail closed; verdicts returned in input order.
- **Adapters** (structural; ORM is an optional peer, never imported by the core):
  `@blueprime/cross-store/typeorm` `DataSourceAdapter` (native index-friendly `= ANY($1)` over any
  `SqlRunner`) and `@blueprime/cross-store/prisma` `PrismaAdapter` (`col::text = ANY($1)` for Prisma's
  type-strict binding).
- **`@Resolve('store.table.column', { scope, validators, required })`** decorator + `resolveEntities`
  — the ORM-agnostic entity declaration surface (module-private metadata; no prototype mutation).
- **`createManyResolved` / `createResolved` / `verifyReferences`** (`./typeorm`) — validate-then-write
  inside the caller's transaction with a save-time re-check that closes the value **and** scope TOCTOU
  windows (issue #140), and a reconciliation sweep partitioning `{ dangling, unavailable }`.
- **`CrossStoreError`** taxonomy separating `REFERENCE_NOT_FOUND` from `ADAPTER_UNAVAILABLE`.

### Notes

- Depends on `@blueprime/timescaledb-core` for identifier-safety primitives.
- ESM-only; Node `^20.19.0 || >=22.12.0`. Cross-database integrity is best-effort with an honest,
  documented TOCTOU window, mitigated by append-only targets, caller-transaction validate-then-write,
  and the reconciliation sweep.

[0.1.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/releases/tag/cross-store-v0.1.0

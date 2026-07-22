# Changelog — @blueprime/cross-store

All notable changes to `@blueprime/cross-store` are documented here. This package is versioned
**independently** of `typeorm-timescaledb` / `@blueprime/timescaledb-core`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-22

Correctness + registry-hardening release (finishing the M3 cross-store milestone). No breaking
changes — all additions are additive and opt-in.

### Added

- **`targetIsUnique` registry invariant** — a new optional flag on `register({ … })` asserting the
  reference target column is unique (PK/UNIQUE). Resolution assumes this (it takes one row per key
  value); a target left undeclared is surfaced by `registry.nonUniqueTargets()` and the new
  `warnNonUniqueTargets(registry, warn)` startup helper.
- **`columnType` — index-preserving param casts** — a new optional base-SQL-type on the registry
  entry (e.g. `'uuid'`, `'bigint'`). When set, the fetch casts the bound **parameter**
  (`col = ANY($1::uuid[])`) instead of the column, keeping the target's btree index usable while
  still working under Prisma's type-strict binding. Allowlist-validated (`safeColumnType`) at
  registration, canonical storage, and the driver boundary — a type name is interpolated as a cast
  target, never bound, so only bare scalar types pass.
- **`ReconciliationResult.misconfigured`** — `verifyReferences` now surfaces a misconfigured target
  in its own bucket (see below) instead of mislabelling it or crashing the sweep.

### Fixed

- **Permanent SQL errors are no longer masked as retryable.** A mis-declared target (an undefined
  table/column/schema — SQLSTATE `42P01` / `42703` / `3F000` / …) previously surfaced as a retryable
  `ADAPTER_UNAVAILABLE` verdict, hiding a permanent wiring bug that a reconciliation sweep would
  re-queue forever. It now surfaces as a distinct **`misconfigured`** verdict carrying the new
  `REFERENCE_MISCONFIGURED` error code. The write path still fails loud (`assertAllResolved` throws),
  while `verifyReferences` keeps its "never crash" contract by partitioning it into the new
  `misconfigured` bucket. Transient failures and permission/syntax errors stay `ADAPTER_UNAVAILABLE`.

### Notes

- `ResolveStatus` gains a `'misconfigured'` member and `CrossStoreErrorCode` gains
  `REFERENCE_MISCONFIGURED` — additive to the public taxonomy.
- Verdicts remain mode-invariant across the native / `compareAsText` / `columnType` fetch strategies
  (the engine's post-fetch `String()` match is the backstop), so a non-canonical input resolves to
  the same `not_found` in every mode.

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

[0.2.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/cross-store-v0.1.0...cross-store-v0.2.0
[0.1.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/releases/tag/cross-store-v0.1.0

# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Both packages (`typeorm-timescaledb` and `@blueprime/timescaledb-core`) are versioned
and released in lockstep.

## [0.2.0] - 2026-06-12

Minor release: a backward-compatible **typed query layer (hyperfunctions)** on top of
the 0.1.x schema foundation. No breaking changes.

### Added

- **Typed time-bucket queries** — `repo.getTimeBucket(...)` and a fluent
  `repo.timescaleQueryBuilder(...)` wrapper (per-instance; no prototype mutation).
- **Core hyperfunctions** — `time_bucket` (including timezone / origin / offset
  variants), `first` / `last`, and `histogram`.
- **Gap-filling** — `time_bucket_gapfill` with `locf` (last-observation-carried-forward)
  and `interpolate`, with validation (forward-fill requires ascending buckets; bounds
  required; incompatible with timezone/origin/offset).
- **`timescaledb_toolkit` features** — typed helpers for stable toolkit aggregates:
  `repo.getCandlesticks(...)` (OHLCV), `repo.approxCountDistinct(...)`,
  `repo.getStats(...)`, `repo.getRegression(...)`, `repo.getPercentiles(...)`,
  `repo.getPercentileRanks(...)`, `repo.getCounterAgg(...)`,
  `repo.getTimeWeight(...)`, `repo.getStateDurations(...)`,
  `repo.getStateTimeline(...)`, `repo.getStateAt(...)`,
  `repo.getStatePeriods(...)`, `repo.getMostCommonValues(...)`, `repo.getTopN(...)`,
  `repo.getHeartbeatHealth(...)`, `repo.getLiveRanges(...)`,
  `repo.getDeadRanges(...)`, and `repo.isLiveAt(...)`.
- **Toolkit-presence detection** — toolkit-backed methods fail fast with the stable
  `TSDB_TOOLKIT_MISSING` error when the extension is not installed.
- **Typed raw-result coercion helpers** for hyperfunction outputs (`toNumber`,
  `toNumberOrNull`, `toBigIntString`, `toDate`, `toNumberArray`, `mapRawRows`).

### Changed

- README and `docs/feature-status.md` updated for the 0.2.x scope (the query layer
  moves from _planned_ to _shipped_). `docs/feature-status-0.1.x.md` was renamed to
  `docs/feature-status.md` (version-neutral).
- CI GitHub Actions bumped to Node-24-compatible majors; release workflow re-asserts
  public access after the scoped-package publish.

### Notes

- `candlestick_agg` is computed once per bucket (the OHLCV accessors are applied over a
  single aggregate), and `vwap` is `null` when a bucket's total volume is 0.
- Requires `timescaledb_toolkit` for toolkit-backed helpers; base hyperfunctions run
  on TimescaleDB ≥ 2.18.

## [0.1.1] - 2026-06-11

### Changed

- Documentation only — rewrote the README "Why this exists" section to focus on the
  problem the package solves, and clarified pre-1.0 scope. No code changes.

## [0.1.0] - 2026-06-11

Initial public release — the schema foundation (M1).

### Added

- `@Hypertable`, `@TimeColumn`, and `@HypertablePrimaryKey` decorators — hypertables with
  chunk interval, columnstore (segmentby/orderby + policy), retention policy, and
  space (hash) partitioning.
- Migration generation + CLI (`generate` | `run` | `revert` | `status`) — reviewable,
  reversible migrations; generated `down()` methods are never destructive.
- Per-DataSource runtime access via `createTimescale(dataSource)` and boot-time schema
  drift detection via `assertSchema()`.
- NestJS module with optional-peer wiring and named multi-DataSource contexts.
- Unified import surface (one package, never raw `typeorm`); dual ESM + CJS builds with
  TypeScript declarations.
- `@blueprime/timescaledb-core` — ORM-agnostic SQL/DDL generation, metadata model, and
  identifier safety.

[0.2.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/releases/tag/v0.1.0

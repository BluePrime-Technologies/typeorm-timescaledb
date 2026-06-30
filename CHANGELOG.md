# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Both packages (`typeorm-timescaledb` and `@blueprime/timescaledb-core`) are versioned
and released in lockstep.

## [0.3.0] - 2026-06-28

Minor release: **full stable `timescaledb_toolkit` aggregate coverage** on top of
the 0.2.x query layer. Every stable toolkit aggregate is now available through a
typed ORM repository helper. No breaking changes.

### Added

- **Statistics** — `repo.getStats(...)` (1D: average/sum/stddev/variance/skewness/kurtosis,
  `sample` or `population`) and `repo.getRegression(...)` (2D: slope/intercept/x-intercept/
  correlation/covariance/R² plus per-axis means/sums) via `stats_agg`.
- **Percentiles** — `repo.getPercentiles(...)` and `repo.getPercentileRanks(...)`
  via `percentile_agg` / uddsketch, including mean/error/count metadata.
- **Counters** — `repo.getCounterAgg(...)` via `counter_agg` for monotonic counters
  that may reset.
- **Time-weighted average** — `repo.getTimeWeight(...)` via `time_weight`
  (`Linear`/`LOCF` average plus integral). `average` is `null` for a single-sample
  zero-duration window.
- **State tracking** — `repo.getStateDurations(...)`, `repo.getStateTimeline(...)`,
  `repo.getStateAt(...)`, and `repo.getStatePeriods(...)` via `state_agg`.
- **Most-common values** — `repo.getMostCommonValues(...)` and `repo.getTopN(...)`
  via `mcv_agg`.
- **Liveness / uptime** — `repo.getHeartbeatHealth(...)`, `repo.getLiveRanges(...)`,
  `repo.getDeadRanges(...)`, and `repo.isLiveAt(...)` via `heartbeat_agg`; input is
  auto-windowed to `[start, start + duration)`.
- Corresponding core SQL builders are exported for the raw escape-hatch tier.

### Fixed

- **Default time-column resolution** — toolkit helpers now resolve the default time
  column (`@TimeColumn` property name) to its database column name in every helper,
  so entities that map time through `@Column({ name })` no longer emit SQL for a
  nonexistent property-name column when `timeColumn` is omitted.

### Notes

- All toolkit aggregates require `timescaledb_toolkit`; absence fails fast with
  `TSDB_TOOLKIT_MISSING`. Signatures and behavior were verified against
  `timescaledb_toolkit 1.23.0`.
- Not yet covered: continuous aggregates, the still-`toolkit_experimental`
  aggregates (`gauge_agg`, `freq_agg`, `compact_state_agg`), and a full safe
  entity-to-database diff engine.

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
- **Initial `timescaledb_toolkit` helpers** — `repo.getCandlesticks(...)` returning
  typed OHLCV (open/high/low/close/volume/vwap) and `repo.approxCountDistinct(...)`.
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
- Requires `timescaledb_toolkit` for candlesticks and `approxCountDistinct`; base
  hyperfunctions run on TimescaleDB ≥ 2.18.

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

[0.3.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/releases/tag/v0.1.0

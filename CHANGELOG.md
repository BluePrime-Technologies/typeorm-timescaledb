# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Both packages (`typeorm-timescaledb` and `@blueprime/timescaledb-core`) are versioned
and released in lockstep.

## [Unreleased]

### Fixed

Pre-release audit of the whole library. The entries below are defects in
**previously released** code (0.5.0 and earlier); each ships with a regression test and
was reproduced and verified against live TimescaleDB 2.18-pg16 and latest-pg17.

- **SQL injection via output aliases (query layer)** — `getTimeBucket`'s `bucketAlias` /
  `metrics[].alias` and every `TimescaleQueryBuilder` alias (`timeBucket`, `timeBucketGapfill`,
  `first`, `last`, `histogram`, `locf`, `interpolate`) were passed to TypeORM unvalidated. TypeORM
  0.3.x — inside this package's supported peer range — quotes an alias without escaping embedded
  double quotes, so an alias derived from user input (a chart label, a saved-dashboard field) could
  inject arbitrary select-list SQL. Aliases are now allow-listed like every other identifier in the
  layer. **Applications that pass caller-controlled aliases should treat this as a security fix.**
- **Cross-schema data leak in `listChunks` / `listJobs`** — an unqualified `hypertable` filter
  applied only `hypertable_name = $1`, with no schema predicate, so in a schema-per-tenant database
  a tenant-scoped call returned other tenants' chunks and jobs. An unqualified name now resolves
  against the DataSource's configured schema (falling back to `public`), matching how the migration
  generator already pins unqualified entities. **Behaviour change:** callers who relied on a bare
  name matching every schema must now pass `schema.name` explicitly.
- **Duplicate output aliases silently dropped a column** — `getTimeBucket` never checked that the
  bucket alias and metric aliases were distinct. PostgreSQL permits duplicate output names but a row
  object keeps only the last, so a metric aliased `bucket` erased the time axis from every row, and
  two metrics sharing an alias silently plotted one series under the other's label — with no error.
  Colliding aliases are now rejected.
- **Hierarchical continuous aggregates generated invalid SQL** — a parent CAGG resolved the child
  view's columns by identity, emitting the `@GroupColumn` **property** name. When the child's source
  hypertable remapped that column with `@Column({ name })` (`sensorId` → `sensor_id`), the generated
  `CREATE MATERIALIZED VIEW` failed with `column "sensorId" does not exist`, rolling back the whole
  migration. The parent now resolves group columns through the child's own output naming.
- **Writes were refused for an unassigned optional cross-store reference** (`@blueprime/cross-store`)
  — an optional `@Resolve` field declared as `parentId?: string` and never assigned has no own
  property, which the save-time TOCTOU guard treated as unlockable: it threw `INVALID_ARGUMENT` and
  the entity was never written, with an error that misreported the cause as an inherited accessor.
  An absent property is now locked (and restored) correctly; genuinely unlockable shapes — inherited
  accessors and non-configurable fields — still fail closed.

## [0.5.0] - 2026-07-20

Minor release: adds async/deferred NestJS configuration and a fail-fast
TimescaleDB-presence check, and lands a correctness/hardening pass across the
core SQL builders and the TypeORM result/CLI layers. No breaking API changes.

### Added

- **`TimescaleModule.forRootAsync(...)`** — deferred/async DataSource configuration
  for NestJS (`useFactory` + `inject` + `imports`), including an optional no-op mode
  when the factory resolves no configuration (register an `@Optional()` context for
  environments where TimescaleDB isn't wired).
- **Fail-fast TimescaleDB presence check** — `assertSchema()` now raises the stable
  `TSDB_TIMESCALEDB_MISSING` error when the `timescaledb` extension is not installed,
  instead of surfacing a confusing downstream failure. The underlying
  `TIMESCALEDB_PRESENCE_SQL` catalog check is exported from `@blueprime/timescaledb-core`.

### Fixed

- **CLI DataSource loading** — `generate` / `run` / `revert` / `status` now discriminate a
  missing `-d` file/path and a missing npm dependency from Node's native TypeScript
  type-stripping `ERR_MODULE_NOT_FOUND`, so the reported error points at the real cause
  instead of misclassifying it as a type-stripping problem.
- **Numeric result coercion (typeorm)** — the result mapper now throws on a value that would
  silently lose precision (a `bigint` outside JavaScript's safe-integer range, or a
  non-safe-integer number where a bigint string is expected) instead of returning a wrong
  number.
- **Hardening (core SQL builders)** — interval strings accept only a single ASCII space
  between the count and unit (a tab, non-breaking space, or Unicode line separator no longer
  slips through); positive-integer inputs such as histogram `nbuckets` are validated with
  `Number.isSafeInteger` (values like `1e21` are rejected); `orderBy` direction is restricted
  to `ASC` / `DESC`; qualified identifiers reject three-or-more parts; and numeric-literal
  emission is shared and injection-safe across the hyperfunction and toolkit builders.
- **Hardening (typeorm)** — `getTopN(n)` validates that `n` is a positive integer before use,
  and `@Hypertable` migration generation / `assertSchema()` cross-check that the entity's
  primary key includes the time (and space) partitioning column.

### Notes

- The validation tightenings above can surface as errors on inputs that were previously
  accepted but were already incorrect (e.g. an interval separated by a tab, or an
  out-of-safe-range numeric result). This is intentional pre-1.0 correctness hardening, not
  a behavioral regression.
- `@blueprime/cross-store` (validated cross-database `@Resolve` references) is developed in
  this repository but remains **unpublished / private** and is not part of this release.

## [0.4.0] - 2026-07-09

Minor release: completes the continuous-aggregate story and adds downsampling,
operational introspection (informational views + jobs), and T-Digest percentiles.
No breaking changes.

### Added

- **Continuous aggregates (typed)** — `@ContinuousAggregate` / `@BucketColumn` /
  `@GroupColumn` / `@AggregateColumn` decorators with migration codegen, the core
  `createContinuousAggregateSQL` builder, and `createTimescale(ds).refreshContinuousAggregate(...)`.
- **Automatic refresh policies** — `@ContinuousAggregate({ refresh })` and
  `addContinuousAggregatePolicySQL` (`add_continuous_aggregate_policy`).
- **Hierarchical continuous aggregates** — a `@ContinuousAggregate` whose `source` is
  another CAGG, with topological create/drop ordering.
- **CAGG drift detection** — `assertSchema()` now covers continuous aggregates and their
  refresh policies.
- **Downsampling** — `repo.downsampleLTTB(...)` and `repo.downsampleASAP(...)` via toolkit
  `lttb` / `asap_smooth`, returning typed `{ time, value }[]`.
- **Informational views** — `createTimescale(ds).listHypertables(...)`, `listChunks(...)`,
  `listContinuousAggregates(...)`, `listJobs(...)`, and `getJobStats(...)` over
  `timescaledb_information.*`.
- **Jobs API** — `runJob(...)`, plus the user-defined action jobs API `addJob(...)` /
  `alterJob(...)` / `deleteJob(...)`.
- **T-Digest percentiles** — `repo.getTDigestPercentiles(...)` / `getTDigestPercentileRanks(...)`
  via toolkit `tdigest`, with mean/min/max/count.
- Corresponding core SQL builders are exported for the raw escape-hatch tier.

### Fixed

- **`approxCountDistinct` over an empty set** now returns `"0"` (the distinct count of
  no rows) instead of throwing on the `NULL` the toolkit accessor returns — matching the
  empty-set handling of every other typed aggregate helper. Present since `0.2.0` (when
  `approxCountDistinct` was introduced).

### Notes

- Downsampling and T-Digest require `timescaledb_toolkit` (fail fast with
  `TSDB_TOOLKIT_MISSING`); continuous aggregates, informational views, and the jobs API are
  base TimescaleDB. Verified against TimescaleDB 2.18 and latest on the CI matrix (Node
  20/22/24, TypeORM 0.3.20 / 1.0.0).
- `alterJob` sends only the fields you set (omitted fields are unchanged); `config`, when
  set, replaces the whole config (not merged).
- Not yet covered: `@RollupColumn` sugar for hierarchical rollups (expressible today via
  `@AggregateColumn`), the still-`toolkit_experimental` aggregates (`gauge_agg`, `freq_agg`,
  `compact_state_agg`), and a full safe entity-to-database diff engine.

## [0.3.0] - 2026-06-28

Minor release: expanded typed `timescaledb_toolkit` aggregate coverage for the
stable aggregate families implemented in this package, on top of the 0.2.x query
layer. No breaking changes.

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
  aggregates (`gauge_agg`, `freq_agg`, `compact_state_agg`), stable Toolkit
  aggregates not listed above (including T-Digest), and a full safe
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

[0.5.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BluePrime-Technologies/typeorm-timescaledb/releases/tag/v0.1.0

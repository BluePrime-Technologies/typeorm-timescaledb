# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Both packages (`typeorm-timescaledb` and `@blueprime/timescaledb-core`) are versioned
and released in lockstep.

## [0.7.1] - 2026-08-13

Documentation-only patch. **No source changes** — published so the npm package pages describe what
0.7.0 actually ships. npm renders a README only at publish time, so a corrected README cannot reach
the package page without a release.

### Changed

- README: `What's in 0.6.x` → `0.7.x`, plus a real **0.7.0 release scope** section. The published
  page advertised 0.6.x, and still listed the `push`/`pull`/`mix` verbs under "not in this release"
  — they shipped in 0.7.0.
- CHANGELOG: corrected the 0.7.0 entry below on two counts, both from writing it against the audit
  reports instead of `git log v0.6.1..v0.7.0`. It claimed "no new feature surface" when the range
  holds ten feature commits — the **Added** section is that correction. Its **Fixed** list also
  stopped at the audit's own findings, omitting the six defects the entry's own opening promises
  ("plus 6 more found by adversarially reviewing the fixes"), including three SQL-lexer bypasses
  that could hide a statement separator.

## [0.7.0] - 2026-08-12

Minor release: **one-command migration verbs, continuous aggregates in the diff, and a full
correctness and safety audit of everything 0.6.0 shipped.**

The engine that landed in 0.6.0 could read, diff and converge a database, but only via `check` +
`generate` or the programmatic API. This release puts one command in front of it, adds continuous
aggregates to the comparison, and audits the whole surface — 41 numbered findings across seven
review reports, plus 6 more found by adversarially reviewing the fixes. Several of those made the
engine report success while doing the wrong thing, which is the failure mode this release exists to
remove.

One behaviour change is **breaking for CI scripts**; see below.

### Added

- **`push`** — converge the live database to your entities behind one command. Previews by default;
  mutates only with `--apply`, and refuses `refuse-by-default` operations unless you opt in.
- **`pull`** — adopt an existing database into a migration, reproducing its TimescaleDB layer as
  operations and reporting per object whatever it could not reproduce.
- **`mix`** — pull then push, for adopting a database you did not create.
- **`timescaledb.config.json`** — keep `dataSource` / `outDir` / `output` in a file so the common
  path is one command. The safety flags (`--apply`, `--allow-drops`, `--allow-refused`) are
  deliberately **not** configurable: a file committed to the repository must never pre-authorise a
  destructive run for everyone who later types the command.
- **Continuous aggregates in the diff** — CAGGs are compiled into the desired state and diffed
  additively, wired into `check` and `push`, with an explicit advisory for what was _not_ compared.
- **Decompress → alter → recompress planner** — a columnstore change against compressed chunks is
  planned as an explicit three-phase operation instead of silently applying to future chunks only.
- **Static plan linter** — `lintPlan(plan)` flags destructive and lock-taking steps (`TSDB001`…)
  before anything runs, with `formatLintFindings` for CLI output.
- **`assertSafeFragment`** — validates the ~25 pass-through expression builders that previously
  documented "must already be safe" in prose only.

### Breaking

- **`check` now exits `2` on drift, not `1`.** Exit `1` collided with "the command failed",
  so a connection error and a schema difference were indistinguishable to a CI gate — a
  broken pipeline read as drift, and a script that treated `1` as drift would "detect" drift
  when the database was simply unreachable. Drift is now `2`, failure stays `1`, clean stays
  `0`. Update any pipeline that tests for `1`.

### Fixed

Safety and correctness of the diff engine:

- `diffSchemaState` was **silently blind to a changed time-dimension column** and returned an
  empty plan — a clean bill of health for a database whose partitioning key had moved. It now
  throws, because there is no safe automatic conversion.
- An **undeclared `chunkInterval` reset a tuned interval to the 7-day default.** Absent now
  means "leave it alone", which is what every other undeclared field already meant.
- **`down()` of a lengthening retention alter destroyed data**, and the operation was
  classified `online-safe`. Re-shortening a retention window drops chunks; reverting it
  cannot be lossless. Lengthening is now `one-way`, an unprovable comparison is `one-way`,
  and the `down()` emits a notice instead of a destructive statement. Interval comparison
  moved to BigInt, which also fixes a precision loss on large intervals.
- `removeRetentionPolicySQL.down()` **re-installed a data-dropping policy** on rollback.
- A partially-declared `continuousAggregates` list **silenced every aggregate you forgot to
  list**, reporting a clean diff for objects it had never looked at.
- `push --apply` **claimed convergence for a change that only applies to future chunks**, and
  an unknown-precision recompression plan with no chunks printed "already match".

Reads that were wrong rather than absent:

- `listJobs({ hypertable })` **returned `[]` for continuous-aggregate policies** on
  TimescaleDB 2.18, where `jobs.hypertable_*` names the internal materialization hypertable
  rather than the user-facing view.
- `introspect()`'s continuous-aggregate query had **no fallback**, so one unavailable catalog
  column failed the entire read; it now degrades to public views and flags the result.
- `listChunks` **reported null ranges for every chunk of an integer-time hypertable**,
  because it selected only the timestamp pair.
- `recompress` **checked precision after an empty-chunk shortcut** and a bare `catch {}` hid
  real failures; it now absorbs only "column/table does not exist".

Injection and path handling:

- Config discovery **walked to the filesystem root**, so a `timescaledb.config.json` in any
  ancestor directory — a shared parent, `$HOME`, `/tmp`, `/` — chose which module the CLI
  imported, and importing executes. The walk now stops at the project root.
- A discovered config's **`outDir` was an unconstrained write path**; relative path values
  now resolve against the config file and must stay inside its directory.
- The single-statement guard on raw continuous-aggregate definitions was **bypassable**, and
  a digit-leading dollar-quote tag was accepted where PostgreSQL would not read one.
- The ~25 pass-through expression builders now validate their fragment (`assertSafeFragment`,
  exported) instead of documenting "must already be safe" in prose only.

Found by reviewing the fixes, not by the audit — three of these **hid a statement separator**:

- The quote/comment walk was **duplicated**: `assertSafeFragment` shipped a naive regex over `;`,
  `--` and `/*` while `classifyDefinitionBody` already carried a proper scanner. The naive form
  **rejected legal SQL** — `string_agg(message, '--')`, `count(*) FILTER (WHERE tag <> 'a;b')` — a
  regression for callers, since those builders previously accepted anything. Both now share one
  lexer, so they cannot drift.
- **Block comments nest in PostgreSQL**, and the scan stopped at the first `*/`; an `E'…'` string
  escapes a quote with a backslash as well as by doubling. Both left the scan at top level while
  the server was still inside a comment or literal. (Conservative direction: they refused valid
  input.)
- **A `$` that follows an identifier character does not open a dollar quote.** `$` is legal inside
  an identifier, so PostgreSQL reads `x$t$ ; $t$` as the identifier `x$t$` followed by a **real**
  separator — while the scan treated it as a quoted block and called the input clean.
- **Non-ASCII letters are identifier characters**, so the same hole reopened via `α$t$ ; $t$`; and
  **a line comment ends at a bare CR**, not only LF, so `-- x\r; DROP` hid a real separator.
- `runtime/introspect.ts` contained three raw NUL bytes (a `\0` Map-key separator written as
  literal bytes), which made **git classify the file as binary** — so changes to the core
  introspection path produced _no reviewable diff at all_. Written as escapes; guarded by a test.
- `introspect()` now **fails fast** with `TSDB_TIMESCALEDB_MISSING` when the `timescaledb`
  extension is absent, instead of surfacing a raw `relation "timescaledb_information.hypertables"
does not exist` from the first catalog query.
- `listChunks`/`introspect` stopped reading a **catalog column TimescaleDB 2.29 removed**.

Version compatibility, which was untested where it mattered most:

- The CI matrix **floated on `latest`** and skipped the entire 2.19–2.28 band, where both
  catalog boundaries this library depends on actually moved. Pinned to 2.18.0, 2.19.0,
  2.26.0, 2.29.1 across PostgreSQL 16/17/18, with a separate scheduled job on `latest` as an
  early warning. PostgreSQL support is now declared in `docs/compatibility.md`, with a
  statement of what "tested" means.
- New integration suite asserts that **every catalog column this library reads exists on the
  running server**, per matrix leg, and fails the build if a `SELECT *` against a catalog
  relation is reintroduced.

CLI contract:

- `pushCommand`'s error path **replaced the real failure with a second, unrelated error**.
- `mix` reported a mutating run identically to a preview, and **wrote a migration file on a
  preview run**.
- A recompression rollback failure aborted the whole run and discarded its result.
- `formatPlanPreview` rendered the caller-supplied safety class rather than
  `classifyOperation`'s, so a preview could disagree with the engine.
- Misplaced non-safety flags (`-o`, `-n`, `--output`) were silently ignored.
- `loadDataSourceModule` awaited every export while hunting for a DataSource.

### Changed

- Source maps and declaration maps are no longer published. They referenced sources the
  tarball deliberately does not ship, so every map pointed at nothing; the package is 153
  files / 0.83 MB, down from 264 / 1.19 MB.
- All GitHub Actions are pinned to commit SHAs, with a Dependabot config to advance them.

### Known limitations

Unchanged from 0.6.x and stated so they are not mistaken for fixed: continuous aggregates are
not structurally diffed; space dimensions are not reconciled in place; a policy's
`schedule_interval` is not reproduced by `pull` and is deliberately not reported per object,
because introspection cannot distinguish a tuned cadence from the engine default it always
fills in (see `PULL_BASE_DDL_CAVEAT`).

## [0.6.1] - 2026-07-27

Documentation-only patch. **No source changes** — published solely so the npm package pages
reflect what 0.6.0 actually ships (npm renders a README only at publish time).

### Changed

- README: documented the migration engine — `introspect` → `diffSchemaState` → `applyDirect`,
  the `check` CI drift gate, `generate --output <ts|sql>`, `@Hypertable({ renamedFrom })`,
  opt-in guarded drops, and `TimescaleSchemaBuilder` — with runnable examples.
- README: corrected claims that were false as of 0.6.0, notably that a full diff engine was
  "planned but not shipped" and that altering existing TimescaleDB configuration "still requires a
  hand-written migration". Replaced with a precise statement of what the engine does and does not
  reconcile, plus the real remaining limitations (continuous aggregates are not structurally
  diffed; space dimensions are not reconciled in place; no `push`/`pull`/`sync` verbs yet).
- README: added `@blueprime/cross-store` to the packages table — it was published but unlisted.
- `@blueprime/timescaledb-core` README: expanded from a stub to describe the operation IR, the
  single compile choke point, the diff/plan engine, and the normalization layer.

## [0.6.0] - 2026-07-27

Minor release: **the unified migration engine**. The package can now read a live
TimescaleDB, diff it against your entity declarations, and converge it — where
previously it could only emit desired-state DDL in one direction. Also lands a
full-library correctness audit (see **Fixed**). No breaking API changes to the
existing query/decorator surface.

### Added

- **Live-database introspection** — `introspect(dataSource)` reduces a running
  TimescaleDB to a canonical `SchemaStateIR` (dimensions, columnstore config,
  compression/retention/refresh policies, continuous aggregates), normalized so
  Postgres's interval reformatting and engine-filled defaults never read as drift.
- **A typed diff engine** — `diffSchemaState(current, desired, options?)` returns an
  ordered `Plan` whose every step carries a **safety class** (`online-safe`,
  `needs-recompress`, `refuse-by-default`, `one-way`) and a human-readable reason.
  It detects a missing hypertable/columnstore/policy, a changed compression or
  retention threshold, a changed chunk interval, and a changed columnstore
  segment-by/order-by configuration.
- **`check` CLI verb** — diff the live database against your entities, print a
  readable drift preview, and exit non-zero on drift (a CI schema gate).
- **Rename support** — `@Hypertable({ renamedFrom })` resolves a renamed hypertable
  to a single `ALTER TABLE ... RENAME` instead of a drop-then-create.
- **Guarded drops** (opt-in, `allowDrops`) — removes a retention or compression
  policy that is present in the database but absent from your entities. Reversible;
  destructive drops (dropping a hypertable, disabling a columnstore) are never emitted.
- **Emitters** — `generate --output <ts|sql>` writes either a TypeORM migration class
  or a reviewable raw `.sql` artifact; `planToMigration(plan)` turns a diff `Plan`
  into a committable migration; `compilePlan(plan)` exposes its `up`/`down` SQL.
- **`TimescaleSchemaBuilder`** — a fluent, hand-authoring surface for Timescale DDL
  that runs inside an ordinary TypeORM migration via `queryRunner`, producing SQL
  byte-identical to the generated path.
- **`applyDirect(dataSource, plan, options?)`** — apply a plan straight to a live
  database, in one transaction, refusing `refuse-by-default` operations unless
  explicitly opted in. Classification is derived from the operation itself, so a
  hand-built plan cannot mislabel a dangerous change past the gate.

### Known limitations

- Continuous aggregates are **not** structurally diffed (the diff is
  hypertable-scoped), so `check` does not cover CAGG drift.
- Space (hash) dimensions cannot be reconciled in place; a divergence is reported as
  an error naming the required manual migration rather than silently ignored.
- The one-command `push`/`pull`/`sync` verbs are not in this release — use `check`
  plus `generate`, or the programmatic API.

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
- **`time_bucket` with a `timezone` failed on `timestamp` columns** — the timezone argument was emitted
  as an untyped literal, so PostgreSQL could not choose between the origin overload
  `time_bucket(interval, timestamp, timestamp)` and the timezone overload
  `time_bucket(interval, timestamptz, text)`, and every such query failed with
  `function time_bucket(...) is not unique`. It is now cast to `text`.
- **A generated `down()` was unparseable for identifiers containing `$$`** — `$` is a legal
  PostgreSQL identifier character, so a table named e.g. `a$$b` closed the `DO $$ … $$` block early
  and made the rollback a syntax error. The blocks now use a named dollar-quote tag.
- **`origin` / gapfill bounds silently shifted buckets on a `timestamp` time column** — the bounds are
  emitted as `TIMESTAMPTZ`, which made PostgreSQL coerce the column and reinterpret every naive value
  in the session time zone. `getTimeBucket` now refuses that combination instead of returning
  quietly-wrong buckets.
- **`assertToolkit` cached a missing toolkit forever** — installing `timescaledb_toolkit` after the
  first failed check could not be picked up without restarting the process. Only positive results are
  cached now; every failure is evicted and re-checked.
- **`-h`/`--help` was matched anywhere in argv** — `check -d ds.ts --help` printed usage and exited 0,
  turning a CI drift gate into a silent pass. Help is now only recognised as the first argument.
- **"DataSource file not found" was unreachable for `.js`/`.mjs`/`.cjs` paths** — a typo'd compiled
  path surfaced Node's raw `ERR_MODULE_NOT_FOUND` instead of the actionable message. (A genuinely
  missing npm dependency is still reported as itself.)
- **The docs claimed the `generate` CLI emits continuous-aggregate DDL.** It does not — a CAGG is not
  a TypeORM entity, so the classes must be passed to `generateTimescaleMigration` programmatically.
  Corrected in `docs/query-layer.md`.
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

/**
 * `SchemaStateIR` — the canonical, ORM-agnostic representation of the TimescaleDB layer's
 * *desired state* for one hypertable (and its dependent objects). It is the shared vocabulary of the
 * migration engine (M4): both the decorator model (desired) and live-DB introspection (current) are
 * reduced to this shape, and the diff engine compares two of them.
 *
 * **Comparison is never done on the raw values in this IR — always via the normalization layer**
 * (`normalize.ts`). Postgres renders the same logical value in different text forms (an interval as
 * `12:00:00` vs `12 hours`; a defaulted-vs-explicit setting), so a naive field compare produces
 * false-positive diffs. Every field below therefore carries its value in the form the *producer*
 * had (decorator input OR catalog output); the normalizer canonicalizes both sides before equality.
 *
 * Scope (M4.0): this models the declared/desired configuration only. It deliberately EXCLUDES
 * operational/historical state that is not part of desired-state and would cause spurious diffs —
 * chunk-level compression settings that diverge from table-level after a settings change, and CAGG
 * materialized *content*. Those are reconciliation concerns, not schema-diff concerns.
 */

/** An interval as either a Postgres interval string (`'1 day'`, `'12:00:00'`) or an integer (for
 * integer-time hypertables, where `chunk_time_interval` is a bigint, not an interval). */
export type IntervalOrInt = string | number;

/** A columnstore ORDER BY element with its sort direction and NULLS placement. */
export interface OrderByElement {
  readonly column: string;
  /** `true` = DESC. Postgres default is ASC (`false`). */
  readonly desc: boolean;
  /** `true` = NULLS FIRST. Postgres default depends on direction (ASC→last, DESC→first). */
  readonly nullsFirst: boolean;
}

/** A partitioning dimension of a hypertable (time or space/hash). */
export interface DimensionState {
  readonly column: string;
  readonly kind: 'time' | 'space';
  /** Time dimension: the chunk interval (interval string or integer). Absent for space dims. */
  readonly chunkInterval?: IntervalOrInt;
  /** Space dimension: number of hash partitions. Absent for the time dim. */
  readonly numPartitions?: number;
}

/** Columnstore (compression) configuration declared on the hypertable. */
export interface ColumnstoreState {
  /** Segment-by columns, in declared order (order is significant and preserved). */
  readonly segmentBy: readonly string[];
  /** Order-by elements, in declared order. */
  readonly orderBy: readonly OrderByElement[];
}

/** A TimescaleDB background policy (compression / retention / cagg-refresh), reduced from one row in
 * `timescaledb_information.jobs` to its logical configuration. A **discriminated union** on `kind`
 * so illegal field combinations (a `refresh` carrying `after`, a `compression` carrying `startOffset`)
 * are compile errors and equality can narrow per kind. */
export type PolicyState = CompressionOrRetentionPolicy | RefreshPolicy | UnmanagedPolicy;

/** A compression or retention policy: an `after` threshold (drop_after / compress_after) OR the
 * TSDB-2.13+ `createdBefore` variant (drop_created_before / compress_created_before). */
export interface CompressionOrRetentionPolicy {
  readonly kind: 'compression' | 'retention';
  /** `add_compression_policy(compress_after)` / `add_retention_policy(drop_after)`. */
  readonly after?: IntervalOrInt;
  /** `compress_created_before` / `drop_created_before` (creation-time variant, TSDB ≥ 2.13). */
  readonly createdBefore?: IntervalOrInt;
  readonly scheduleInterval?: IntervalOrInt;
}

/** A continuous-aggregate refresh policy. */
export interface RefreshPolicy {
  readonly kind: 'refresh';
  readonly startOffset?: IntervalOrInt;
  readonly endOffset?: IntervalOrInt;
  readonly scheduleInterval?: IntervalOrInt;
}

/** A custom `add_job` whose config shape this engine does not interpret — surfaced, never edited. */
export interface UnmanagedPolicy {
  readonly kind: 'unmanaged';
  readonly procName: string;
  readonly rawConfig?: Readonly<Record<string, unknown>>;
  readonly scheduleInterval?: IntervalOrInt;
}

/** A continuous aggregate's declared state. */
export interface ContinuousAggregateState {
  readonly viewName: string;
  /** The source hypertable (or, for a hierarchical CAGG, the parent CAGG's view name). */
  readonly source: string;
  /** `true` when `source` is another CAGG (hierarchical) — resolved via
   * `_timescaledb_catalog.continuous_agg.parent_mat_hypertable_id`. */
  readonly hierarchical: boolean;
  readonly materializedOnly: boolean;
  /** The aggregate's SELECT definition — compared via parse-tree/`view_definition`, NEVER text
   * (Postgres re-expands aliases + implicit casts; see normalize.ts `normalizeCaggDefinition`). */
  readonly definition: string;
  /** The refresh policy, if one is declared. */
  readonly refresh?: PolicyState;
}

/** The full desired-state of one hypertable and its dependents. */
export interface HypertableState {
  /** Schema-qualified table name, canonicalized to include the schema (default `public`). */
  readonly table: string;
  readonly dimensions: readonly DimensionState[];
  readonly columnstore?: ColumnstoreState;
  readonly compressionPolicy?: PolicyState;
  readonly retentionPolicy?: PolicyState;
}

/** The desired-state of the whole TimescaleDB layer for a set of entities / a live database. */
export interface SchemaStateIR {
  readonly hypertables: readonly HypertableState[];
  readonly continuousAggregates: readonly ContinuousAggregateState[];
  /** The TimescaleDB version the state was read against / is pinned to — the introspection view
   * shapes differ across releases, so a diff must only compare states read under the same pin. */
  readonly timescaledbVersion?: string;
}

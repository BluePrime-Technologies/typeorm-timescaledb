import type { DataSource } from 'typeorm';
import {
  parsePolicyConfig,
  TimescaleError,
  TimescaleErrorCode,
  type ColumnstoreState,
  type ContinuousAggregateState,
  type DimensionState,
  type HypertableState,
  type IntervalOrInt,
  type OrderByElement,
  type PolicyState,
  type SchemaStateIR,
} from '@blueprime/timescaledb-core';

/**
 * Live-DB introspection reader (M4.0 Slice 2): reduce a running TimescaleDB to the canonical
 * {@link SchemaStateIR} that the migration engine compares against the decorator-derived desired
 * state. This is the *current* side of the diff; the decorator model is the *desired* side. Both are
 * reduced to the same IR and compared only through the normalization layer (`@blueprime/timescaledb-core`
 * `normalize.ts`) — never on raw values, because Postgres reformats intervals, fills defaults, and
 * re-expands view text.
 *
 * ## Design
 * - **IntervalStyle precondition.** Every read runs inside one transaction that first executes
 *   `SET LOCAL intervalstyle = 'postgres'`, because the Slice-1 interval canonicalizer only
 *   understands Postgres's default interval rendering (`1 day 02:00:00`). `SET LOCAL` keeps the change
 *   scoped to this transaction — no global/session mutation leaks to other users of the DataSource.
 * - **Version-recording + version-robust.** The TimescaleDB version is read from `pg_extension` and
 *   recorded on the IR (`timescaledbVersion`) — it is *recorded*, not gated on: there is no runtime
 *   range check. Robustness across the supported 2.18 → 2.28 range comes instead from the query
 *   design below. Queries deliberately source from catalog objects and columns that are stable
 *   across the supported range (2.18 → 2.28): the structured columnstore config comes from
 *   `_timescaledb_catalog.compression_settings` (selecting only the columns present in both — the
 *   `compress_relid`/`index` columns 2.28 added are ignored); the CAGG→refresh-policy mapping is done
 *   via `config->>'mat_hypertable_id'` (stable) rather than `jobs.hypertable_name` (which is the user
 *   view on 2.28 but the internal materialization hypertable on 2.18); and the reader never selects
 *   `continuous_aggregates.finalized` (present on 2.18, removed on 2.28).
 * - **Desired-state only.** Chunk-level compression settings and CAGG materialized *content* are
 *   excluded (they are operational, not declared state, and would cause spurious diffs) — the
 *   columnstore query matches only the hypertable-level row (`relid` = the hypertable), never chunks.
 *
 * All reads are static SQL with bound parameters; no identifier is interpolated into SQL.
 */

/** Options for {@link introspect}. */
export interface IntrospectOptions {
  /**
   * Restrict the result to hypertables/continuous-aggregates in these schemas. When omitted, every
   * user hypertable and continuous aggregate the connection can see is introspected. Applied after
   * the (bound) reads, so it never reaches SQL as an identifier.
   */
  readonly schemas?: readonly string[];
}

/** `schema\0name` composite key — `\0` cannot appear in a Postgres identifier, so it is a
 * collision-free separator for grouping rows by (schema, name) in JS Maps. */
function key(schema: string, name: string): string {
  return `${schema}\0${name}`;
}

/** Coerce a Postgres bool (JS boolean, or the `'t'`/`'true'` text forms) to a boolean. */
function toBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}

/** Coerce a Postgres `text[]`/`bool[]` column to a JS array (node-pg already parses these, but a
 * different driver may hand back the `{a,b}` literal; coerce defensively). */
function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1);
    return inner === '' ? [] : inner.split(',');
  }
  return [];
}

interface DimensionRow {
  hypertable_schema: string;
  hypertable_name: string;
  dimension_number: number;
  column_name: string;
  dimension_type: string;
  time_interval: string | null;
  integer_interval: string | number | null;
  num_partitions: number | string | null;
}

interface ColumnstoreRow {
  schema: string;
  name: string;
  segmentby: unknown;
  orderby: unknown;
  orderby_desc: unknown;
  orderby_nullsfirst: unknown;
}

interface JobRow {
  proc_name: string;
  schedule_interval: string | null;
  hypertable_schema: string | null;
  hypertable_name: string | null;
  mat_hypertable_id: number | string | null;
  config: Record<string, unknown> | null;
}

interface CaggRow {
  view_schema: string;
  view_name: string;
  materialized_only: unknown;
  view_definition: string | null;
  mat_hypertable_id: number | string | null;
  parent_schema: string | null;
  parent_view: string | null;
  raw_schema: string | null;
  raw_table: string | null;
  /** Fallback path only (see CAGGS_FALLBACK_SQL) — absent from the enriched query. */
  mat_schema?: string | null;
  mat_name?: string | null;
}

const HYPERTABLES_SQL = `
  SELECT hypertable_schema, hypertable_name
    FROM timescaledb_information.hypertables
   ORDER BY hypertable_schema, hypertable_name`;

const DIMENSIONS_SQL = `
  SELECT hypertable_schema, hypertable_name, dimension_number, column_name,
         dimension_type, time_interval::text AS time_interval, integer_interval, num_partitions
    FROM timescaledb_information.dimensions
   ORDER BY hypertable_schema, hypertable_name, dimension_number`;

// Structured columnstore config. `_timescaledb_catalog.compression_settings` carries the ordered
// segmentby[] plus the parallel orderby[] / orderby_desc[] / orderby_nullsfirst[] arrays in BOTH
// 2.18 and 2.28; only the extra `compress_relid`/`index` columns (2.28) are skipped. Resolving
// `relid` through pg_class/pg_namespace is search_path-independent. The explicit inner join to
// `timescaledb_information.hypertables` restricts rows to the hypertable level and excludes
// chunk-level compression_settings rows (chunks are not in that view) — at the SQL level, not left
// to a downstream JS lookup, so the intent holds even if the result set is later iterated directly.
const COLUMNSTORE_SQL = `
  SELECT n.nspname AS schema, cl.relname AS name,
         cs.segmentby, cs.orderby, cs.orderby_desc, cs.orderby_nullsfirst
    FROM _timescaledb_catalog.compression_settings cs
    JOIN pg_class cl ON cl.oid = cs.relid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN timescaledb_information.hypertables h
      ON h.hypertable_schema = n.nspname AND h.hypertable_name = cl.relname`;

// Compression/retention (attached to hypertables) + refresh (attached to CAGGs). `mat_hypertable_id`
// is lifted from config so the refresh policy can be joined to its CAGG independently of the
// version-dependent `hypertable_name`.
// The interval-valued `config` keys are stored as TEXT that was frozen at policy-creation time, in
// whatever `IntervalStyle` that session used — so the transaction's `SET LOCAL intervalstyle` cannot
// re-render them (a policy created under `iso_8601` reads back as `P7D`, which the canonicalizer
// quarantines, producing permanent false drift). Round-trip each one through `::interval::text` so
// Postgres re-renders it in the `postgres` style this reader guarantees.
//
// Guarded twice so integer-time thresholds are never corrupted: they are stored as JSON *numbers*
// (`jsonb_typeof <> 'string'`), and a numeric string would still be skipped by the regex — a blind
// cast would silently turn `500000` into the interval `277:46:40`.
const POLICY_INTERVAL_KEYS = `'compress_after', 'compress_created_before', 'drop_after',
                              'drop_created_before', 'start_offset', 'end_offset'`;

const JOBS_SQL = `
  SELECT j.proc_name, j.schedule_interval::text AS schedule_interval,
         j.hypertable_schema, j.hypertable_name,
         (j.config->>'mat_hypertable_id')::bigint AS mat_hypertable_id,
         norm.config AS config
    FROM timescaledb_information.jobs j
    LEFT JOIN LATERAL (
      SELECT coalesce(jsonb_object_agg(e.key,
               CASE WHEN e.key IN (${POLICY_INTERVAL_KEYS})
                     AND jsonb_typeof(e.value) = 'string'
                     AND (e.value #>> '{}') !~ '^-?[0-9]+$'
                    THEN to_jsonb(((e.value #>> '{}')::interval)::text)
                    ELSE e.value END), j.config) AS config
        FROM jsonb_each(j.config) AS e
    ) norm ON TRUE
   WHERE j.proc_name IN ('policy_compression', 'policy_retention',
                         'policy_refresh_continuous_aggregate')`;

// Continuous aggregates with hierarchy + source resolution. `parent_*` (non-null ⇒ hierarchical) is
// the parent CAGG's user view; `raw_*` is the base hypertable (used as the source for a
// non-hierarchical CAGG — for a hierarchical one `raw_hypertable_id` points at the parent's internal
// materialization hypertable, so the parent user view is used instead). `finalized` is never
// selected (removed in 2.28).
const CAGGS_SQL = `
  SELECT c.view_schema, c.view_name, c.materialized_only, c.view_definition,
         cat.mat_hypertable_id,
         parent.user_view_schema AS parent_schema, parent.user_view_name AS parent_view,
         rawht.schema_name AS raw_schema, rawht.table_name AS raw_table
    FROM timescaledb_information.continuous_aggregates c
    JOIN _timescaledb_catalog.continuous_agg cat
      ON cat.user_view_schema = c.view_schema AND cat.user_view_name = c.view_name
    LEFT JOIN _timescaledb_catalog.continuous_agg parent
      ON parent.mat_hypertable_id = cat.parent_mat_hypertable_id
    LEFT JOIN _timescaledb_catalog.hypertable rawht
      ON rawht.id = cat.raw_hypertable_id
   ORDER BY c.view_schema, c.view_name`;

/**
 * Degraded CAGG read: `timescaledb_information.continuous_aggregates` ONLY, touching no
 * `_timescaledb_catalog` table.
 *
 * Why this exists. The enriched query above joins `_timescaledb_catalog.continuous_agg` and
 * `_timescaledb_catalog.hypertable`. Those are internal catalog tables, and 2.29.0 already did
 * exactly this kind of surgery to a sibling — replacing `schema_name`/`table_name` on
 * `_timescaledb_catalog.chunk` with `relid regclass`. If the same happens to `hypertable`, the
 * enriched query throws a raw `column "schema_name" does not exist`, and because `introspect()` is
 * the CURRENT side of the diff, EVERY command that touches a live database — pull, push, check,
 * generate — fails at once. Unlike the recompression planner, there was no degraded mode at all.
 *
 * This fallback is EQUIVALENT, not lossy, and that is measured rather than assumed. The public view
 * exposes `hypertable_schema`/`hypertable_name` (the raw source) and
 * `materialization_hypertable_schema`/`_name` on both 2.18.0 and 2.29.1 — verified against live
 * containers of each. Hierarchy is recovered without the catalog: a hierarchical aggregate's source
 * IS the parent's materialization hypertable, so mapping every row's materialization hypertable back
 * to its own user view resolves the parent. The refresh policy still attaches, because the job's
 * `mat_hypertable_id` comes from the JOB'S OWN config JSON, never from the catalog.
 *
 * If a future server makes this fallback non-equivalent, it must stop being silent — a degraded read
 * that reports itself as complete is the failure mode this whole audit kept finding.
 */
const CAGGS_FALLBACK_SQL = `
  SELECT c.view_schema, c.view_name, c.materialized_only, c.view_definition,
         c.hypertable_schema AS raw_schema, c.hypertable_name AS raw_table,
         c.materialization_hypertable_schema AS mat_schema,
         c.materialization_hypertable_name AS mat_name
    FROM timescaledb_information.continuous_aggregates c
   ORDER BY c.view_schema, c.view_name`;

/** Build the ordered {@link DimensionState}[] for one hypertable from its dimension rows. */
function toDimensions(rows: DimensionRow[]): DimensionState[] {
  return rows
    .slice()
    .sort((a, b) => Number(a.dimension_number) - Number(b.dimension_number))
    .map((r): DimensionState => {
      if (r.dimension_type === 'Space') {
        const numPartitions = r.num_partitions == null ? undefined : Number(r.num_partitions);
        return {
          column: r.column_name,
          kind: 'space',
          ...(numPartitions !== undefined ? { numPartitions } : {}),
        };
      }
      // Time dimension: interval-time carries `time_interval`, integer-time carries `integer_interval`.
      let chunkInterval: IntervalOrInt | undefined;
      if (r.time_interval != null) chunkInterval = r.time_interval;
      else if (r.integer_interval != null) chunkInterval = Number(r.integer_interval);
      return {
        column: r.column_name,
        kind: 'time',
        ...(chunkInterval !== undefined ? { chunkInterval } : {}),
      };
    });
}

/** Build the {@link ColumnstoreState} for one hypertable from its compression-settings row. */
function toColumnstore(row: ColumnstoreRow): ColumnstoreState {
  const segmentBy = toArray(row.segmentby).map((v) => String(v));
  const cols = toArray(row.orderby).map((v) => String(v));
  const desc = toArray(row.orderby_desc).map((v) => toBool(v));
  const nullsFirst = toArray(row.orderby_nullsfirst).map((v) => toBool(v));
  const orderBy: OrderByElement[] = cols.map((column, i) => ({
    column,
    desc: desc[i] ?? false,
    nullsFirst: nullsFirst[i] ?? false,
  }));
  return { segmentBy, orderBy };
}

/**
 * Introspect a live TimescaleDB into a {@link SchemaStateIR}. The DataSource must be initialized.
 *
 * Reads run inside a single read-only transaction (rolled back at the end — no side effects) that
 * first sets `intervalstyle = 'postgres'`, so all interval text is in the one form the Slice-1
 * canonicalizer understands.
 */
export async function introspect(
  dataSource: DataSource,
  options: IntrospectOptions = {},
): Promise<SchemaStateIR> {
  // Match the other runtime entry points: an uninitialized DataSource otherwise surfaced a raw
  // TypeORM error instead of this package's typed, actionable one.
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before introspecting',
    );
  }
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction();
    try {
      // Slice-1 precondition — scoped to this transaction only (no global/session mutation).
      await runner.query("SET LOCAL intervalstyle = 'postgres'");

      const versionRows: Array<{ extversion: unknown }> = await runner.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
      );
      // Fail fast with a typed, actionable error instead of letting the four catalog queries below
      // hit a plain-PostgreSQL (or not-yet-`CREATE EXTENSION`'d) database and surface a raw
      // `relation "timescaledb_information.hypertables" does not exist` straight from pg. Mirrors
      // assertSchema()'s TIMESCALEDB_MISSING guard, but reuses this query (already run to record
      // the version) instead of a second round-trip against pg_extension.
      //
      // This gates on PRESENCE only. The "recorded, not gated on" note in the module docs above is
      // about the VERSION: there is deliberately no range check, because robustness across the
      // supported range comes from query design. Absent is a different case from unexpected — with
      // no extension there is no catalog to read at all.
      if (versionRows.length === 0) {
        throw new TimescaleError(
          TimescaleErrorCode.TIMESCALEDB_MISSING,
          'timescaledb is not installed on this database — run `CREATE EXTENSION timescaledb;` ' +
            '(or connect to a TimescaleDB-enabled database) before introspecting',
        );
      }
      const timescaledbVersion =
        versionRows[0]?.extversion != null ? String(versionRows[0].extversion) : undefined;

      // Sequential — a single connection (this queryRunner) cannot execute concurrent queries;
      // issuing them in parallel would serialize under a deprecated node-pg path (removed in pg@9).
      const htRows: Array<{ hypertable_schema: string; hypertable_name: string }> =
        await runner.query(HYPERTABLES_SQL);
      const dimRows: DimensionRow[] = await runner.query(DIMENSIONS_SQL);
      const colRows: ColumnstoreRow[] = await runner.query(COLUMNSTORE_SQL);
      const jobRows: JobRow[] = await runner.query(JOBS_SQL);
      // Enriched read first; the public-view-only fallback if the internal catalog has moved.
      // `degradedCaggRead` changes how hierarchy and refresh are resolved below, because the
      // fallback carries different columns — it does not change what is reported.
      let caggRows: CaggRow[];
      let degradedCaggRead = false;
      try {
        caggRows = await runner.query(CAGGS_SQL);
      } catch {
        caggRows = await runner.query(CAGGS_FALLBACK_SQL);
        degradedCaggRead = true;
      }

      // Index the side tables by (schema, name) for O(1) assembly.
      const dimsByHt = new Map<string, DimensionRow[]>();
      for (const r of dimRows) {
        const k = key(r.hypertable_schema, r.hypertable_name);
        (dimsByHt.get(k) ?? dimsByHt.set(k, []).get(k)!).push(r);
      }
      const colByHt = new Map<string, ColumnstoreRow>();
      for (const r of colRows) colByHt.set(key(r.schema, r.name), r);

      // Compression/retention policies keyed by the hypertable they name; refresh policies keyed by
      // mat_hypertable_id (joined to the CAGG below).
      const compressionByHt = new Map<string, PolicyState>();
      const retentionByHt = new Map<string, PolicyState>();
      const refreshByMatId = new Map<string, PolicyState>();
      const refreshByJobHypertable = new Map<string, PolicyState>();
      for (const j of jobRows) {
        const config = j.config ?? {};
        const sched = j.schedule_interval ?? undefined;
        const policy = parsePolicyConfig(j.proc_name, config, sched);
        if (j.proc_name === 'policy_refresh_continuous_aggregate') {
          if (j.mat_hypertable_id != null) refreshByMatId.set(String(j.mat_hypertable_id), policy);
          // Second index, for the degraded CAGG read, which has no mat_hypertable_id to join on.
          // `jobs.hypertable_*` is the materialization hypertable on 2.18 and the user view on
          // 2.28+, so one map keyed by that name covers both servers — the same dual-identity fact
          // assertSchema and listJobs already rely on.
          if (j.hypertable_schema != null && j.hypertable_name != null) {
            refreshByJobHypertable.set(key(j.hypertable_schema, j.hypertable_name), policy);
          }
        } else if (j.hypertable_schema != null && j.hypertable_name != null) {
          const k = key(j.hypertable_schema, j.hypertable_name);
          if (j.proc_name === 'policy_compression') compressionByHt.set(k, policy);
          else if (j.proc_name === 'policy_retention') retentionByHt.set(k, policy);
        }
      }

      const wantSchema = options.schemas ? new Set(options.schemas) : undefined;

      const hypertables: HypertableState[] = htRows
        .filter((r) => !wantSchema || wantSchema.has(r.hypertable_schema))
        .map((r): HypertableState => {
          const k = key(r.hypertable_schema, r.hypertable_name);
          const col = colByHt.get(k);
          const compression = compressionByHt.get(k);
          const retention = retentionByHt.get(k);
          return {
            table: `${r.hypertable_schema}.${r.hypertable_name}`,
            dimensions: toDimensions(dimsByHt.get(k) ?? []),
            ...(col ? { columnstore: toColumnstore(col) } : {}),
            ...(compression ? { compressionPolicy: compression } : {}),
            ...(retention ? { retentionPolicy: retention } : {}),
          };
        });

      // Degraded path only: map each aggregate's MATERIALIZATION hypertable back to its own user
      // view. A hierarchical aggregate reads FROM its parent's materialization hypertable, so this
      // is what recovers the parent identity that the catalog join would otherwise supply.
      const viewByMatHypertable = new Map<string, string>();
      if (degradedCaggRead) {
        for (const r of caggRows) {
          if (r.mat_schema != null && r.mat_name != null) {
            viewByMatHypertable.set(
              key(r.mat_schema, r.mat_name),
              `${r.view_schema}.${r.view_name}`,
            );
          }
        }
      }

      const continuousAggregates: ContinuousAggregateState[] = caggRows
        .filter((r) => !wantSchema || wantSchema.has(r.view_schema))
        .map((r): ContinuousAggregateState => {
          const rawSource =
            r.raw_schema != null && r.raw_table != null ? `${r.raw_schema}.${r.raw_table}` : '';
          // Enriched read states the parent outright. Degraded read infers it: if this aggregate's
          // source is another aggregate's materialization hypertable, that aggregate is the parent.
          const inferredParent = degradedCaggRead
            ? r.raw_schema != null && r.raw_table != null
              ? viewByMatHypertable.get(key(r.raw_schema, r.raw_table))
              : undefined
            : undefined;
          const hierarchical =
            (r.parent_schema != null && r.parent_view != null) || inferredParent !== undefined;
          const source =
            r.parent_schema != null && r.parent_view != null
              ? `${r.parent_schema}.${r.parent_view}`
              : (inferredParent ?? rawSource);
          const refresh =
            r.mat_hypertable_id != null
              ? refreshByMatId.get(String(r.mat_hypertable_id))
              : // Degraded read: match the job by the materialization hypertable, then by the user
                // view, covering both the 2.18 and the 2.28+ meaning of jobs.hypertable_*.
                ((r.mat_schema != null && r.mat_name != null
                  ? refreshByJobHypertable.get(key(r.mat_schema, r.mat_name))
                  : undefined) ?? refreshByJobHypertable.get(key(r.view_schema, r.view_name)));
          return {
            viewName: `${r.view_schema}.${r.view_name}`,
            source,
            hierarchical,
            materializedOnly: toBool(r.materialized_only),
            definition: r.view_definition ?? '',
            ...(refresh ? { refresh } : {}),
          };
        });

      return {
        hypertables,
        continuousAggregates,
        ...(timescaledbVersion !== undefined ? { timescaledbVersion } : {}),
      };
    } finally {
      // Read-only — nothing to persist; roll back so the SET LOCAL and the txn leave no trace.
      if (runner.isTransactionActive) await runner.rollbackTransaction();
    }
  } finally {
    await runner.release();
  }
}

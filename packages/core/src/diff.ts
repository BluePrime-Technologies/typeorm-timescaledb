import type {
  ColumnstoreState,
  DimensionState,
  HypertableState,
  IntervalOrInt,
  OrderByElement,
  PolicyState,
  SchemaStateIR,
} from './schema-state.js';
import type { ColumnstoreConfig } from './sql/index.js';
import type {
  AddColumnstorePolicyOperation,
  Operation,
  RenameHypertableOperation,
} from './operation.js';
import { classifyOperation, type OperationSafety } from './safety.js';
import { intervalsEqual, TIMESCALE_DEFAULTS } from './normalize.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';

/**
 * The migration engine's DIFF (M4.2). `diffSchemaState(current, desired)` compares the current live-DB
 * state (`introspect()`) against the desired decorator state (`compileDesiredState()`) — both the
 * canonical {@link SchemaStateIR} — and returns an ordered {@link Plan}: the operations needed to
 * converge current → desired. An unchanged schema yields an **empty plan** (no drift).
 *
 * **Scope: additive creates + POLICY alters.** It emits:
 *   - a hypertable in `desired` not in `current` → the full create sequence (create_hypertable +
 *     optional space dimension, columnstore enable + policy, retention policy);
 *   - on an EXISTING hypertable: a columnstore or a retention policy present in `desired` but absent in
 *     `current` → that add; a compression policy present in `desired` but missing on an already-enabled
 *     columnstore → an `addCompressionPolicy` (policy-only, closes the former gap); a compression or
 *     retention **threshold that changed** → an `alter{Compression,Retention}Policy` (remove-then-add,
 *     `down()` restores the prior threshold); a **time-dimension chunk interval that changed** →
 *     `setChunkInterval` (affects future chunks only; reconciled against `TIMESCALE_DEFAULTS.chunkInterval`
 *     when desired omits it, so a bare hypertable at the engine default is not false drift).
 *
 * Policy threshold comparison uses the M4.0 normalizers and IGNORES `scheduleInterval` — the desired
 * side never sets it and the engine fills a default the introspected current always carries, so
 * comparing it would be false drift (per the S1 characterization tests). So an unchanged schema still
 * yields an **empty plan**.
 *
 * **Guarded drops (opt-in via `DiffOptions.allowDrops`, default off).** When enabled, the diff emits the
 * SAFE, reversible removals of objects present in `current` but absent from `desired`:
 * `removeRetentionPolicy` / `removeCompressionPolicy` (removing a background job deletes no data;
 * `down` re-adds it at the prior threshold). With `allowDrops` off (the default), NO drop is emitted, so
 * omitting a decorator option is never silently destructive.
 *
 * It deliberately does **NOT** emit (even with `allowDrops`):
 *   - **destructive drops** — dropping a hypertable (present in current, absent from the entity set) or
 *     disabling a columnstore (decompress). Data-destructive / no data-safe `down()`; they need their own
 *     explicit destructive opt-in + irreversible-op design (a follow-up beyond M4.2). A whole
 *     current-only hypertable is simply never visited, so it is never dropped. Corollary: if `desired`
 *     removes an entire columnstore while `current` still has a compression policy on it, no
 *     `removeCompressionPolicy` is emitted (that gate requires the columnstore to remain in both). The
 *     plan is safe but non-convergent for that scenario until the destructive-drop slice lands.
 *
 * **Step order is significant.** Steps are emitted in dependency order (e.g. a `renameHypertable`
 * precedes any policy op that targets the new name) and `compileOperations` preserves it. Consumers
 * must execute `Plan.steps` in order and MUST NOT re-sort them (e.g. by safety class).
 *   - **continuous aggregates** — `compileDesiredState()` does not yet compile them, so acting on them
 *     would drop every live CAGG. The diff is hypertable-scoped and ignores `continuousAggregates`.
 *   - **clearing a columnstore facet** — an EMPTY desired `segmentBy`/`orderBy` means "unmanaged / accept
 *     the engine default", not "remove"; the IR can't distinguish unset from explicitly-empty, so the diff
 *     never emits an alter to clear a facet the current DB has set. Also: **NULLS placement is unmanaged**
 *     (decorators can't express it) — see `toColumnstoreConfig`.
 *
 * **Integer-time / `created_before` policy thresholds THROW** (never silent under-convergence): they
 * can't be expressed by the string-only builders, so the diff raises `INVALID_ARGUMENT` rather than a
 * wrong op or a false "converged". (The decorator path only produces string `after` thresholds.)
 *
 * **Rename resolution.** A hypertable renamed at the decorator level (new `table`, no matching
 * `current` entry) would otherwise diff as a drop-then-create — the Prisma/EF anti-pattern the M4.2
 * plan calls out, and worse here: `createHypertableOperations` would attempt `create_hypertable` on a
 * table that already IS one under its old name. Callers pass a `renames` map (desired table → current
 * table, collected from `@Hypertable({ renamedFrom })`) via {@link DiffOptions}; when `desired.table`
 * has no direct `current` match but resolves through `renames` to one that does, the diff matches the
 * two as the SAME hypertable: it emits a single `renameHypertable` op first, then diffs the rest
 * (columnstore/policies) against the matched current entry exactly as an existing-table update. Two
 * desired hypertables resolving to the same current one (an ambiguous rename) THROWS.
 *
 * {@link isEmptyPlan} means "no operation IN SCOPE is needed" — not a guarantee of full convergence
 * (drops and CAGGs are still out of scope).
 */

/** Options for {@link diffSchemaState}. */
export interface DiffOptions {
  /**
   * Rename resolution map: desired (new) schema-qualified table name → current (old) schema-qualified
   * table name. Collected from `@Hypertable({ renamedFrom })` declarations (see the `typeorm` package's
   * `collectRenames`). When a desired hypertable isn't found in `current` under its own name but
   * resolves through this map to one that is, the diff treats them as the same hypertable and emits a
   * `renameHypertable` op instead of a drop-then-create.
   */
  readonly renames?: ReadonlyMap<string, string>;
  /**
   * Opt-in to emitting DROP operations for objects present in `current` but absent from `desired`.
   * Default `false` (drops are never emitted, so omitting a decorator option is not silently
   * destructive). When `true`, the diff emits only the SAFE, reversible removals — `removeRetentionPolicy`
   * / `removeCompressionPolicy` (removing a background job deletes no data; `down` re-adds it). Truly
   * destructive drops (dropping a hypertable, disabling a columnstore) are still NOT emitted — they need
   * an explicit destructive opt-in and an irreversible-op design (a follow-up beyond M4.2).
   */
  readonly allowDrops?: boolean;
}

/** One step of a {@link Plan}: an operation plus its {@link OperationSafety} classification. */
export interface PlanStep extends OperationSafety {
  readonly operation: Operation;
}

/** An ordered migration plan — the steps to converge the current schema toward the desired one, each
 * tagged with its safety class so the `check`/`generate` verbs can gate or refuse per step. */
export interface Plan {
  /** Steps in apply order. Empty ⇒ no drift. */
  readonly steps: readonly PlanStep[];
}

/** `true` when the plan has no steps (no drift) — the `check`-verb gate (a later slice). NOTE: this
 * reflects only what the current diff detects (additive create-only in this slice), not full convergence. */
export function isEmptyPlan(plan: Plan): boolean {
  return plan.steps.length === 0;
}

function findDimension(h: HypertableState, kind: 'time' | 'space'): DimensionState | undefined {
  return h.dimensions.find((d) => d.kind === kind);
}

/** Build the `addColumnstorePolicy` operation for a hypertable's declared columnstore. Combines the
 * columnstore enable/config (segmentBy/orderBy) with the compression policy threshold (`after`), which
 * the single core builder emits together. NULLS placement is not carried — the builder emits
 * `col ASC|DESC` and the engine applies the per-direction default (the value the desired state used). */
function columnstoreOperation(h: HypertableState): AddColumnstorePolicyOperation {
  const cs = h.columnstore;
  if (cs === undefined) {
    // Unreachable via the call sites (guarded), but keeps the function total.
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `hypertable ${h.table} has no columnstore to compile`,
    );
  }
  const after = h.compressionPolicy?.kind === 'compression' ? h.compressionPolicy.after : undefined;
  // A numeric threshold is an integer-time value the string-only builder cannot express. THROW rather
  // than silently omit it — a silent omission would enable the columnstore while dropping the declared
  // compression policy, and report the schema as converged when it is not (see module doc).
  if (typeof after === 'number') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `hypertable ${h.table}: integer-time compression threshold (${after}) is not expressible by the migration builder`,
      { table: h.table },
    );
  }
  return {
    kind: 'addColumnstorePolicy',
    table: h.table,
    ...(cs.segmentBy.length > 0 && { segmentBy: [...cs.segmentBy] }),
    ...(cs.orderBy.length > 0 && {
      orderBy: cs.orderBy.map((o) => ({
        column: o.column,
        direction: o.desc ? ('DESC' as const) : ('ASC' as const),
      })),
    }),
    ...(after !== undefined && { after }),
  };
}

/** The `addRetentionPolicy` op for a hypertable's declared retention. Call only when a retention policy
 * is present. THROWS on a shape the string-only builder can't express (integer-time `after`, or the
 * `created_before` variant with no string `after`) rather than silently reporting convergence. */
function retentionOperation(h: HypertableState): Operation {
  const r = h.retentionPolicy;
  if (r === undefined || r.kind !== 'retention' || typeof r.after !== 'string') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `hypertable ${h.table}: retention policy is not expressible by the additive builder (needs a string drop_after interval; integer-time and created_before variants are unsupported)`,
      { table: h.table },
    );
  }
  return { kind: 'addRetentionPolicy', table: h.table, dropAfter: r.after };
}

/** The compression policy's `after` threshold, if the policy is a compression kind. */
function compressionAfter(h: HypertableState): IntervalOrInt | undefined {
  return h.compressionPolicy?.kind === 'compression' ? h.compressionPolicy.after : undefined;
}
/** The retention policy's `after` (drop_after) threshold, if the policy is a retention kind. */
function retentionAfter(h: HypertableState): IntervalOrInt | undefined {
  return h.retentionPolicy?.kind === 'retention' ? h.retentionPolicy.after : undefined;
}

/** Assert a policy threshold is an emittable string interval. Integer-time thresholds and the
 * `created_before` variant (which yields an undefined `after`) can't be expressed by the alter/add
 * builders — throw rather than emit a wrong op or silently under-converge. */
function stringThreshold(value: IntervalOrInt | undefined, table: string, what: string): string {
  if (typeof value !== 'string') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `hypertable ${table}: ${what} is not a string interval — integer-time and created_before policies are not expressible by the alter builders`,
      { table },
    );
  }
  return value;
}

/** Do two same-kind compression/retention policies have the same THRESHOLD? Compares `after` +
 * `createdBefore` via the M4.0 normalizers; deliberately IGNORES `scheduleInterval` — the desired
 * (decorator) side never sets it, and the engine fills a default the introspected current always
 * carries, so comparing it would be false drift (see the S1 characterization tests).
 * TODO: when the decorator surface exposes a custom policy schedule, compare scheduleInterval too
 * (only when the desired side sets it) — otherwise a deliberately-changed schedule would be missed. */
function policyThresholdEqual(a: PolicyState, b: PolicyState): boolean {
  if (a.kind !== b.kind) return false;
  if (
    (a.kind === 'compression' || a.kind === 'retention') &&
    (b.kind === 'compression' || b.kind === 'retention')
  ) {
    return intervalsEqual(a.after, b.after) && intervalsEqual(a.createdBefore, b.createdBefore);
  }
  return false;
}

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Compare columnstore orderby on column + direction ONLY. NULLS placement is deliberately excluded:
 * the builder emits `col ASC|DESC` (engine default NULLS), so a NULLS-only difference isn't expressible
 * and must not be reported as (non-convergent) drift. */
function orderByEqual(a: readonly OrderByElement[], b: readonly OrderByElement[]): boolean {
  return (
    a.length === b.length && a.every((x, i) => x.column === b[i]!.column && x.desc === b[i]!.desc)
  );
}

const orderElementToConfig = (
  o: OrderByElement,
): { column: string; direction: 'ASC' | 'DESC' } => ({
  column: o.column,
  direction: o.desc ? 'DESC' : 'ASC',
});

/** Convert a `ColumnstoreState` (IR) to the builder's `ColumnstoreConfig` (segmentBy + orderBy as
 * column/direction). NULLS placement is dropped (per {@link orderByEqual}) — the whole engine cannot
 * express NULLS (decorators have no such option, and no builder emits it), so a non-default NULLS set
 * out-of-band is UNMANAGED: it is neither diffed nor restored by `down()`. Consistent, not data-losing. */
function toColumnstoreConfig(cs: ColumnstoreState): ColumnstoreConfig {
  return { segmentBy: [...cs.segmentBy], orderBy: cs.orderBy.map(orderElementToConfig) };
}

/** The full create sequence for a hypertable absent from the current DB. */
function createHypertableOperations(h: HypertableState): Operation[] {
  const time = findDimension(h, 'time');
  if (time === undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.NO_TIME_COLUMN,
      `hypertable ${h.table} has no time dimension`,
      { table: h.table },
    );
  }
  // A numeric chunk interval is integer-time — the builder emits `INTERVAL '...'`, which can't express
  // it. Throw rather than silently create the hypertable with the default interval. (An UNDECLARED
  // interval — undefined — is fine: it legitimately uses the create-time default.)
  if (typeof time.chunkInterval === 'number') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `hypertable ${h.table}: integer-time chunk interval (${time.chunkInterval}) is not expressible by the migration builder`,
      { table: h.table },
    );
  }
  const space = findDimension(h, 'space');
  let spacePartition: { readonly column: string; readonly partitions: number } | undefined;
  if (space !== undefined) {
    if (space.numPartitions === undefined) {
      // A space dimension with no partition count can't be emitted (add_dimension needs number_partitions);
      // throw rather than silently drop the dimension.
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `hypertable ${h.table}: space dimension "${space.column}" is missing numPartitions`,
        { table: h.table },
      );
    }
    spacePartition = { column: space.column, partitions: space.numPartitions };
  }
  const ops: Operation[] = [
    {
      kind: 'createHypertable',
      table: h.table,
      timeColumn: time.column,
      ...(typeof time.chunkInterval === 'string' && { chunkInterval: time.chunkInterval }),
      ...(spacePartition !== undefined && { spacePartition }),
    },
  ];
  if (h.columnstore !== undefined) ops.push(columnstoreOperation(h));
  if (h.retentionPolicy !== undefined) ops.push(retentionOperation(h));
  return ops;
}

/**
 * Diff the current schema against the desired schema and return the additive {@link Plan}. See the
 * module doc for the exact (create-only) scope. Hypertables are processed in `desired` order (which is
 * deterministic — both producers sort by table name).
 */
export function diffSchemaState(
  current: SchemaStateIR,
  desired: SchemaStateIR,
  options: DiffOptions = {},
): Plan {
  const currentByTable = new Map<string, HypertableState>(
    current.hypertables.map((h) => [h.table, h]),
  );
  const renames = options.renames ?? new Map<string, string>();
  const allowDrops = options.allowDrops ?? false;
  // Tracks which OLD (current) table a rename has already resolved to this pass, so two desired
  // hypertables can never both claim the same current entry (an ambiguous/duplicate rename) — caught
  // below rather than silently diffing one of them as a spurious create.
  const renamedFromTable = new Map<string, string>();
  const operations: Operation[] = [];

  for (const d of desired.hypertables) {
    // A compression policy requires the columnstore to be enabled. Reject the inconsistent desired
    // shape loudly rather than silently drop the policy (it isn't reachable from compileDesiredState,
    // which only sets compressionPolicy alongside a columnstore, but guard manually-built IR).
    if (d.compressionPolicy !== undefined && d.columnstore === undefined) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `hypertable ${d.table}: a compression policy requires a columnstore, but none is declared`,
        { table: d.table },
      );
    }

    let c = currentByTable.get(d.table);
    let renameOp: RenameHypertableOperation | undefined;

    if (c === undefined) {
      const oldTable = renames.get(d.table);
      const oldEntry = oldTable === undefined ? undefined : currentByTable.get(oldTable);
      if (oldTable !== undefined && oldEntry !== undefined) {
        const claimedBy = renamedFromTable.get(oldTable);
        if (claimedBy !== undefined) {
          throw new TimescaleError(
            TimescaleErrorCode.INVALID_ARGUMENT,
            `ambiguous rename: both ${claimedBy} and ${d.table} declare renamedFrom(${oldTable})`,
            { oldTable, desired: [claimedBy, d.table] },
          );
        }
        renamedFromTable.set(oldTable, d.table);
        c = oldEntry;
        renameOp = { kind: 'renameHypertable', from: oldTable, to: d.table };
      }
    }

    if (c === undefined) {
      // Whole hypertable missing (and no rename resolves it) → emit the full create sequence.
      operations.push(...createHypertableOperations(d));
      continue;
    }
    if (renameOp !== undefined) operations.push(renameOp);

    // Existing table (possibly just renamed above). Time-dimension chunk interval change →
    // set_chunk_time_interval. Reconcile the engine default: when desired omits chunkInterval it means
    // "the create-time default", which introspect() reads back as the concrete
    // TIMESCALE_DEFAULTS.chunkInterval — so compare against that, not undefined, to avoid false drift on
    // a bare hypertable (the S1 characterization contract).
    const currentTime = findDimension(c, 'time');
    const desiredTime = findDimension(d, 'time');
    if (currentTime !== undefined && desiredTime !== undefined) {
      const desiredInterval = desiredTime.chunkInterval ?? TIMESCALE_DEFAULTS.chunkInterval;
      if (!intervalsEqual(currentTime.chunkInterval, desiredInterval)) {
        operations.push({
          kind: 'setChunkInterval',
          table: d.table,
          from: stringThreshold(currentTime.chunkInterval, d.table, 'current chunk interval'),
          to: stringThreshold(desiredInterval, d.table, 'desired chunk interval'),
        });
      }
    }

    // Additive: enable a wholly-missing columnstore. On an already-columnstore table, handle the
    // compression POLICY (add the missing one — the S2 gap; or alter a changed threshold).
    if (d.columnstore !== undefined && c.columnstore === undefined) {
      operations.push(columnstoreOperation(d));
    } else if (d.columnstore !== undefined && c.columnstore !== undefined) {
      if (d.compressionPolicy !== undefined && c.compressionPolicy === undefined) {
        // columnstore enabled but no compression policy → add the policy only (no ALTER SET re-assert).
        operations.push({
          kind: 'addCompressionPolicy',
          table: d.table,
          after: stringThreshold(compressionAfter(d), d.table, 'compression after'),
        });
      } else if (
        d.compressionPolicy !== undefined &&
        c.compressionPolicy !== undefined &&
        !policyThresholdEqual(c.compressionPolicy, d.compressionPolicy)
      ) {
        // compression threshold changed → remove-then-add alter.
        operations.push({
          kind: 'alterCompressionPolicy',
          table: d.table,
          from: stringThreshold(compressionAfter(c), d.table, 'current compression after'),
          to: stringThreshold(compressionAfter(d), d.table, 'desired compression after'),
        });
      }
      // Columnstore segmentby/orderby config change → needs-recompress alter. Only facets the desired
      // side DECLARES (non-empty) are managed: an EMPTY desired segmentBy/orderBy means "accept the
      // engine default" (introspect fills the default orderby as the time column DESC), so it must not
      // false-drift (S1 characterization contract). For a declared facet that differs, emit one alter
      // that SETs the full target config (declared facet from desired; undeclared facet preserved from
      // current, so it isn't clobbered).
      const cur = c.columnstore;
      const des = d.columnstore;
      const segChanged =
        des.segmentBy.length > 0 && !stringArrayEqual(des.segmentBy, cur.segmentBy);
      const ordChanged = des.orderBy.length > 0 && !orderByEqual(des.orderBy, cur.orderBy);
      if (segChanged || ordChanged) {
        operations.push({
          kind: 'alterColumnstoreConfig',
          table: d.table,
          from: toColumnstoreConfig(cur),
          to: {
            segmentBy: des.segmentBy.length > 0 ? [...des.segmentBy] : [...cur.segmentBy],
            orderBy: (des.orderBy.length > 0 ? des.orderBy : cur.orderBy).map(orderElementToConfig),
          },
        });
      }
      // Dropping a compression policy present in current but not desired is a drop — deferred (AS3c).
    }

    // Retention: add a missing policy (additive), or alter a changed threshold.
    if (d.retentionPolicy !== undefined && c.retentionPolicy === undefined) {
      operations.push(retentionOperation(d));
    } else if (
      d.retentionPolicy !== undefined &&
      c.retentionPolicy !== undefined &&
      !policyThresholdEqual(c.retentionPolicy, d.retentionPolicy)
    ) {
      operations.push({
        kind: 'alterRetentionPolicy',
        table: d.table,
        from: stringThreshold(retentionAfter(c), d.table, 'current retention after'),
        to: stringThreshold(retentionAfter(d), d.table, 'desired retention after'),
      });
    }

    // Guarded DROPS (opt-in via allowDrops; off by default so omitting a decorator option is never
    // silently destructive). Only the SAFE, reversible policy removals are emitted — a policy present
    // in current but absent in desired. removeRetentionPolicy carries the current threshold so `down`
    // re-adds it. (Dropping the hypertable / disabling the columnstore is destructive and out of scope.)
    if (allowDrops) {
      if (c.retentionPolicy !== undefined && d.retentionPolicy === undefined) {
        operations.push({
          kind: 'removeRetentionPolicy',
          table: d.table,
          restoreAfter: stringThreshold(retentionAfter(c), d.table, 'current retention after'),
        });
      }
      // Only when the columnstore itself stays (present in both) — otherwise it's a columnstore drop.
      if (
        d.columnstore !== undefined &&
        c.columnstore !== undefined &&
        c.compressionPolicy !== undefined &&
        d.compressionPolicy === undefined
      ) {
        operations.push({
          kind: 'removeCompressionPolicy',
          table: d.table,
          restoreAfter: stringThreshold(compressionAfter(c), d.table, 'current compression after'),
        });
      }
    }
  }

  return { steps: operations.map((operation) => ({ operation, ...classifyOperation(operation) })) };
}

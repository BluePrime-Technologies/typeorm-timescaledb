import type { DimensionState, HypertableState, SchemaStateIR } from './schema-state.js';
import type { AddColumnstorePolicyOperation, Operation } from './operation.js';
import { classifyOperation, type OperationSafety } from './safety.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';

/**
 * The migration engine's DIFF (M4.2). `diffSchemaState(current, desired)` compares the current live-DB
 * state (`introspect()`) against the desired decorator state (`compileDesiredState()`) — both the
 * canonical {@link SchemaStateIR} — and returns an ordered {@link Plan}: the operations needed to
 * converge current → desired. An unchanged schema yields an **empty plan** (no drift).
 *
 * **Scope (this slice): ADDITIVE (create-only).** It emits an operation only for an object that is
 * present in `desired` but entirely ABSENT in `current`:
 *   - a hypertable in `desired` not in `current` → the full create sequence (create_hypertable +
 *     optional space dimension, columnstore enable + policy, retention policy);
 *   - on an EXISTING hypertable, a columnstore or a retention policy present in `desired` but not in
 *     `current` → just that add.
 *
 * It deliberately does **NOT** yet emit:
 *   - **alters** — content changes to an object that exists on both sides (a different chunk interval,
 *     changed segmentby/orderby, a retention interval change). These need new (non-additive) operations
 *     and, critically, `TIMESCALE_DEFAULTS` reconciliation (the system fills defaults `introspect()`
 *     reads back but the decorator omits — see `desired-state.ts`), plus per-op safety classification.
 *   - **drops** — a hypertable/object in `current` but not `desired` (destructive; migration `down()`
 *     never destroys data). These need safety classification and an explicit opt-in.
 *   - **continuous aggregates** — `compileDesiredState()` does not yet compile them, so acting on them
 *     would drop every live CAGG. The diff is hypertable-scoped and ignores `continuousAggregates`.
 *
 * Because it compares object PRESENCE (not content) on existing tables, it needs no default
 * reconciliation to be correct here: a round-tripped schema has every object present on both sides, so
 * the plan is empty. Alter-detection (the next slice) is where content comparison + `TIMESCALE_DEFAULTS`
 * reconciliation + safety classes come in.
 *
 * Two known limitations of THIS additive slice (both closed by the alter slice):
 *   - **Compression policy on an already-columnstore table.** The compression-policy add is folded into
 *     the columnstore op, which only fires when the columnstore is entirely absent. A table whose
 *     columnstore is enabled but whose `policy_compression` job is missing will NOT get the policy
 *     re-added — the diff reports converged. (Adding it alone needs a compression-policy-only operation.)
 *   - **Integer-time thresholds are not silently skipped — they THROW.** A numeric chunk interval or a
 *     numeric compression/retention threshold cannot be expressed by the string-only SQL builders; the
 *     diff throws `INVALID_ARGUMENT` rather than emit a wrong op or report a false convergence. (The
 *     decorator path never produces these — `chunkInterval`/`compressAfter`/`dropAfter` are string
 *     intervals — so this only guards manually-constructed or future integer-time desired states.)
 *
 * So {@link isEmptyPlan} means "no ADDITIVE operation is needed", NOT a guarantee of full convergence:
 * alters, drops, CAGGs, and the compression-policy-on-existing-columnstore gap are out of this slice.
 */

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
export function diffSchemaState(current: SchemaStateIR, desired: SchemaStateIR): Plan {
  const currentByTable = new Map<string, HypertableState>(
    current.hypertables.map((h) => [h.table, h]),
  );
  const operations: Operation[] = [];

  for (const d of desired.hypertables) {
    const c = currentByTable.get(d.table);
    if (c === undefined) {
      // Whole hypertable missing → emit the full create sequence.
      operations.push(...createHypertableOperations(d));
      continue;
    }
    // Existing table: additive-only. Emit an object present in desired but absent in current.
    // Content changes to objects present on BOTH sides are alters — deferred (see module doc).
    if (d.columnstore !== undefined && c.columnstore === undefined) {
      operations.push(columnstoreOperation(d));
    }
    if (d.retentionPolicy !== undefined && c.retentionPolicy === undefined) {
      operations.push(retentionOperation(d));
    }
  }

  return { steps: operations.map((operation) => ({ operation, ...classifyOperation(operation) })) };
}

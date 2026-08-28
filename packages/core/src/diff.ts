import type {
  ColumnstoreState,
  DimensionState,
  HypertableState,
  IntervalOrInt,
  OrderByElement,
  PolicyState,
  RefreshPolicy,
  SchemaStateIR,
} from './schema-state.js';
import type { ColumnstoreConfig } from './sql/index.js';
import { compileOperations } from './operation.js';
import type { AddColumnstorePolicyOperation, Operation } from './operation.js';
import { classifyOperation, type OperationSafety } from './safety.js';
import { intervalsEqual } from './normalize.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';
import { extractCaggFacets, caggFacetsEqual, type CaggFacets } from './cagg-facets.js';

/**
 * The migration engine's DIFF (M4.2). `diffSchemaState(current, desired)` compares the current live-DB
 * state (`introspect()`) against the desired decorator state (`compileDesiredState()`) — both the
 * canonical {@link SchemaStateIR} — and returns an ordered {@link Plan}: the operations needed to
 * converge current → desired. An unchanged schema yields an **empty plan** (no drift).
 *
 * **Continuous aggregates: additive creates, plus a STRUCTURAL definition comparison.** A desired
 * CAGG absent from the database is created (plus its declared refresh policy), and a declared refresh
 * policy missing from an existing CAGG is attached. An existing CAGG is never DROPPED. Its definition
 * IS compared — not textually (the catalog's `view_definition` is a parse-tree deparse an unchanged
 * aggregate does not match) but by parsing both sides into facets; see {@link extractCaggFacets}.
 * A definition the parser cannot read still raises `not-compared`, so a clean `check` never implies
 * more than it verified. A difference raises a blocking `not-expressible` advisory by default, or —
 * with {@link DiffOptions.continuousAggregateRecreate} — a `refuse-by-default` recreate step.
 * See {@link diffContinuousAggregates}.
 *
 * **Scope: additive creates + POLICY alters.** It emits:
 *   - a hypertable in `desired` not in `current` → the full create sequence (create_hypertable +
 *     optional space dimension, columnstore enable + policy, retention policy);
 *   - on an EXISTING hypertable: a columnstore or a retention policy present in `desired` but absent in
 *     `current` → that add; a compression policy present in `desired` but missing on an already-enabled
 *     columnstore → an `addCompressionPolicy` (policy-only, closes the former gap); a compression or
 *     retention **threshold that changed** → an `alter{Compression,Retention}Policy` (remove-then-add;
 *     `down()` restores the prior threshold ONLY when doing so lengthens it — see
 *     `alterRetentionPolicySQL`); a **declared time-dimension chunk interval that changed** →
 *     `setChunkInterval` (affects future chunks only). An UNDECLARED `chunkInterval` means unmanaged
 *     and is not compared at all, so a DBA-tuned interval is never reverted by a decorator that
 *     never mentioned chunk sizing.
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
 *     removes an entire columnstore while `current` still has a compression policy on it, the
 *     (reversible) `removeCompressionPolicy` IS emitted under `allowDrops` — only the columnstore
 *     itself is left alone — so the plan does not strand a policy it can safely remove.
 *
 * **Step order is significant.** Steps are emitted in dependency order (e.g. a `renameHypertable`
 * precedes any policy op that targets the new name) and `compileOperations` preserves it. Consumers
 * must execute `Plan.steps` in order and MUST NOT re-sort them (e.g. by safety class).
 *   - **dropping a continuous aggregate** — a CAGG present in the database but absent from `desired`
 *     is left alone even under `allowDrops`: its materialized rows may be the only surviving copy of
 *     data whose source chunks retention has dropped. RECREATING one whose definition drifted is
 *     emitted only behind {@link DiffOptions.continuousAggregateRecreate}, for the same reason.
 *   - **clearing a columnstore facet** — an EMPTY desired `segmentBy`/`orderBy` means "unmanaged / accept
 *     the engine default", not "remove"; the IR can't distinguish unset from explicitly-empty, so the diff
 *     never emits an alter to clear a facet the current DB has set. Also: **NULLS placement is unmanaged**
 *     (decorators can't express it) — see `toColumnstoreConfig`.
 *
 * **Integer-time / `created_before` POLICY thresholds THROW** (never silent under-convergence): they
 * can't be expressed by the string-only builders, so the diff raises `INVALID_ARGUMENT` rather than a
 * wrong op or a false "converged". (The decorator path only produces string `after` thresholds.) A
 * **chunk interval** is different: an undeclared one means "accept whatever the database has", so the
 * comparison is skipped rather than throwing — which also covers the integer-time case, since there
 * is no substituted default left to measure a number against.
 *
 * **Space dimensions THROW on divergence.** `add_dimension` is one-way and re-partitioning is not
 * expressible, so a declared space partition the database lacks (or a changed partition count) raises
 * `INVALID_ARGUMENT` naming the remedy — never a silent "no drift" on a schema that has diverged.
 *
 * **Rename resolution runs as a PRE-PASS**, before any hypertable is diffed. A hypertable renamed at
 * the decorator level (new `table`, no matching `current` entry) would otherwise diff as a
 * drop-then-create — the Prisma/EF anti-pattern the M4.2 plan calls out, and worse here:
 * `createHypertableOperations` would attempt `create_hypertable` on a table that already IS one under
 * its old name. Callers pass a `renames` map (desired table → current table, collected from
 * `@Hypertable({ renamedFrom })`) via {@link DiffOptions}. The pre-pass emits each
 * `renameHypertable` first and re-keys the current entry to its new name, so every later lookup sees
 * post-rename identity regardless of iteration order — which is what makes reusing a freed name
 * (rename `metrics`→`trades`, then declare a NEW `metrics`) correct rather than order-dependent.
 * A rename whose source no longer exists is a no-op. A target name already occupied in the database
 * (a mutual A↔B swap, inexpressible as a bare `ALTER ... RENAME` without an intermediate name)
 * THROWS rather than quietly converging per-facet and leaving the data unswapped. Two desired
 * hypertables claiming the same source (an ambiguous rename) THROWS.
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
   * What to do about a continuous aggregate whose DEFINITION has drifted from the declaration.
   *
   * TimescaleDB cannot `ALTER` a continuous aggregate's `SELECT`, so converging one means DROP +
   * CREATE, which discards its materialized rows — possibly the only surviving copy of data whose
   * source chunks retention has already dropped. That is too destructive to be automatic, and too
   * useful to omit, so it is a mode rather than a boolean:
   *
   * - `'advise'` (**default**) — raise the blocking `not-expressible` advisory 0.7.x shipped and emit
   *   NO step. `check` still fails on the drift; nothing can converge it automatically.
   * - `'plan'` — emit a {@link RecreateContinuousAggregateOperation} step, so `check` and `generate`
   *   show exactly what convergence would take. It is still never applied: `pushSchema` holds it back
   *   and applies the rest of the plan, reporting what it skipped.
   * - `'apply'` — emit the step AND allow it to run, but only with `allowRefuseByDefault` on top.
   *   Two independent gates, so the flag a user already passes to shorten a retention window cannot
   *   by itself discard an aggregate's history.
   *
   * `'apply'` is deliberately NOT readable from `timescaledb.config.json`: a file committed to the
   * repository must never pre-authorise a destructive run for everyone who later types the command.
   */
  readonly continuousAggregateRecreate?: 'advise' | 'plan' | 'apply';
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
  /** Steps in apply order. Empty ⇒ no drift **among the things this engine compares**. */
  readonly steps: readonly PlanStep[];
  /**
   * Things the caller must be told that are NOT expressed as steps. Never empty-but-present: omitted
   * when there is nothing to say.
   *
   * This exists so "no drift detected" can never mean "I didn't look". Anything the engine
   * deliberately does not compare, or compares but cannot converge, is named here instead of
   * silently passing.
   */
  readonly advisories?: readonly PlanAdvisory[];
}

/**
 * A fact about the diff that is not a step.
 *
 * `not-compared` — in scope but deliberately unexamined (informational; not drift).
 * `not-expressible` — a genuine divergence the engine refuses to guess at. This IS drift: a `check`
 *   that exits clean on one of these would be exactly the false-green the advisory exists to prevent.
 */
export interface PlanAdvisory {
  readonly kind: 'not-compared' | 'not-expressible';
  /** The object the advisory is about (e.g. a schema-qualified CAGG view name). */
  readonly object: string;
  /** Human-readable explanation, including the remedy where one exists. */
  readonly detail: string;
}

/** `true` when the plan has no steps (no drift) — the gate behind the `check` verb. NOTE: this
 * reflects only what the current diff detects (additive create-only in this slice), not full convergence. */
export function isEmptyPlan(plan: Plan): boolean {
  return plan.steps.length === 0;
}

/** The reversible SQL for a whole {@link Plan}: `up` in step order, `down` in the exact reverse. */
export interface CompiledPlan {
  /** Atomic `up` statements for every step, concatenated in apply (step) order. */
  readonly up: readonly string[];
  /** Atomic `down` statements — each step's own reversible `down`, with the STEPS reversed so the
   * most-recently-applied change is undone first. */
  readonly down: readonly string[];
}

/**
 * Compile a diff {@link Plan} into its reversible `up`/`down` SQL by routing every step's operation
 * through the single {@link compileOperation} choke point (via {@link compileOperations}). `up` is the
 * per-step `up` in step order; `down` is each step's own `down` with the STEP sequence reversed, so
 * undo happens most-recent-first (the same assembly rule the decorator-driven generator uses).
 *
 * This is the bridge from the M4.2 diff engine to the M4.3 emitters: a `Plan` (today only previewable
 * via `check`) becomes a committable migration. It adds no SQL of its own — each step's `down` is
 * already reversible (or a non-destructive notice for one-way ops), so the plan's `down` never
 * destroys data. An empty plan compiles to empty `up`/`down`.
 */
export function compilePlan(plan: Plan): CompiledPlan {
  const statements = compileOperations(plan.steps.map((s) => s.operation));
  const up: string[] = [];
  const down: string[] = [];
  for (const s of statements) up.push(...s.up);
  for (const s of [...statements].reverse()) down.push(...s.down);
  return { up, down };
}

/** Name the facets that differ, so the advisory says WHAT changed rather than merely that it did. */
function describeCaggDelta(current: CaggFacets, desired: CaggFacets): string {
  const parts: string[] = [];
  if (current.bucketWidth !== desired.bucketWidth) {
    parts.push(
      `bucket width ${current.bucketWidth} in the database vs ${desired.bucketWidth} declared`,
    );
  }
  if (current.timeColumn !== desired.timeColumn) {
    parts.push(`time column "${current.timeColumn}" vs "${desired.timeColumn}"`);
  }
  // Renaming an output column is drift — the view's public shape changed — so the message has to be
  // able to say so, or a renamed bucket falls through to the useless "the facets differ".
  if ((current.bucketAlias ?? undefined) !== (desired.bucketAlias ?? undefined)) {
    parts.push(
      `bucket column "${current.bucketAlias ?? '(unnamed)'}" vs "${desired.bucketAlias ?? '(unnamed)'}"`,
    );
  }
  // Mirrors caggFacetsEqual's asymmetric source rule exactly. Comparing the qualified form
  // unconditionally would make this message assert a source difference for a relation that
  // caggFacetsEqual considers the same — a message contradicting its own verdict — whenever some
  // OTHER facet is what actually moved.
  const sourceDiffers =
    current.sourceSchemaExplicit && desired.sourceSchemaExplicit
      ? current.source !== desired.source
      : current.sourceName !== desired.sourceName;
  if (sourceDiffers) {
    parts.push(`source ${current.source} vs ${desired.source}`);
  }
  // `groupBy` is an array of {column, as} objects. `.join()` on it yields "[object Object]" for
  // every element — identical on both sides — so this silently reported NO group-key difference for
  // any change, and TypeScript permits `.join()` on object arrays so nothing failed to compile.
  const keys = (f: CaggFacets): string =>
    f.groupBy.map((g) => (g.as === undefined ? g.column : `${g.column} AS ${g.as}`)).join(', ');
  if (keys(current) !== keys(desired)) {
    parts.push(`group keys [${keys(current)}] vs [${keys(desired)}]`);
  }
  const agg = (f: CaggFacets): string =>
    f.aggregates.map((a) => `${a.fn}(${a.column ?? '*'}) AS ${a.as}`).join(', ');
  if (agg(current) !== agg(desired)) {
    parts.push(`aggregates [${agg(current)}] vs [${agg(desired)}]`);
  }
  return parts.length > 0 ? parts.join('; ') : 'the facets differ';
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

/** Do two same-kind compression/retention policies match? Compares `after` + `createdBefore` via the
 * M4.0 normalizers, plus `scheduleInterval` — but the schedule ONLY when the desired side declares
 * one. The engine fills a default cadence that the introspected current always carries, so comparing
 * it unconditionally would be permanent false drift (the S1 characterization contract); ignoring it
 * entirely would silently miss a deliberately-changed schedule once the decorator surface can
 * express one. Argument order is therefore significant: (current, desired). */
function policyThresholdEqual(current: PolicyState, desired: PolicyState): boolean {
  if (current.kind !== desired.kind) return false;
  if (
    (current.kind === 'compression' || current.kind === 'retention') &&
    (desired.kind === 'compression' || desired.kind === 'retention')
  ) {
    // `scheduleInterval` is compared ONLY when the desired side actually declares one. The
    // introspected current always carries the engine-filled default, so comparing unconditionally
    // would be permanent false drift; ignoring it entirely would silently miss a deliberately
    // changed cadence the day the decorator surface can express it. Directional check, so argument
    // order matters here (current, desired).
    const scheduleEqual =
      desired.scheduleInterval === undefined ||
      intervalsEqual(current.scheduleInterval, desired.scheduleInterval);
    return (
      intervalsEqual(current.after, desired.after) &&
      intervalsEqual(current.createdBefore, desired.createdBefore) &&
      scheduleEqual
    );
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

/**
 * The columnstore `orderby` TimescaleDB will actually store for a declared `orderBy`. The engine
 * always appends the time dimension (DESC, NULLS FIRST) when the declared list omits it — verified on
 * 2.18-pg16 and latest-pg17 — so the desired side must carry that implied element before being
 * compared with an introspected one. Returns the list unchanged when the time column is already
 * declared (in any position/direction, which the engine then respects), when nothing is declared
 * (the "accept the engine default" contract handled by the caller), or when the time column is
 * unknown.
 */
function withImpliedTimeOrderBy(
  declared: readonly OrderByElement[],
  timeColumn: string | undefined,
): readonly OrderByElement[] {
  if (declared.length === 0 || timeColumn === undefined) return declared;
  if (declared.some((o) => o.column === timeColumn)) return declared;
  return [...declared, { column: timeColumn, desc: true, nullsFirst: true }];
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

  // ── Rename PRE-PASS ────────────────────────────────────────────────────────────────────────
  // Resolve every declared rename BEFORE diffing any entry, by re-keying the current entry from its
  // old name to its new one and emitting the rename first. Doing this per-entry inside the loop
  // (i.e. only when a direct name match failed) is wrong whenever a rename FREES a name that another
  // desired hypertable reuses: iteration order decides the outcome, the reused name matches the
  // about-to-be-renamed current entry, and its ops are emitted against the pre-rename table while the
  // genuinely-new hypertable is never created — a silent wrong schema that still "succeeds" on the DB.
  // Re-keying up front makes every later lookup see post-rename identity regardless of iteration order.
  // Snapshot the pre-rename table set: the map is mutated below, so ambiguity ("two desired tables
  // both claim the same source") must be judged against the ORIGINAL names, not the mutated map.
  const currentTablesBeforeRenames = new Set(currentByTable.keys());
  for (const d of desired.hypertables) {
    const oldTable = renames.get(d.table);
    if (oldTable === undefined) continue;
    // A stale `renamedFrom` pointing at a table that no longer exists (the rename already ran) is a
    // no-op, not a spurious rename.
    if (!currentTablesBeforeRenames.has(oldTable)) continue;
    const claimedBy = renamedFromTable.get(oldTable);
    if (claimedBy !== undefined) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `ambiguous rename: both ${claimedBy} and ${d.table} declare renamedFrom(${oldTable})`,
        { oldTable, desired: [claimedBy, d.table] },
      );
    }
    renamedFromTable.set(oldTable, d.table);
    // The target name is already occupied in the live DB — e.g. a mutual A↔B swap. A bare
    // `ALTER TABLE ... RENAME` cannot express that without a temporary name, and quietly converging
    // each table per-facet instead would leave the DATA unswapped while reporting success. Refuse.
    if (currentByTable.has(d.table)) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `cannot rename ${oldTable} → ${d.table}: ${d.table} already exists in the database ` +
          `(a mutual swap needs an intermediate name). Perform the rename in a hand-written ` +
          `migration, or drop the stale renamedFrom declaration.`,
        { oldTable, table: d.table },
      );
    }
    operations.push({ kind: 'renameHypertable', from: oldTable, to: d.table });
    currentByTable.set(d.table, currentByTable.get(oldTable)!);
    // Free the old key: the physical table no longer exists under that name after the rename, so a
    // desired hypertable REUSING the freed name correctly diffs as a create instead of matching the
    // entry that was just renamed away.
    currentByTable.delete(oldTable);
  }

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

    // Renames were already resolved (and their `renameHypertable` steps emitted) by the pre-pass
    // above, which re-keyed the current entry to its new name — so a plain lookup is now correct and
    // order-independent.
    const c = currentByTable.get(d.table);

    if (c === undefined) {
      // Whole hypertable missing (and no rename resolves it) → emit the full create sequence.
      operations.push(...createHypertableOperations(d));
      continue;
    }
    // Existing table (possibly just renamed by the pre-pass). Time-dimension chunk interval change →
    // set_chunk_time_interval. Reconcile the engine default: when desired omits chunkInterval it means
    // "the create-time default", which introspect() reads back as the concrete
    // TIMESCALE_DEFAULTS.chunkInterval — so compare against that, not undefined, to avoid false drift on
    // a bare hypertable (the S1 characterization contract).
    const currentTime = findDimension(c, 'time');
    const desiredTime = findDimension(d, 'time');
    // An INTEGER-time hypertable reads back a numeric chunk interval, which the decorator surface
    // cannot express (`chunkInterval` is interval-validated). When desired declares nothing, that
    // means "accept whatever the engine chose" — so skip the comparison entirely rather than
    // measuring a number against the interval-time default and then throwing on the unrepresentable
    // value, which would abort the whole run for every other entity too.
    // The time dimension's COLUMN must be compared before its interval, and a mismatch must refuse
    // rather than fall through. Previously only `chunkInterval` was compared, so moving
    // `@TimeColumn()` from one column to another produced an EMPTY plan with no advisory: `check`
    // exited clean and CI went green while the hypertable was still range-partitioned on the old
    // column. Everything downstream then reasons about the wrong column — chunk exclusion, the
    // implied columnstore `orderby` (which resolves against the DESIRED time column, i.e. one the
    // database does not partition on), and every CAGG bucket built over it.
    //
    // Refusing matches the space-dimension precedent below: re-partitioning an existing hypertable
    // is not expressible as an ALTER, so the honest answer is to stop and say so. A silent empty
    // plan is the one outcome a drift gate must never produce.
    if (
      currentTime !== undefined &&
      desiredTime !== undefined &&
      currentTime.column !== desiredTime.column
    ) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `hypertable ${d.table}: the time dimension is "${currentTime.column}" in the database but ` +
          `"${desiredTime.column}" is declared. Changing a hypertable's time dimension is not ` +
          `expressible as an alteration — it requires recreating the hypertable and moving the data. ` +
          `Align the decorator with the database, or perform the move with a hand-written migration.`,
        { table: d.table },
      );
    }

    // Fail closed rather than skip: an existing hypertable whose desired state declares no time
    // dimension at all cannot be compared, and silently comparing nothing is how a false-clean
    // happens. `compileDesiredState` always emits one for an `@Hypertable`, so in practice this
    // only fires for a hand-built IR passed straight to `diffSchemaState`.
    if (currentTime !== undefined && desiredTime === undefined) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `hypertable ${d.table}: the database is partitioned on time column "${currentTime.column}" ` +
          `but the desired state declares no time dimension, so the two cannot be compared. Declare ` +
          `the time dimension to proceed.`,
        { table: d.table },
      );
    }

    // An UNDECLARED chunkInterval means "unmanaged", not "7 days".
    //
    // It used to fall back to TIMESCALE_DEFAULTS.chunkInterval, so a hypertable at a DBA-tuned or
    // create_hypertable-inherited 30 days, described by a decorator that says nothing about chunk
    // sizing, produced `setChunkInterval 30 days -> 7 days`. No data is lost (it affects future
    // chunks only) but the sizing silently regressed and the plan looked deliberate.
    //
    // Every other unset value in this file already means unmanaged: an empty segmentBy/orderBy
    // accepts the engine default, and an undeclared scheduleInterval is not compared at all.
    // chunkInterval was the lone exception; now it is not. Declaring an interval still converges it.
    // Undeclared subsumes the former integer-time special case: that existed only because an
    // integer current interval could not be compared against the string default we used to
    // substitute. With no substitution there is nothing to compare either way.
    const skipChunkCompare = desiredTime?.chunkInterval === undefined;
    if (currentTime !== undefined && desiredTime !== undefined && !skipChunkCompare) {
      const desiredInterval = desiredTime.chunkInterval;
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
      // TimescaleDB AUTO-APPENDS the time column (DESC) to `compress_orderby` whenever the declared
      // orderby omits it — so a decorator declaring `orderBy: [region ASC]` reads back as
      // `[region ASC, ts DESC]`. Comparing raw would report drift on an unchanged schema AND propose a
      // `needs-recompress` alter whose own SQL the engine re-expands identically, so it could never
      // converge. Reconcile by appending the engine-implied element to desired before comparing.
      const desiredOrderBy = withImpliedTimeOrderBy(des.orderBy, desiredTime?.column);
      const ordChanged = des.orderBy.length > 0 && !orderByEqual(desiredOrderBy, cur.orderBy);
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
      // Dropping a compression policy present in current but not desired is a guarded drop —
      // emitted below only when `allowDrops` is enabled.
    }

    // Space (hash) dimensions cannot be reconciled in-place: `add_dimension` is a one-way operation
    // with its own preconditions, and neither dropping nor re-partitioning an existing space
    // dimension is expressible. Rather than silently report "no drift" for a declared partitioning
    // the database does not have — which would let a schema diverge invisibly — surface the
    // divergence loudly with the exact remedy. Matching declarations are of course a no-op.
    const currentSpace = findDimension(c, 'space');
    const desiredSpace = findDimension(d, 'space');
    const spaceEqual =
      currentSpace === undefined
        ? desiredSpace === undefined
        : desiredSpace !== undefined &&
          currentSpace.column === desiredSpace.column &&
          currentSpace.numPartitions === desiredSpace.numPartitions;
    if (!spaceEqual) {
      const describe = (dim: DimensionState | undefined): string =>
        dim === undefined ? 'none' : `${dim.column} (${String(dim.numPartitions)} partitions)`;
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `hypertable ${d.table}: space-partition drift is not auto-reconcilable — declared ` +
          `${describe(desiredSpace)}, database has ${describe(currentSpace)}. Adding, removing, or ` +
          `re-partitioning a space dimension on an existing hypertable needs a hand-written ` +
          `migration (add_dimension / recreate); align the decorator with the database to proceed.`,
        { table: d.table },
      );
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
      // Removing the POLICY is independently safe and reversible, so emit it whenever current has
      // one and desired does not — including when desired abandons the columnstore entirely. (The
      // columnstore itself is never dropped; previously this case emitted nothing, leaving a
      // stranded policy and a plan that could never converge.)
      if (
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

  // ── Continuous aggregates — ADDITIVE ONLY ──────────────────────────────────────────────────
  const advisories = diffContinuousAggregates(
    current,
    desired,
    operations,
    options.continuousAggregateRecreate ?? 'advise',
  );

  return {
    steps: operations.map((operation) => ({ operation, ...classifyOperation(operation) })),
    ...(advisories.length > 0 && { advisories }),
  };
}

/**
 * The CAGG pass: create a desired CAGG the database lacks, and attach a declared refresh policy the
 * database lacks. **Nothing else.** Appends its operations to `operations` (after every hypertable
 * op, since a CAGG reads from one) and returns any advisories.
 *
 * Deliberately NOT done, and why:
 *
 * - **Never drop.** A CAGG in the database but absent from code is left alone, even under
 *   `allowDrops`. Its materialized rows may be the ONLY surviving copy of data whose source chunks
 *   retention has already dropped — that is the whole point of a rollup. `allowDrops` is documented
 *   as covering only reversible policy removals; a CAGG drop is neither reversible nor a policy.
 *
 * - **Never recreate, and never compare structure.** `introspect()` reports `view_definition`, which
 *   is a parse-tree DEPARSE, not the text that created the view: `INTERVAL '1 hour'` comes back as
 *   `'01:00:00'::interval`, identifiers lose their quoting and schema qualifier, `GROUP BY` gains
 *   parentheses. An unchanged CAGG therefore does not textually match the definition we would emit,
 *   so a text diff would report PERMANENT false drift on every CAGG and `push --apply` would
 *   recreate — destroying materialized data — on a schema that never changed. Presence is the only
 *   honest comparison until the IR carries parsed facets (bucket width, group keys, aggregates).
 *   Each existing CAGG gets a `not-compared` advisory so this is visible rather than implied.
 *
 * - **A CHANGED refresh threshold is reported, not emitted.** Converging it needs a remove-then-add
 *   `alterContinuousAggregatePolicy` operation that does not exist yet. Emitting nothing AND saying
 *   nothing would report a diverged schema as converged, so it raises a `not-expressible` advisory.
 */
function diffContinuousAggregates(
  current: SchemaStateIR,
  desired: SchemaStateIR,
  operations: Operation[],
  recreate: 'advise' | 'plan' | 'apply',
): PlanAdvisory[] {
  const advisories: PlanAdvisory[] = [];

  const currentByView = new Map(current.continuousAggregates.map((c) => [c.viewName, c]));
  // Views that will EXIST once this plan has run: already in the database, plus the ones created
  // earlier in this same pass.
  const availableViews = new Set(currentByView.keys());

  for (const d of desired.continuousAggregates) {
    const c = currentByView.get(d.viewName);
    // `ContinuousAggregateState.refresh` is the general PolicyState union; only the refresh kind is
    // meaningful here. A desired side carrying anything else is a malformed hand-built IR — treat it
    // as "no refresh declared" rather than emitting a policy op from a compression threshold.
    const desiredRefresh: RefreshPolicy | undefined =
      d.refresh?.kind === 'refresh' ? d.refresh : undefined;

    if (c === undefined) {
      // A hierarchical CAGG must be created AFTER the view it reads from. The desired list arrives
      // topologically ordered (the compiler's own pass), so this only fires on a hand-built IR — but
      // emitting the create anyway would produce a plan whose SQL fails halfway through, leaving the
      // schema partly converged. Refuse to build such a plan.
      if (d.hierarchical && !availableViews.has(d.source)) {
        // NOT gated on the parent being in the desired list. Gating on that missed the commoner
        // mistake by far: declaring only the child (`continuousAggregates: [DailyRollup]`) and
        // forgetting its parent. The parent then appears in NEITHER the database nor the plan, the
        // create is emitted anyway, and apply dies on "relation hourly_rollup does not exist" with
        // the schema half-migrated. Refuse whenever the source will not exist by this point,
        // whatever the reason.
        throw new TimescaleError(
          TimescaleErrorCode.INVALID_ARGUMENT,
          `continuous aggregate ${d.viewName} reads from ${d.source}, which is neither in the ` +
            `database nor created earlier in this plan — declare ${d.source} too, or order the ` +
            `desired continuous aggregates so it comes first`,
          { view: d.viewName, source: d.source },
        );
      }
      operations.push({
        kind: 'createContinuousAggregateRaw',
        view: d.viewName,
        definition: d.definition,
        materializedOnly: d.materializedOnly,
        // This aggregate is ABSENT from the database — we are creating it, not reproducing an
        // existing one. Without saying so it inherited `pull`'s semantics: down() refused to drop
        // it (stranding an empty view on revert) and the plan preview told the user it was
        // "reproducing an EXISTING continuous aggregate" while creating a new one.
        intent: 'create',
      });
      availableViews.add(d.viewName);
      if (desiredRefresh !== undefined) {
        operations.push(refreshPolicyOperation(d.viewName, desiredRefresh));
      }
      continue;
    }

    // The CAGG already exists. Try to compare its DEFINITION structurally; fall back to the honest
    // "not compared" only when a side cannot be parsed.
    //
    // Comparing the deparsed text directly is not an option — measured on PG17/TSDB 2.29.1, the
    // server returns an unchanged aggregate with the interval reformatted, quoting stripped, the
    // layout reindented and `GROUP BY 1, 2` EXPANDED into full expressions. `extractCaggFacets`
    // exists because normalising that last one requires parsing the SELECT anyway.
    const currentFacets = extractCaggFacets(c.definition);
    const desiredFacets = extractCaggFacets(d.definition);

    if (currentFacets === undefined || desiredFacets === undefined) {
      // A shape the parser does not read. Exactly as informative as before — never a guess.
      advisories.push({
        kind: 'not-compared',
        object: d.viewName,
        detail:
          'exists in the database, but its definition could not be parsed into comparable facets, ' +
          'so its definition (bucket width, group keys, aggregates) is NOT compared. Verify ' +
          'changes to this aggregate by hand.',
      });
    } else if (!caggFacetsEqual(currentFacets, desiredFacets)) {
      const delta = describeCaggDelta(currentFacets, desiredFacets);

      if (recreate !== 'advise') {
        // OPTED IN: emit a real step, so `check` and `generate` show what convergence takes instead
        // of only asserting that it is needed. Classified `refuse-by-default`
        // (`classifyOperation`), so nothing applies it by accident — and in `'plan'` mode
        // `pushSchema` holds it back entirely while still applying the rest of the plan.
        //
        // The DESIRED definition is what gets recreated: the declaration is the intended state, and
        // the whole point of converging is to make the database match it.
        operations.push({
          kind: 'recreateContinuousAggregate',
          view: d.viewName,
          definition: d.definition,
          ...(d.materializedOnly !== undefined && { materializedOnly: d.materializedOnly }),
          delta,
        });
        continue;
      }

      // `not-expressible`, deliberately: this IS drift, and it BLOCKS `check` (commands.ts filters
      // this kind as blocking). Reporting it as `not-compared` would be a false statement — we did
      // compare, and we found a difference — and a gate that under-reports what it knows is the
      // exact failure this engine exists to remove.
      //
      // It is not a plan step: TimescaleDB cannot ALTER a continuous aggregate's SELECT, so
      // converging means drop-and-recreate, discarding materialized rows that may be the only
      // surviving copy of data whose source chunks retention has already dropped. That belongs
      // behind an explicit opt-in, not in an automatic plan.
      advisories.push({
        kind: 'not-expressible',
        object: d.viewName,
        detail:
          `its definition differs from the declaration — ${describeCaggDelta(currentFacets, desiredFacets)}. ` +
          "Altering a continuous aggregate's SELECT is not expressible: converging it means " +
          'DROP + CREATE, which discards the materialized rows. Recreate it deliberately, or align ' +
          'the decorator with the database.',
      });
    }

    // `materialized_only` is a real, comparable facet — it is a boolean the catalog reports
    // directly, not part of the deparsed definition. The plan for this slice said such changes are
    // to be REPORTED, not emitted (flipping it needs an ALTER this engine does not have). Reporting
    // was the half that went missing: it was compiled into the desired IR and read by introspect(),
    // then never inspected. The blanket not-compared note does not cover it either — that text
    // names "bucket width, group keys, aggregates".
    if (c.materializedOnly !== d.materializedOnly) {
      advisories.push({
        kind: 'not-expressible',
        object: d.viewName,
        detail:
          `materialized_only is ${String(c.materializedOnly)} in the database but ${String(d.materializedOnly)} in the ` +
          `declaration. Changing it is not yet supported — run ` +
          `ALTER MATERIALIZED VIEW ... SET (timescaledb.materialized_only = ${String(d.materializedOnly)}) by hand, ` +
          `or align the decorator with the database.`,
      });
    }

    if (desiredRefresh === undefined) continue;

    if (c.refresh === undefined) {
      // Additive: the aggregate exists but carries no refresh job — attach the declared one.
      operations.push(refreshPolicyOperation(d.viewName, desiredRefresh));
    } else if (c.refresh.kind !== 'refresh') {
      advisories.push({
        kind: 'not-expressible',
        object: d.viewName,
        detail:
          `a refresh policy is declared, but the database has a ${c.refresh.kind} job attached to ` +
          `this aggregate. Reconcile it by hand — this engine will not replace a job it did not create.`,
      });
    } else if (!refreshPolicyEqual(c.refresh, desiredRefresh)) {
      advisories.push({
        kind: 'not-expressible',
        object: d.viewName,
        detail:
          'its refresh policy differs from the declared one, but altering a refresh policy is not ' +
          'yet supported. Adjust it by hand (remove_continuous_aggregate_policy + ' +
          'add_continuous_aggregate_policy), or align the decorator with the database.',
      });
    }
  }

  // Every aggregate that exists in the database but is NOT declared, whatever else was declared.
  //
  // This sweep used to live behind an early return taken only when the desired list was COMPLETELY
  // empty, so declaring a single aggregate silenced it for all the others. That is the configuration
  // nearly every real project is in — some aggregates declared, not zero — and the result was the
  // exact false-green this pass exists to close: declare `[HourlyRollup]` while `daily_rollup` also
  // lives in the database and `check` printed "No drift detected" and exited 0 without ever naming
  // it. `pushSchema`'s own guard did not help; it keys on the list being `undefined`, and declaring
  // some aggregates makes it defined.
  //
  // Whether the caller genuinely declares only a subset or simply forgot one, the diff cannot tell
  // and does not need to: naming a live aggregate that nothing manages is correct either way.
  const declaredViews = new Set(desired.continuousAggregates.map((d) => d.viewName));
  for (const c of current.continuousAggregates) {
    if (declaredViews.has(c.viewName)) continue;
    advisories.push({
      kind: 'not-compared',
      object: c.viewName,
      detail:
        'exists in the database but is not declared, so it is NOT managed or compared. If you ' +
        'do declare it, pass it via `continuousAggregates` — aggregates cannot be discovered ' +
        'from a DataSource. It will never be dropped.',
    });
  }

  return advisories;
}

/** Build the `addContinuousAggregatePolicy` op for a declared refresh policy. An omitted offset is
 * OPEN (`null`) — refresh from the beginning of time / up to now — which is what the builder's
 * `string | null` expresses. A non-string offset is an integer-time threshold the string-only
 * builder cannot emit, so it throws rather than converge wrongly. */
function refreshPolicyOperation(view: string, refresh: RefreshPolicy): Operation {
  const offset = (value: IntervalOrInt | undefined, what: string): string | null => {
    // `== null` on purpose: catches both `undefined` and an explicit `null`. The IR type forbids
    // null, but null is the OPEN-bound sentinel everywhere else in this codebase (the builder's own
    // `startOffset: string | null`), so a hand-built IR using it must mean "open", not "throw".
    if (value == null) return null;
    if (typeof value !== 'string') {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `continuous aggregate ${view}: integer-time refresh ${what} (${String(value)}) is not expressible by the migration builder`,
        { view },
      );
    }
    return value;
  };
  // schedule_interval is REQUIRED: TimescaleDB 2.18 (this package's floor) has no
  // add_continuous_aggregate_policy overload without it. The desired-state compiler always supplies
  // one (defaulting to the bucket width), so an absent value means a hand-built IR — refuse rather
  // than emit SQL that fails at migration time with "function ... does not exist".
  if (refresh.scheduleInterval === undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `continuous aggregate ${view}: a refresh policy needs a schedule interval — TimescaleDB 2.18 has no add_continuous_aggregate_policy overload without one`,
      { view },
    );
  }
  return {
    kind: 'addContinuousAggregatePolicy',
    view,
    startOffset: offset(refresh.startOffset, 'start offset'),
    endOffset: offset(refresh.endOffset, 'end offset'),
    scheduleInterval: stringThreshold(refresh.scheduleInterval, view, 'refresh schedule interval'),
  };
}

/** Do two refresh policies match? Offsets compare via the M4.0 interval normalizer (so `'1 mon'`
 * from the catalog equals a declared `'1 month'`). `scheduleInterval` is compared only when the
 * desired side declares one — the engine fills a default the introspected side always carries, so
 * comparing it unconditionally would be permanent false drift (the same rule the hypertable policy
 * comparison follows). */
function refreshPolicyEqual(current: RefreshPolicy, desired: RefreshPolicy): boolean {
  if (!intervalsEqual(current.startOffset, desired.startOffset)) return false;
  if (!intervalsEqual(current.endOffset, desired.endOffset)) return false;
  if (
    desired.scheduleInterval !== undefined &&
    !intervalsEqual(current.scheduleInterval, desired.scheduleInterval)
  ) {
    return false;
  }
  return true;
}

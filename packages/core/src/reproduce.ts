import type {
  ContinuousAggregateState,
  DimensionState,
  HypertableState,
  IntervalOrInt,
  SchemaStateIR,
} from './schema-state.js';
import type { Operation } from './operation.js';
import {
  classifyDefinitionBody,
  normalizeCaggDefinitionBody,
  DEFINITION_REJECTION,
} from './sql/continuous-aggregate.js';

/**
 * **Reproduce** a `SchemaStateIR` as an ordered `Operation[]` — the engine half of the `pull`
 * verb (M4.4b): point the tool at a database nobody modelled in code and get back the operations
 * that would recreate its TimescaleDB layer.
 *
 * ## Why this is not `diffSchemaState(EMPTY, ir)`
 *
 * Diffing a live IR against an empty "current" *does* produce an all-creates plan, and it was the
 * first thing tried. It is wrong for `pull` in two ways that both fail silently or loudly at the
 * worst moment:
 *
 *  1. **`diffSchemaState` is hypertable-scoped and ignores `continuousAggregates` entirely** (by
 *     design — `compileDesiredState()` cannot compile CAGGs, so a diff that acted on them would
 *     propose dropping every live CAGG). Routing `pull` through the diff would therefore discard
 *     every continuous aggregate in the database *without saying so* — the exact class of silent
 *     omission this module's {@link ReproduceResult.skipped} exists to prevent.
 *  2. **The diff THROWS on inexpressible input** (integer-time chunk intervals and policy
 *     thresholds, `created_before` policy variants, incomplete space dimensions). That is correct
 *     for a diff, where silently under-converging would report a diverged schema as converged. It
 *     is wrong for `pull`, where an integer-time hypertable in a brownfield database must be
 *     *reported* to the operator, not turned into a crash that yields nothing at all.
 *
 * So this function walks the IR itself and is **total**: it never throws on a shape it cannot
 * express. Anything it cannot reproduce is recorded in `skipped`, and the caller is expected to
 * surface that (the CLI exits non-zero on a non-empty `skipped`). A reproduce step that silently
 * dropped an object would be worse than useless — it would look like a faithful copy.
 *
 * ## What is out of scope, always
 *
 * Base relational DDL — tables, columns, types, indexes, constraints, triggers, functions,
 * extensions — is **not** modelled by `SchemaStateIR` and is not emitted here. That is the
 * library's boundary, not a gap in this function: a reproduced migration assumes the underlying
 * tables already exist (or are created by TypeORM's own `migration:generate`). Callers must say so
 * to the user; see the standing caveat in the `pull` command's coverage report.
 */

/** Why one object (or one facet of one object) could not be reproduced. */
export type SkipReason =
  /** Chunk interval is an integer (integer-time hypertable); the builders emit `INTERVAL '…'`. */
  | 'integer-chunk-interval'
  /** A policy threshold is an integer rather than an interval string. */
  | 'integer-threshold'
  /** Policy uses the `compress_created_before`/`drop_created_before` variant. */
  | 'created-before-threshold'
  /** A custom `add_job` whose config this engine does not interpret. */
  | 'unmanaged-policy'
  /**
   * A compression/retention policy attached to a CONTINUOUS AGGREGATE rather than to a user
   * hypertable. `introspect()` keys those policies by the hypertable they name and reads them only
   * while mapping user hypertables, so they never reach the IR — which means `stateToOperations`
   * cannot see them either, and a reproduction that omits them would otherwise report itself
   * complete. Detected separately by `pullSchema` and recorded here so coverage stays honest.
   */
  | 'cagg-attached-policy'
  /**
   * An identifier PostgreSQL accepts but these builders will not emit. The allow-list is ASCII-only
   * (`/^[A-Za-z_][A-Za-z0-9_$]*$/`) while PostgreSQL permits non-ASCII letters unquoted under UTF-8,
   * and anything at all when quoted. Reproducing such an object would mean emitting an identifier the
   * safety layer exists to refuse, so it is reported instead — which keeps `pull` TOTAL rather than
   * aborting the whole run over one table it cannot name.
   */
  | 'identifier-not-expressible'
  /** A space dimension that `create_hypertable`/`add_dimension` cannot reproduce as given. */
  | 'space-dimension-incomplete'
  /** The hypertable has no time dimension — nothing to create it from. */
  | 'no-time-dimension'
  /** A continuous aggregate whose refresh policy offsets are not interval strings. */
  | 'refresh-offset-not-expressible'
  /** A continuous aggregate's definition is empty or not a single statement. */
  | 'cagg-definition-unusable'
  /** Hierarchical CAGGs form a cycle, so no valid creation order exists. */
  | 'cagg-dependency-cycle'
  /**
   * A hierarchical CAGG whose parent CAGG was itself not reproduced. Emitting it anyway would
   * produce a migration that FAILS on apply, referencing a view this migration never creates — the
   * one case where a skip elsewhere would otherwise corrupt an emitted operation rather than merely
   * omit one.
   */
  | 'cagg-parent-not-reproduced'
  /** A policy whose `kind` does not match the field it was found on (hand-built IR / future producer). */
  | 'policy-kind-mismatch';

/** Which part of the schema a skip refers to, so a report can group by object. */
export type SkippedFacet =
  | 'hypertable'
  | 'chunkInterval'
  | 'spaceDimension'
  | 'columnstore'
  | 'compressionPolicy'
  | 'retentionPolicy'
  | 'continuousAggregate'
  | 'refreshPolicy';

/** One thing `stateToOperations` saw in the IR but could not turn into an operation. */
export interface SkippedObject {
  /** Schema-qualified table or view name the skip belongs to. */
  readonly object: string;
  readonly facet: SkippedFacet;
  readonly reason: SkipReason;
  /** Operator-facing explanation, naming the offending value where there is one. */
  readonly detail: string;
}

export interface ReproduceResult {
  /** Operations in dependency order — hypertables first, then CAGGs after their sources. */
  readonly operations: readonly Operation[];
  /** Everything that could not be reproduced. Empty means a complete reproduction. */
  readonly skipped: readonly SkippedObject[];
}

function findDimension(
  h: HypertableState,
  kind: DimensionState['kind'],
): DimensionState | undefined {
  return h.dimensions.find((d) => d.kind === kind);
}

/** An interval usable by the string-only builders, or `undefined` if it is not expressible. */
function asIntervalString(value: IntervalOrInt | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reproduce one hypertable. Emits as much as is expressible and reports the rest, rather than
 * abandoning the whole table because one facet (say, an integer chunk interval) cannot be
 * rendered — a partial hypertable plus a named skip is far more useful to someone adopting a
 * brownfield database than nothing at all.
 */
function reproduceHypertable(h: HypertableState, skipped: SkippedObject[]): Operation[] {
  const time = findDimension(h, 'time');
  if (time === undefined) {
    skipped.push({
      object: h.table,
      facet: 'hypertable',
      reason: 'no-time-dimension',
      detail: `hypertable ${h.table} reports no time dimension, so create_hypertable cannot be reproduced`,
    });
    return [];
  }

  // An integer chunk interval belongs to an integer-time hypertable. Emit the create WITHOUT an
  // interval (the DB applies its default) and report the loss, so the operator can set it by hand.
  const chunkInterval = asIntervalString(time.chunkInterval);
  if (time.chunkInterval !== undefined && chunkInterval === undefined) {
    skipped.push({
      object: h.table,
      facet: 'chunkInterval',
      reason: 'integer-chunk-interval',
      detail: `chunk interval ${String(time.chunkInterval)} is an integer (integer-time hypertable); the reproduced create_hypertable omits it and the database default applies`,
    });
  }

  const spaceDims = h.dimensions.filter((d) => d.kind === 'space');
  const space = spaceDims[0];
  let spacePartition: { readonly column: string; readonly partitions: number } | undefined;
  if (space !== undefined) {
    if (space.numPartitions === undefined) {
      skipped.push({
        object: h.table,
        facet: 'spaceDimension',
        reason: 'space-dimension-incomplete',
        detail: `space dimension "${space.column}" reports no partition count, so add_dimension cannot be reproduced`,
      });
    } else {
      spacePartition = { column: space.column, partitions: space.numPartitions };
    }
  }
  // `createHypertable` carries at most ONE space dimension (matching the diff engine's own limit),
  // so any further ones would be dropped. Report each rather than losing it silently — this is a
  // case where the reproduction is genuinely narrower than the source.
  for (const extra of spaceDims.slice(1)) {
    skipped.push({
      object: h.table,
      facet: 'spaceDimension',
      reason: 'space-dimension-incomplete',
      detail: `additional space dimension "${extra.column}" cannot be reproduced — the builder emits a single space partition`,
    });
  }

  const ops: Operation[] = [
    {
      kind: 'createHypertable',
      table: h.table,
      timeColumn: time.column,
      ...(chunkInterval !== undefined && { chunkInterval }),
      ...(spacePartition !== undefined && { spacePartition }),
    },
  ];

  // ── columnstore (+ its compression threshold, which the columnstore op folds in) ────────────
  if (h.columnstore !== undefined) {
    const cp = h.compressionPolicy;
    let after: string | undefined;
    if (cp !== undefined) {
      if (cp.kind === 'unmanaged') {
        skipped.push({
          object: h.table,
          facet: 'compressionPolicy',
          reason: 'unmanaged-policy',
          detail: `compression job runs "${cp.procName}", a custom add_job this engine does not interpret — recreate it by hand`,
        });
      } else if (cp.kind === 'compression') {
        after = asIntervalString(cp.after);
        if (after === undefined) {
          // Distinguish the two inexpressible shapes: an integer threshold vs the
          // created_before variant (which leaves `after` undefined entirely).
          const isCreatedBefore = cp.after === undefined && cp.createdBefore !== undefined;
          skipped.push({
            object: h.table,
            facet: 'compressionPolicy',
            reason: isCreatedBefore ? 'created-before-threshold' : 'integer-threshold',
            detail: isCreatedBefore
              ? `compression policy uses compress_created_before (${String(cp.createdBefore)}), which the interval-based builder cannot express — the columnstore is still enabled, but its policy is not reproduced`
              : `compression threshold ${String(cp.after)} is an integer, which the interval-based builder cannot express — the columnstore is still enabled, but its policy is not reproduced`,
          });
        }
      } else {
        // See the matching note on the retention slot: the union permits a mis-kinded policy.
        skipped.push({
          object: h.table,
          facet: 'compressionPolicy',
          reason: 'policy-kind-mismatch',
          detail: `the compression slot holds a "${cp.kind}" policy, which cannot be reproduced as a compression policy`,
        });
      }
    }
    ops.push({
      kind: 'addColumnstorePolicy',
      table: h.table,
      ...(h.columnstore.segmentBy.length > 0 && { segmentBy: [...h.columnstore.segmentBy] }),
      ...(h.columnstore.orderBy.length > 0 && {
        orderBy: h.columnstore.orderBy.map((o) => ({
          column: o.column,
          direction: o.desc ? ('DESC' as const) : ('ASC' as const),
        })),
      }),
      ...(after !== undefined && { after }),
    });
  } else if (h.compressionPolicy !== undefined) {
    // A compression policy with no columnstore config to attach it to: the IR says a job exists
    // but there is nothing to enable. Report rather than emit a policy that would fail to apply.
    skipped.push({
      object: h.table,
      facet: 'compressionPolicy',
      reason: 'unmanaged-policy',
      detail: `a compression policy exists but the table reports no columnstore configuration, so it cannot be reproduced in isolation`,
    });
  }

  // ── retention ──────────────────────────────────────────────────────────────────────────────
  const rp = h.retentionPolicy;
  if (rp !== undefined) {
    if (rp.kind === 'unmanaged') {
      skipped.push({
        object: h.table,
        facet: 'retentionPolicy',
        reason: 'unmanaged-policy',
        detail: `retention job runs "${rp.procName}", a custom add_job this engine does not interpret — recreate it by hand`,
      });
    } else if (rp.kind === 'retention') {
      const dropAfter = asIntervalString(rp.after);
      if (dropAfter !== undefined) {
        ops.push({ kind: 'addRetentionPolicy', table: h.table, dropAfter });
      } else {
        const isCreatedBefore = rp.after === undefined && rp.createdBefore !== undefined;
        skipped.push({
          object: h.table,
          facet: 'retentionPolicy',
          reason: isCreatedBefore ? 'created-before-threshold' : 'integer-threshold',
          detail: isCreatedBefore
            ? `retention policy uses drop_created_before (${String(rp.createdBefore)}), which the interval-based builder cannot express`
            : `retention threshold ${String(rp.after)} is an integer, which the interval-based builder cannot express`,
        });
      }
    } else {
      // `PolicyState` is a union, so the type permits a policy whose `kind` disagrees with the
      // field it was found on. Unreachable via `introspect` (which keys off `proc_name`), but a
      // hand-built IR or a future producer could do it — report rather than drop it silently.
      skipped.push({
        object: h.table,
        facet: 'retentionPolicy',
        reason: 'policy-kind-mismatch',
        detail: `the retention slot holds a "${rp.kind}" policy, which cannot be reproduced as a retention policy`,
      });
    }
  }

  return ops;
}

/** Reproduce one CAGG plus (when expressible) its refresh policy. */
function reproduceCagg(c: ContinuousAggregateState, skipped: SkippedObject[]): Operation[] {
  // Classify with the SAME predicate the builder uses, so the two can never disagree: the builder
  // throws on a non-usable body and this function must stay total, so it reports instead.
  const definition = normalizeCaggDefinitionBody(c.definition);
  const verdict = classifyDefinitionBody(definition);
  if (verdict !== 'usable') {
    skipped.push({
      object: c.viewName,
      facet: 'continuousAggregate',
      reason: 'cagg-definition-unusable',
      detail: `continuous aggregate ${c.viewName}: ${DEFINITION_REJECTION[verdict]}`,
    });
    return [];
  }

  const ops: Operation[] = [
    {
      kind: 'createContinuousAggregateRaw',
      view: c.viewName,
      definition,
      materializedOnly: c.materializedOnly,
    },
  ];

  const refresh = c.refresh;
  if (refresh === undefined) return ops;

  if (refresh.kind === 'unmanaged') {
    skipped.push({
      object: c.viewName,
      facet: 'refreshPolicy',
      reason: 'unmanaged-policy',
      detail: `refresh job runs "${refresh.procName}", a custom add_job this engine does not interpret — recreate it by hand`,
    });
    return ops;
  }
  if (refresh.kind !== 'refresh') {
    skipped.push({
      object: c.viewName,
      facet: 'refreshPolicy',
      reason: 'policy-kind-mismatch',
      detail: `the refresh slot holds a "${refresh.kind}" policy, which cannot be reproduced as a refresh policy`,
    });
    return ops;
  }

  // `add_continuous_aggregate_policy` requires a schedule_interval on TSDB 2.18 (this package's
  // floor) and takes interval strings or NULL for the window bounds. An integer offset is an
  // integer-time CAGG, which the builder cannot express.
  const scheduleInterval = asIntervalString(refresh.scheduleInterval);
  // `null` is a legitimate OPEN bound (`start_offset => NULL` = refresh from the beginning of
  // time), which the builder already emits as NULL — so it must not be judged inexpressible.
  // `introspect` cannot currently produce it (normalize's `iv()` maps a non-string/number to
  // undefined), but `stateToOperations` is public and a hand-built IR can, so fail open, not shut.
  const isOpenBound = (v: unknown): boolean => v === null || v === undefined;
  const startBad = !isOpenBound(refresh.startOffset) && typeof refresh.startOffset !== 'string';
  const endBad = !isOpenBound(refresh.endOffset) && typeof refresh.endOffset !== 'string';
  if (scheduleInterval === undefined || startBad || endBad) {
    skipped.push({
      object: c.viewName,
      facet: 'refreshPolicy',
      reason:
        scheduleInterval === undefined && !startBad && !endBad
          ? 'refresh-offset-not-expressible'
          : 'integer-threshold',
      detail:
        scheduleInterval === undefined
          ? `refresh policy reports no interval schedule_interval, which add_continuous_aggregate_policy requires on TimescaleDB 2.18`
          : `refresh policy has an integer window offset (start=${String(refresh.startOffset)}, end=${String(refresh.endOffset)}), which the interval-based builder cannot express`,
    });
    return ops;
  }

  ops.push({
    kind: 'addContinuousAggregatePolicy',
    view: c.viewName,
    startOffset: asIntervalString(refresh.startOffset) ?? null,
    endOffset: asIntervalString(refresh.endOffset) ?? null,
    scheduleInterval,
  });
  return ops;
}

/**
 * Reduce a whole {@link SchemaStateIR} to the operations that recreate it, in an order that is
 * safe to execute top-to-bottom. Total: never throws — see the module doc.
 */
export function stateToOperations(ir: SchemaStateIR): ReproduceResult {
  const skipped: SkippedObject[] = [];
  const operations: Operation[] = [];

  for (const h of ir.hypertables) {
    operations.push(...reproduceHypertable(h, skipped));
  }

  // ── CAGG ordering ──────────────────────────────────────────────────────────────────────────
  // A hierarchical CAGG's source is ANOTHER CAGG's view, which must therefore already exist. Emit
  // in dependency order by repeatedly taking every remaining CAGG whose source is not itself still
  // pending. A pass that emits nothing while items remain means the sources form a cycle — which a
  // real database cannot contain, but a hand-built IR can, so it is reported instead of looping.
  // Which names in this IR are CAGGs (as opposed to source hypertables), and which ones actually
  // made it into `operations`. Being "ready" to emit is NOT the same as having been emitted: a
  // parent can be dropped by `reproduceCagg` (unusable definition), and emitting its child anyway
  // would produce a migration that fails on apply against a view this migration never creates.
  const caggViews = new Set(ir.continuousAggregates.map((c) => c.viewName));
  const emittedViews = new Set<string>();

  let pending = [...ir.continuousAggregates];
  while (pending.length > 0) {
    const pendingViews = new Set(pending.map((c) => c.viewName));
    const ready = pending.filter((c) => !pendingViews.has(c.source));
    if (ready.length === 0) {
      for (const c of pending) {
        skipped.push({
          object: c.viewName,
          facet: 'continuousAggregate',
          reason: 'cagg-dependency-cycle',
          detail: `continuous aggregate ${c.viewName} is part of a source cycle (source: ${c.source}), so no valid creation order exists`,
        });
      }
      break;
    }
    for (const c of ready) {
      if (caggViews.has(c.source) && !emittedViews.has(c.source)) {
        skipped.push({
          object: c.viewName,
          facet: 'continuousAggregate',
          reason: 'cagg-parent-not-reproduced',
          detail: `continuous aggregate ${c.viewName} reads from ${c.source}, which was itself not reproduced — emitting it would create a migration that fails on apply`,
        });
        continue;
      }
      const ops = reproduceCagg(c, skipped);
      if (ops.length > 0) {
        operations.push(...ops);
        emittedViews.add(c.viewName);
      }
    }
    const readyViews = new Set(ready.map((c) => c.viewName));
    pending = pending.filter((c) => !readyViews.has(c.viewName));
  }

  return { operations, skipped };
}

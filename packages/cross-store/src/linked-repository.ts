import {
  resolveEntities,
  assertEntitiesResolved,
  assertEntitiesUnchanged,
  lockValidatedFields,
  type EntityFieldVerdict,
} from './resolve-entities.js';
import { CrossStoreError, CrossStoreErrorCode } from './errors.js';
import type { ResolveOptions } from './engine.js';
import type { ReferenceRegistry } from './registry.js';

/**
 * The minimal write surface `createManyResolved` needs — deliberately structural so the package
 * never imports `typeorm`. A TypeORM `EntityManager` and `Repository` both satisfy it. Pass a
 * **transactional** manager (from `dataSource.transaction(mgr => …)`) so validate-then-write is
 * atomic on the local store.
 */
export interface EntityWriter {
  save<T extends object>(entities: T[]): Promise<T[]>;
}

/**
 * Validate every `@Resolve`d cross-store reference on `entities`, then persist them — the linked
 * repository's create path. Resolution runs first (`resolveEntities` + `assertEntitiesResolved`,
 * fail-closed: the first unresolved reference throws, tagged `ClassName.property`); only if ALL
 * references resolve are the entities written via `writer.save`.
 *
 * **TOCTOU (issue #124 fix #1/#2) — honestly framed.** This is validate-then-write, NOT a
 * two-phase commit across instances (impossible — the reference lives in a different database).
 * Call it inside the caller's transaction so the local write is atomic:
 *
 * ```ts
 * await dataSource.transaction((mgr) => createManyResolved(mgr, entries, { registry, adapters }));
 * ```
 *
 * The validated snapshot is best-effort/stale, so the durability of the guarantee rests on the
 * reference targets being **append-only** (a validated row can't be hard-deleted — see
 * {@link warnNonAppendOnlyTargets}) plus a periodic {@link verifyReferences} reconciliation sweep.
 * Cross-store atomicity, if needed, is the caller's saga/outbox concern (emit a compensating event
 * on downstream failure); this function deliberately does not pretend to provide it.
 */
export async function createManyResolved<T extends object>(
  writer: EntityWriter,
  entities: T[],
  options: ResolveOptions,
): Promise<T[]> {
  const results = assertEntitiesResolved(await resolveEntities(entities, options));
  // Consistency: the value AND scope WRITTEN must be what was VALIDATED. Between reading a field for
  // validation and writer.save re-reading it, concurrent code holding the same instance could swap
  // in an unvalidated reference or a different scope (a mid-flight tenant change). Fail closed on any
  // change (rolls back the caller's transaction). Do not mutate `entities` until this resolves.
  assertEntitiesUnchanged(results);
  // Close the gap between the re-check above and the write itself (issue #140 window #2): lock the
  // just-checked fields read-only for the save call, so a concurrent mutation during save's own
  // awaits throws instead of silently landing. Always unlocked afterward, success or throw.
  const unlockValidatedFields = lockValidatedFields(results);
  let saved: T[];
  try {
    saved = await writer.save(entities);
  } finally {
    unlockValidatedFields();
  }
  if (saved.length !== entities.length) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `writer.save returned ${saved.length} entities for ${entities.length} inputs`,
      { saved: saved.length, entities: entities.length },
    );
  }
  return saved;
}

/** Single-entity sugar over {@link createManyResolved}. */
export async function createResolved<T extends object>(
  writer: EntityWriter,
  entity: T,
  options: ResolveOptions,
): Promise<T> {
  // createManyResolved guarantees saved.length === 1, so saved[0] is defined.
  const [saved] = await createManyResolved(writer, [entity], options);
  return saved as T;
}

/** The outcome of a {@link verifyReferences} reconciliation sweep, partitioned by cause. */
export interface ReconciliationResult {
  /**
   * Genuine integrity problems — a reference that is provably wrong: the target row is gone
   * (`not_found`), a validator rejected it, a scope/allowlist violation, or an `invalid` row
   * (a `required` field or scope sibling that drifted to null). Safe for a remediation job to act on.
   */
  readonly dangling: readonly EntityFieldVerdict[];
  /**
   * References that could NOT be checked because a store was unreachable (`unavailable`). This is
   * availability, NOT integrity — a transient blip. A remediation job must **retry**, never treat
   * these as broken (that is exactly the `not_found`-vs-`unavailable` collapse the engine forbids).
   */
  readonly unavailable: readonly EntityFieldVerdict[];
}

/**
 * Reconciliation sweep: resolve every `@Resolve`d reference on a batch of **already-persisted**
 * rows (no write) and partition the failures — {@link ReconciliationResult.dangling} (act on) vs
 * {@link ReconciliationResult.unavailable} (retry). Run it as a background job over paginated
 * `repo.find()` results to detect references that went dangling after the write (the residual
 * TOCTOU window, or a non-append-only target that was deleted). It **never throws on data drift**:
 * a `required` field or scope sibling that is now null is reported as a `dangling` `invalid` verdict
 * rather than aborting the sweep, so one bad row can't wedge a paged job. Both lists are empty when
 * the batch is fully consistent.
 */
export async function verifyReferences(
  entities: readonly object[],
  options: ResolveOptions,
): Promise<ReconciliationResult> {
  const results = await resolveEntities(entities, options, { reportInvalidAsVerdict: true });
  const dangling: EntityFieldVerdict[] = [];
  const unavailable: EntityFieldVerdict[] = [];
  for (const result of results) {
    if (result.verdict.ok) continue;
    (result.verdict.status === 'unavailable' ? unavailable : dangling).push(result);
  }
  return { dangling: Object.freeze(dangling), unavailable: Object.freeze(unavailable) };
}

/**
 * Surface every registered reference target that is NOT marked append-only, by calling `warn` for
 * each — wire this into startup logging. A non-append-only target weakens the TOCTOU mitigation:
 * a validated row could be hard-deleted out from under a write, so a dangling reference can appear
 * even though `createManyResolved` validated it. Returns the count warned.
 */
export function warnNonAppendOnlyTargets(
  registry: ReferenceRegistry,
  warn: (message: string) => void,
): number {
  const targets = registry.nonAppendOnlyTargets();
  for (const entry of targets) {
    warn(
      `cross-store target "${entry.store}.${entry.table}.${entry.column}" is not marked append-only; ` +
        `a validated reference could be hard-deleted (TOCTOU mitigation weakened) — set targetIsAppendOnly or run verifyReferences regularly`,
    );
  }
  return targets.length;
}

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
  // just-checked fields (and, for a scoped field, its scope siblings) read-only for the save call —
  // see `lockValidatedFields` for what is and isn't lockable. Always unlocked afterward, success or
  // throw. A concurrent mutation during save's own awaits now throws a raw `TypeError` (the locked
  // assignment itself failing, in strict-mode ESM) rather than landing silently; recognized below by
  // its engine message and re-thrown as a `CrossStoreError` so this specific failure carries the
  // module's stable `.code` instead of leaking an assignment-failure implementation detail — any
  // OTHER `TypeError` (an unrelated bug in `writer.save`) is left alone, not misattributed to this
  // re-check.
  const unlockValidatedFields = lockValidatedFields(results);
  let saved: T[];
  try {
    saved = await writer.save(entities);
  } catch (cause) {
    if (cause instanceof TypeError && /assign to read.only property/i.test(cause.message)) {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        'a validated reference or its scope sibling was mutated during writer.save — refusing to write',
        { cause: String(cause) },
      );
    }
    throw cause;
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
  /**
   * References whose target is **misconfigured** — the registry points at a table/column/schema that
   * does not exist in the target store (`misconfigured`). This is a deploy/wiring bug, NOT per-row
   * data drift and NOT a transient blip: retrying won't help, and it isn't a specific row to
   * remediate. A sweep surfaces it here (rather than crashing, or mislabelling it `dangling`) so the
   * operator fixes the registry declaration or the target schema. Normally empty.
   */
  readonly misconfigured: readonly EntityFieldVerdict[];
}

/**
 * Reconciliation sweep: resolve every `@Resolve`d reference on a batch of **already-persisted**
 * rows (no write) and partition the failures — {@link ReconciliationResult.dangling} (act on) vs
 * {@link ReconciliationResult.unavailable} (retry). Run it as a background job over paginated
 * `repo.find()` results to detect references that went dangling after the write (the residual
 * TOCTOU window, or a non-append-only target that was deleted). It **never throws** — data drift
 * (a `required` field or scope sibling now null) is reported as a `dangling` `invalid` verdict, and
 * a misconfigured target (undefined table/column) as a `misconfigured` verdict, rather than aborting
 * the sweep, so one bad row or one mis-declared entry can't wedge a paged job. All lists are empty
 * when the batch is fully consistent.
 */
export async function verifyReferences(
  entities: readonly object[],
  options: ResolveOptions,
): Promise<ReconciliationResult> {
  const results = await resolveEntities(entities, options, { reportInvalidAsVerdict: true });
  const dangling: EntityFieldVerdict[] = [];
  const unavailable: EntityFieldVerdict[] = [];
  const misconfigured: EntityFieldVerdict[] = [];
  for (const result of results) {
    if (result.verdict.ok) continue;
    if (result.verdict.status === 'unavailable') unavailable.push(result);
    else if (result.verdict.status === 'misconfigured') misconfigured.push(result);
    else dangling.push(result);
  }
  return {
    dangling: Object.freeze(dangling),
    unavailable: Object.freeze(unavailable),
    misconfigured: Object.freeze(misconfigured),
  };
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

/**
 * Surface every registered reference target that is NOT marked `targetIsUnique`, by calling `warn`
 * for each — wire this into startup logging alongside {@link warnNonAppendOnlyTargets}. The resolver
 * assumes a target column is unique (it takes one row per key value); a non-unique target makes a
 * "resolved" verdict match an arbitrary row, so an undeclared one is a latent correctness risk.
 * Returns the count warned.
 */
export function warnNonUniqueTargets(
  registry: ReferenceRegistry,
  warn: (message: string) => void,
): number {
  const targets = registry.nonUniqueTargets();
  for (const entry of targets) {
    warn(
      `cross-store target "${entry.store}.${entry.table}.${entry.column}" is not marked unique; ` +
        `resolution assumes the target column is a PRIMARY KEY / UNIQUE and matches an arbitrary row otherwise — set targetIsUnique once you've confirmed the constraint`,
    );
  }
  return targets.length;
}

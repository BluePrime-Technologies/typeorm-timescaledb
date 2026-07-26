import { CrossStoreError, CrossStoreErrorCode } from './errors.js';
import { resolveReferences, type ResolveOptions, type ResolveVerdict } from './engine.js';
import {
  getResolveMetadata,
  type EntityClass,
  type ResolveFieldMeta,
} from './resolve-decorator.js';
import type { ReferenceRegistry } from './registry.js';
import type { ReferenceCheck, ResolveRef } from './types.js';

/** The verdict for one `@Resolve`d field of one entity instance. */
export interface EntityFieldVerdict {
  /** The entity instance the field belongs to. */
  readonly entity: object;
  /** The `@Resolve`d property that was checked. */
  readonly property: string;
  /** The underlying resolve verdict (see {@link ResolveVerdict}). */
  readonly verdict: ResolveVerdict;
}

/**
 * Read the scope values for a field from the entity's sibling properties. A `null`/`undefined`
 * sibling is rejected with entity/field context: an unset scope value can never scope-match a row
 * (SQL `col = NULL` is never true), so it is a wiring/usage error, and surfacing it here — rather
 * than as a context-less engine `INVALID_ARGUMENT` — tells the caller exactly which entity, field,
 * and scope property is unpopulated.
 */
function scopeValues(entity: object, field: ResolveFieldMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const row = entity as Record<string, unknown>;
  for (const [scopeColumn, property] of Object.entries(field.scope ?? {})) {
    const value = row[property];
    if (value === null || value === undefined) {
      const name = className(entity);
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `${name}.${field.property}: scope value for "${scopeColumn}" (property "${property}") is ${value === null ? 'null' : 'undefined'}`,
        { entity: name, property: field.property, scopeColumn, scopeProperty: property },
      );
    }
    out[scopeColumn] = value;
  }
  return out;
}

/**
 * Resolve an entity instance's class — **failing closed** for anything that isn't a real class
 * instance. `@Resolve` metadata lives only on a class, so a `null`/non-object or a detached plain
 * object (a spread `{...entity}`, an `Object.create(null)`, a POJO from `JSON.parse`) carries no
 * metadata: keying off `entity.constructor` there silently yields `[]` and skips EVERY reference —
 * including `required` ones — a fail-open that defeats the whole point of `required`. Derived via
 * `Object.getPrototypeOf` so a column literally named `constructor` can't shadow the class.
 */
function entityClassOf(entity: unknown): EntityClass {
  if (entity === null || typeof entity !== 'object') {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `resolveEntities: each entity must be a non-null object, got ${entity === null ? 'null' : typeof entity}`,
    );
  }
  const ctor = (Object.getPrototypeOf(entity) as { constructor?: EntityClass } | null)?.constructor;
  if (!ctor || ctor === (Object as unknown as EntityClass)) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      'resolveEntities requires class instances — a plain/spread object carries no @Resolve metadata, so its references (including required ones) would be silently unchecked. Pass entity instances, not detached/spread objects.',
    );
  }
  return ctor;
}

/**
 * The entity's class name for diagnostics — derived via the prototype (like {@link entityClassOf}),
 * NOT `entity.constructor.name`, so a column literally named `constructor` can't shadow it and turn
 * an error message into a secondary `TypeError`. Falls back to `'entity'`.
 */
function className(entity: object): string {
  const ctor = (Object.getPrototypeOf(entity) as { constructor?: { name?: string } } | null)
    ?.constructor;
  // `||` not `??`: an anonymous class has name `''`, which must fall back to 'entity' too.
  return ctor?.name || 'entity';
}

function buildCheck(entity: object, field: ResolveFieldMeta, value: unknown): ReferenceCheck {
  return {
    ref: field.ref,
    value,
    ...(field.scope !== undefined && { scope: scopeValues(entity, field) }),
    ...(field.validators !== undefined && { validators: field.validators }),
  };
}

/**
 * Resolve every `@Resolve`d reference on a batch of entity instances. Reads each decorated
 * property — a `null`/`undefined` value is "no reference" and is not sent to the engine, but is
 * still returned as a `not_referenced` baseline verdict (issue #140 window #1) rather than
 * dropped, so a write-path re-check can catch a later flip away from null. Non-null values build
 * the batched {@link ReferenceCheck}s (scope values pulled from sibling properties) and run the
 * engine. Returns one {@link EntityFieldVerdict} per decorated field (checked or not) — so a
 * caller knows exactly which entity/field failed. Pure and ORM-agnostic; the TypeORM write path
 * (`createManyResolved`) layers the caller-transaction TOCTOU mitigation on top in M3.4b.
 */
export interface ResolveEntitiesOptions {
  /**
   * How to treat a check that can't even be FORMED — a `required` field that is null/undefined, or
   * an unset scope sibling. `false` (default): throw `INVALID_ARGUMENT` — the fail-closed behavior
   * the write path (`createManyResolved`) wants (reject the write). `true`: emit an `invalid`
   * verdict instead — what a reconciliation SWEEP (`verifyReferences`) needs, so one drifted row
   * (an FK later set to NULL out-of-band) is reported rather than aborting the whole paged sweep.
   */
  readonly reportInvalidAsVerdict?: boolean;
}

/** Synthesize an `invalid` verdict for a check that could not be formed (report mode). */
function invalidVerdict(
  entity: object,
  property: string,
  value: unknown,
  ref: ResolveRef,
  error: CrossStoreError,
): EntityFieldVerdict {
  return {
    entity,
    property,
    verdict: { check: { ref, value }, ok: false, status: 'invalid', error },
  };
}

/**
 * Synthesize a baseline verdict for a nullable field that was `null`/`undefined` at validation
 * time (issue #140 window #1). Unlike a bare `continue`, recording this — instead of skipping the
 * field entirely — gives {@link assertEntitiesUnchanged} something to compare: its existing
 * `row[property] !== verdict.check.value` check already rejects any mid-flight flip away from
 * `null`/`undefined` (to a value, or the other nullish), because no engine fetch is needed to know
 * what "still has no reference" means. `ok: true` so {@link assertEntitiesResolved} never trips on
 * it; `status: 'not_referenced'` keeps it distinguishable from an actually-resolved reference.
 */
function notReferencedVerdict(
  entity: object,
  property: string,
  ref: ResolveRef,
  value: null | undefined,
): EntityFieldVerdict {
  return {
    entity,
    property,
    verdict: { check: { ref, value }, ok: true, status: 'not_referenced' },
  };
}

/** A slot awaiting its engine verdict, keyed by index into `checks`/`origins`. */
interface PendingSlot {
  readonly pendingCheckIndex: number;
}

function isPendingSlot(slot: EntityFieldVerdict | PendingSlot): slot is PendingSlot {
  return 'pendingCheckIndex' in slot;
}

export async function resolveEntities(
  entities: readonly object[],
  options: ResolveOptions,
  entityOptions: ResolveEntitiesOptions = {},
): Promise<readonly EntityFieldVerdict[]> {
  const report = entityOptions.reportInvalidAsVerdict === true;
  const checks: ReferenceCheck[] = [];
  const origins: Array<{ entity: object; property: string }> = [];
  // One slot per decorated field, in the SAME order the fields were scanned — an `invalid` or
  // `not_referenced` verdict is known immediately; a real check is a placeholder until the engine
  // returns, so the final result preserves input order regardless of which fields short-circuited.
  const slots: Array<EntityFieldVerdict | PendingSlot> = [];
  for (const entity of entities) {
    const meta = getResolveMetadata(entityClassOf(entity));
    for (const field of meta) {
      const value = (entity as Record<string, unknown>)[field.property];
      if (value === null || value === undefined) {
        if (field.required) {
          // A required reference must have a value. Write path: fail closed (throw). Sweep: report.
          const name = className(entity);
          const error = new CrossStoreError(
            CrossStoreErrorCode.INVALID_ARGUMENT,
            `${name}.${field.property}: required cross-store reference is ${value === null ? 'null' : 'undefined'}`,
            { entity: name, property: field.property, required: true },
          );
          if (!report) throw error;
          slots.push(invalidVerdict(entity, field.property, value, field.ref, error));
        } else {
          // Not required: still no reference to check, but record the null/undefined baseline
          // (issue #140 window #1) so the write path's TOCTOU re-check can catch a later flip.
          slots.push(notReferencedVerdict(entity, field.property, field.ref, value));
        }
        continue; // nullable FK → no reference to resolve via the engine
      }
      let check: ReferenceCheck;
      try {
        check = buildCheck(entity, field, value); // scopeValues throws on an unset scope sibling
      } catch (e) {
        if (!report || !(e instanceof CrossStoreError)) throw e;
        slots.push(invalidVerdict(entity, field.property, value, field.ref, e));
        continue;
      }
      const pendingCheckIndex = checks.length;
      checks.push(check);
      origins.push({ entity, property: field.property });
      slots.push({ pendingCheckIndex });
    }
  }
  const verdicts = await resolveReferences(checks, options);
  // The engine returns one verdict per input check, in input order — so verdicts[i] belongs to
  // origins[i]. Assert the invariant defensively: a future engine change that returned a deduped
  // or reordered array would silently misattribute verdicts to the wrong entity/field.
  if (verdicts.length !== origins.length) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `internal: resolveReferences returned ${verdicts.length} verdicts for ${origins.length} checks`,
      { verdicts: verdicts.length, checks: origins.length },
    );
  }
  return slots.map((slot) => {
    if (!isPendingSlot(slot)) return slot;
    const { entity, property } = origins[slot.pendingCheckIndex]!;
    return { entity, property, verdict: verdicts[slot.pendingCheckIndex]! };
  });
}

/**
 * Throw the first unresolved field (fail-closed helper for a write path), with entity/field
 * context attached. Returns the results unchanged when every field resolved.
 */
export function assertEntitiesResolved(
  results: readonly EntityFieldVerdict[],
): readonly EntityFieldVerdict[] {
  for (const result of results) {
    if (!result.verdict.ok) {
      // A well-formed failed verdict always carries its error. The fallback must NOT invent a code
      // — a hardcoded REFERENCE_NOT_FOUND would collapse an `unavailable` verdict into not_found,
      // the one thing issue #124 fix #5 forbids (mirrors the engine's assertAllResolved).
      const base =
        result.verdict.error ??
        new CrossStoreError(
          CrossStoreErrorCode.INVALID_ARGUMENT,
          `verdict with status "${result.verdict.status}" is missing its error`,
          { status: result.verdict.status },
        );
      const name = className(result.entity);
      throw new CrossStoreError(
        base.code,
        `${name}.${result.property}: ${base.message}`,
        // explicit identity wins — a future engine error context carrying `entity`/`property` must
        // not clobber the attribution this helper exists to add.
        { ...base.context, entity: name, property: result.property },
      );
    }
  }
  return results;
}

/**
 * Assert each resolved field on its entity STILL holds the value (and scope) it was validated with —
 * the write path's guarantee that "what is written is what was validated". Between reading a field
 * for validation and the ORM re-reading it at save time, concurrent code holding the same instance
 * could swap in an unvalidated reference OR a different scope (a mid-flight `workspaceId` change
 * would persist a cross-tenant reference — the scope dimension matters as much as the value). Throws
 * `INVALID_ARGUMENT` on any change (fail closed; rolls back the caller's transaction). A nullable FK
 * flipped null→value IS covered (issue #140 window #1): `resolveEntities` now returns a
 * `not_referenced` baseline verdict for it, so the value comparison below rejects the flip like any
 * other. This is intentionally strict about `null` vs `undefined` too, even though both mean "no
 * reference" elsewhere in this module: some ORMs give them different write semantics (e.g. TypeORM
 * skips an `undefined` column in a partial update but writes an explicit `NULL` for `null`), so
 * treating a null↔undefined toggle as harmless could mask a real change in what gets written. "Do
 * not mutate an in-flight entity" is the precondition; this re-check has no exceptions to it. This
 * closes the value window for every field `resolveEntities` returned — checked or not — and the
 * scope window for every field that had a scope to validate in the first place (a field with no
 * reference has no scope binding to re-check until it acquires one, and any such acquisition is
 * itself rejected by the value check above). It still only re-checks up to the *instant it runs*;
 * see {@link lockValidatedFields} for closing the gap between this re-check and the write itself
 * (issue #140 window #2).
 */
export function assertEntitiesUnchanged(results: readonly EntityFieldVerdict[]): void {
  for (const { entity, property, verdict } of results) {
    const row = entity as Record<string, unknown>;
    const name = className(entity);
    if (row[property] !== verdict.check.value) {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `${name}.${property} changed between validation and save — refusing to write an unvalidated reference`,
        { entity: name, property },
      );
    }
    const validatedScope = verdict.check.scope;
    if (validatedScope === undefined) continue;
    // Recompute the current scope from the field's sibling properties and compare to the validated
    // snapshot (scopeValues throws if a sibling is now null/undefined — also fail-closed).
    const field = getResolveMetadata(entityClassOf(entity)).find((f) => f.property === property);
    if (field?.scope === undefined) {
      // The field was validated WITH a scope, so its metadata must still carry one. If it doesn't
      // (the class was unregistered/mutated mid-flight — should never happen), we cannot re-verify
      // the scope, so fail closed rather than skip the check.
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `${name}.${property}: cannot re-verify scope at save time (metadata no longer declares a scope) — refusing to write`,
        { entity: name, property },
      );
    }
    const current = scopeValues(entity, field);
    for (const col of Object.keys(validatedScope)) {
      if (current[col] !== validatedScope[col]) {
        throw new CrossStoreError(
          CrossStoreErrorCode.INVALID_ARGUMENT,
          `${name}.${property} scope "${col}" changed between validation and save — refusing to write a reference validated under a different scope`,
          { entity: name, property, scopeColumn: col },
        );
      }
    }
  }
}

/**
 * Lock every field `assertEntitiesUnchanged` just re-checked — plus, for a scoped field, its scope
 * sibling properties — read-only for the duration of the write itself (issue #140 window #2:
 * `assertEntitiesUnchanged` then `writer.save` is not atomic; a concurrent holder of the same
 * mutable instance can still mutate it during `save`'s own internal await points). This package is
 * ESM (always strict mode), so an assignment to a locked property throws immediately instead of
 * silently landing an unvalidated reference — turning the violation of the documented "do not
 * mutate an in-flight entity" precondition into a loud failure instead of a silent one. This is a
 * best-effort, same-process mitigation: it cannot stop a rewrite issued by the ORM/driver itself
 * from a DIFFERENT process or connection (e.g. a DB-side trigger or default), only a concurrent
 * mutation of this same JS object from other code sharing the process.
 *
 * Deliberately narrower than freezing the whole entity (`Object.freeze` was rejected in the M3.4b
 * review — it breaks TypeORM's `save`, which needs to write other columns, e.g. a generated id):
 * only the exact validated properties are locked, so `save` can still do everything else it needs
 * to — **except** re-write those same validated properties itself (e.g. a subscriber or column
 * transformer that reassigns the very `@Resolve`d column during save would now also throw; for such
 * an entity, this locking mitigation and that ORM feature are incompatible).
 *
 * FAILS CLOSED, not silently degraded: only an own, configurable data property can actually be
 * locked this way, so an inherited getter/setter or a non-configurable field (no own descriptor to
 * safely restore) is not "left alone" — it makes this function throw `INVALID_ARGUMENT` and abort
 * the write, restoring every property already locked in this same call first. A protection that
 * silently doesn't apply to some fields would be a false sense of safety; refusing to write is the
 * fail-closed alternative used everywhere else in this module (e.g. `assertEntitiesUnchanged`'s
 * "cannot re-verify scope" case — mirrored here too: a verdict validated WITH a scope whose class
 * metadata no longer declares one aborts the write rather than silently locking zero scope
 * siblings). A property referenced by more than one result (e.g. a scope
 * sibling shared by two `@Resolve`d fields) is locked/restored exactly once. The lock preserves the
 * property's original `configurable: true` (needed to restore it afterward), so it stops an ordinary
 * assignment (`entity.prop = x`, the TOCTOU threat this targets) but not a deliberate
 * `Object.defineProperty` redefinition — a documented, deliberately accepted residual, since the
 * alternative (`configurable: false`) can never be undone and would leave every written entity
 * permanently reshaped.
 *
 * Returns an `unlock` function that restores every original property descriptor. **Always** call
 * it — in a `finally` around the write — so entities are left fully mutable again whether the
 * write succeeded or threw. Restoring is itself best-effort: a single property that fails to
 * restore (e.g. something else made it non-configurable during the write) is swallowed rather than
 * thrown, so a cleanup failure can never mask the write's real outcome or stop the rest of the
 * batch from being restored.
 */
export function lockValidatedFields(results: readonly EntityFieldVerdict[]): () => void {
  const lockedByEntity = new Map<object, Set<string>>();
  const restores: Array<() => void> = [];
  const unlockAlreadyLocked = (): void => {
    for (let i = restores.length - 1; i >= 0; i--) {
      try {
        restores[i]!();
      } catch {
        // best-effort: a failed restore must not mask the write's real outcome, nor stop the rest
        // of the batch from being restored.
      }
    }
  };
  const failToLock = (entity: object, property: string, cause?: unknown): never => {
    // Unwinds synchronously (nothing awaits between a field's lock() and this call), so a restore
    // genuinely cannot fail here today — the swallow above exists for the *post-write* `finally`
    // unlock, where save() has run in between. If this loop ever gains an async step, re-check
    // whether a swallowed failure here needs its own signal (unlike the post-write case, this path
    // is the only chance to undo an otherwise-permanent lock on an aborted write).
    unlockAlreadyLocked(); // don't leave earlier fields in this same call permanently locked
    const name = className(entity);
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `${name}.${property}: cannot lock this field for the save-time TOCTOU re-check (not an own, ` +
        `configurable data property — an inherited getter/setter or a non-configurable field) — ` +
        `refusing to write`,
      { entity: name, property, ...(cause !== undefined && { cause: String(cause) }) },
    );
  };
  const lock = (entity: object, property: string): void => {
    let locked = lockedByEntity.get(entity);
    if (!locked) {
      locked = new Set();
      lockedByEntity.set(entity, locked);
    }
    if (locked.has(property)) return; // already locked (e.g. a shared scope sibling)
    locked.add(property);
    const target = entity as Record<string, unknown>;
    const found = Object.getOwnPropertyDescriptor(target, property);
    // A property that is absent from the instance AND from its whole prototype chain is the normal
    // shape of an optional reference that was simply never assigned (`parentId?: string` with no
    // initializer) — a supported, `not_referenced` case. It is exactly as lockable as a present one:
    // define it as a non-writable `undefined` and restore by deleting it. Refusing here would reject
    // the whole write for a perfectly valid entity.
    //
    // `property in target` is what separates this from an INHERITED accessor (a prototype
    // getter/setter also has no *own* descriptor): defining an own property there would silently
    // shadow the accessor and change the entity's semantics, so that case must still fail closed.
    if (found === undefined && !(property in target)) {
      try {
        Object.defineProperty(target, property, {
          value: undefined,
          writable: false,
          enumerable: true,
          configurable: true,
        });
      } catch (cause) {
        failToLock(entity, property, cause);
        return; // unreachable — failToLock always throws
      }
      restores.push(() => {
        delete target[property];
      });
      return;
    }
    // Anything else unlockable — an inherited/own accessor, or a non-configurable field — still
    // fails closed rather than letting an unguarded write through.
    if (found === undefined || !('value' in found) || found.configurable === false) {
      failToLock(entity, property);
      return; // unreachable — failToLock always throws; satisfies the type checker below
    }
    const original: PropertyDescriptor = found;
    try {
      Object.defineProperty(target, property, { ...original, writable: false });
    } catch (cause) {
      failToLock(entity, property, cause);
      return; // unreachable — failToLock always throws
    }
    restores.push(() => Object.defineProperty(target, property, original));
  };
  for (const { entity, property, verdict } of results) {
    lock(entity, property);
    const scope = verdict.check.scope;
    if (scope === undefined) continue;
    const field = getResolveMetadata(entityClassOf(entity)).find((f) => f.property === property);
    if (field?.scope === undefined) {
      // Mirrors `assertEntitiesUnchanged`'s identical "cannot re-verify scope" case: a verdict
      // validated WITH a scope whose class metadata no longer declares one. Failing OPEN here (by
      // simply locking nothing for the scope) would contradict this function's own "FAILS CLOSED"
      // guarantee — refuse the write instead, same as the re-check that already ran before this.
      unlockAlreadyLocked();
      const name = className(entity);
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `${name}.${property}: cannot lock the scope siblings for the save-time TOCTOU re-check ` +
          `(metadata no longer declares a scope) — refusing to write`,
        { entity: name, property },
      );
    }
    for (const scopeProperty of Object.values(field.scope)) lock(entity, scopeProperty);
  }
  return unlockAlreadyLocked;
}

/**
 * Boot-time wiring check (issue #124 fix #4): assert every `@Resolve` triple on every given entity
 * class — and every scope column it uses — is present in the registry. Throws `REFERENCE_NOT_ALLOWED`
 * / `SCOPE_VIOLATION` at startup so a mis-declared `@Resolve` fails fast, never on the first write.
 */
export function assertEntitiesRegistered(
  classes: readonly EntityClass[],
  registry: ReferenceRegistry,
): void {
  for (const cls of classes) {
    for (const field of getResolveMetadata(cls)) {
      registry.assertScopeAllowed(field.ref, field.scope ? Object.keys(field.scope) : []);
    }
  }
}

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
  return ctor?.name ?? 'entity';
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
 * property (skipping `null`/`undefined` — a nullable FK is simply "no reference"), builds the
 * batched {@link ReferenceCheck}s (scope values pulled from sibling properties), runs the engine,
 * and returns one {@link EntityFieldVerdict} per checked field — so a caller knows exactly which
 * entity/field failed. Pure and ORM-agnostic; the TypeORM write path (`createManyResolved`) layers
 * the caller-transaction TOCTOU mitigation on top in M3.4b.
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

export async function resolveEntities(
  entities: readonly object[],
  options: ResolveOptions,
  entityOptions: ResolveEntitiesOptions = {},
): Promise<readonly EntityFieldVerdict[]> {
  const report = entityOptions.reportInvalidAsVerdict === true;
  const checks: ReferenceCheck[] = [];
  const origins: Array<{ entity: object; property: string }> = [];
  const invalid: EntityFieldVerdict[] = [];
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
          invalid.push(invalidVerdict(entity, field.property, value, field.ref, error));
        }
        continue; // nullable FK → no reference
      }
      let check: ReferenceCheck;
      try {
        check = buildCheck(entity, field, value); // scopeValues throws on an unset scope sibling
      } catch (e) {
        if (!report || !(e instanceof CrossStoreError)) throw e;
        invalid.push(invalidVerdict(entity, field.property, value, field.ref, e));
        continue;
      }
      checks.push(check);
      origins.push({ entity, property: field.property });
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
  const resolved = verdicts.map((verdict, i) => ({
    entity: origins[i]!.entity,
    property: origins[i]!.property,
    verdict,
  }));
  return report ? [...resolved, ...invalid] : resolved;
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
 * flipped null→value is not covered (it produced no verdict) — "do not mutate an in-flight entity"
 * remains the precondition; this closes the value AND scope windows for every VALIDATED field.
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
    if (field?.scope === undefined) continue;
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

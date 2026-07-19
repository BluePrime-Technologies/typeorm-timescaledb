import { CrossStoreError, CrossStoreErrorCode } from './errors.js';
import { resolveReferences, type ResolveOptions, type ResolveVerdict } from './engine.js';
import {
  getResolveMetadata,
  type EntityClass,
  type ResolveFieldMeta,
} from './resolve-decorator.js';
import type { ReferenceRegistry } from './registry.js';
import type { ReferenceCheck } from './types.js';

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
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `${entity.constructor.name}.${field.property}: scope value for "${scopeColumn}" (property "${property}") is ${value === null ? 'null' : 'undefined'}`,
        {
          entity: entity.constructor.name,
          property: field.property,
          scopeColumn,
          scopeProperty: property,
        },
      );
    }
    out[scopeColumn] = value;
  }
  return out;
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
export async function resolveEntities(
  entities: readonly object[],
  options: ResolveOptions,
): Promise<readonly EntityFieldVerdict[]> {
  const checks: ReferenceCheck[] = [];
  const origins: Array<{ entity: object; property: string }> = [];
  for (const entity of entities) {
    const meta = getResolveMetadata(entity.constructor as EntityClass);
    for (const field of meta) {
      const value = (entity as Record<string, unknown>)[field.property];
      if (value === null || value === undefined) {
        if (field.required) {
          // A required reference must have a value — a null/undefined here is fail-closed (an
          // un-hydrated relation or partial DTO must NOT slip through unchecked).
          throw new CrossStoreError(
            CrossStoreErrorCode.INVALID_ARGUMENT,
            `${entity.constructor.name}.${field.property}: required cross-store reference is ${value === null ? 'null' : 'undefined'}`,
            { entity: entity.constructor.name, property: field.property, required: true },
          );
        }
        continue; // nullable FK → no reference
      }
      checks.push(buildCheck(entity, field, value));
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
  return verdicts.map((verdict, i) => ({
    entity: origins[i]!.entity,
    property: origins[i]!.property,
    verdict,
  }));
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
      const base =
        result.verdict.error ??
        new CrossStoreError(CrossStoreErrorCode.REFERENCE_NOT_FOUND, 'reference not resolved');
      throw new CrossStoreError(
        base.code,
        `${result.entity.constructor.name}.${result.property}: ${base.message}`,
        // explicit identity wins — a future engine error context carrying `entity`/`property` must
        // not clobber the attribution this helper exists to add.
        { ...base.context, entity: result.entity.constructor.name, property: result.property },
      );
    }
  }
  return results;
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

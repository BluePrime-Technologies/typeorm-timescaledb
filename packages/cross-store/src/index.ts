/**
 * `@blueprime/cross-store` — validated cross-store (`@Resolve`) references between two
 * separate database instances (e.g. TimescaleDB and a canonical Postgres store).
 *
 * App-level validation, not FDW/dblink/replication: two separate DB servers cannot share a
 * SQL foreign key, so integrity is enforced in the application against the two connections
 * the app already holds. Best-effort with documented caveats (there is a TOCTOU window
 * across instances) — which is why this is a package apart from the zero-bug ORM core.
 *
 * M3.1 shipped the foundation: the anti-injection {@link ReferenceRegistry}, the stable
 * {@link CrossStoreError} taxonomy, and the ORM-agnostic {@link CrossStoreAdapter} contract.
 * M3.2 added the batch {@link resolveReferences} engine; M3.3 the TypeORM + Prisma adapters
 * (`./typeorm`, `./prisma` subpaths). M3.4 adds the {@link Resolve} decorator + {@link resolveEntities}.
 */
export { CrossStoreError, CrossStoreErrorCode } from './errors.js';
export { ReferenceRegistry } from './registry.js';
export type { ReferenceRegistryEntry } from './registry.js';
export { resolveReferences, assertAllResolved } from './engine.js';
export type {
  Validator,
  ValidatorMap,
  ResolveOptions,
  ResolveStatus,
  ResolveVerdict,
} from './engine.js';
export { Resolve, getResolveMetadata } from './resolve-decorator.js';
export type { ResolveFieldOptions, ResolveFieldMeta, EntityClass } from './resolve-decorator.js';
export {
  resolveEntities,
  assertEntitiesResolved,
  assertEntitiesUnchanged,
  assertEntitiesRegistered,
  lockValidatedFields,
} from './resolve-entities.js';
export type { EntityFieldVerdict, ResolveEntitiesOptions } from './resolve-entities.js';
export type {
  ResolveRef,
  ReferenceCheck,
  SnapshotRow,
  FindManyInput,
  CrossStoreAdapter,
} from './types.js';

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
 * M3.2 adds the batch {@link resolveReferences} engine. M3.3a adds the shared
 * {@link buildFindManySql} SQL builder and the first real adapter (`./typeorm` subpath,
 * `DataSourceAdapter`, over a TypeORM `DataSource`). The `@Resolve` decorator lands in a
 * later slice.
 */
export { CrossStoreError, CrossStoreErrorCode } from './errors.js';
export { ReferenceRegistry } from './registry.js';
export type { ReferenceRegistryEntry } from './registry.js';
export { resolveReferences, assertAllResolved } from './engine.js';
export { buildFindManySql } from './sql.js';
export type { BuildFindManySqlInput, BuiltFindManySql } from './sql.js';
export type {
  Validator,
  ValidatorMap,
  ResolveOptions,
  ResolveStatus,
  ResolveVerdict,
} from './engine.js';
export type {
  ResolveRef,
  ReferenceCheck,
  SnapshotRow,
  FindManyInput,
  CrossStoreAdapter,
} from './types.js';

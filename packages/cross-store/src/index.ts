/**
 * `@blueprime/cross-store` — validated cross-store (`@Resolve`) references between two
 * separate database instances (e.g. TimescaleDB and a canonical Postgres store).
 *
 * App-level validation, not FDW/dblink/replication: two separate DB servers cannot share a
 * SQL foreign key, so integrity is enforced in the application against the two connections
 * the app already holds. Best-effort with documented caveats (there is a TOCTOU window
 * across instances) — which is why this is a package apart from the zero-bug ORM core.
 *
 * M3.1 ships the foundation: the anti-injection {@link ReferenceRegistry}, the stable
 * {@link CrossStoreError} taxonomy, and the ORM-agnostic {@link CrossStoreAdapter} contract.
 * The batch resolve engine, adapters, and the `@Resolve` decorator land in later slices.
 */
export { CrossStoreError, CrossStoreErrorCode } from './errors.js';
export { ReferenceRegistry } from './registry.js';
export type { ReferenceRegistryEntry } from './registry.js';
export type {
  ResolveRef,
  ReferenceCheck,
  SnapshotRow,
  FindManyInput,
  CrossStoreAdapter,
} from './types.js';

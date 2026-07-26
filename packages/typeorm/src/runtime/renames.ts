import type { DataSource } from 'typeorm';
import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import { getTimescaleMetadata, hasTimescaleMetadata } from '../decorators/index.js';

type Ctor = abstract new (...args: never[]) => unknown;

/**
 * Collect the M4.2 rename map from `@Hypertable({ renamedFrom })` declarations on a DataSource's
 * entities: desired (new) schema-qualified table name → current (old) schema-qualified table name.
 * `diffSchemaState` consumes this (as `DiffOptions.renames`) to resolve a renamed hypertable to a
 * single `renameHypertable` op instead of a drop-then-create — see its module doc.
 *
 * An unqualified `renamedFrom` value (no `.`) is resolved against the ENTITY'S OWN schema, matching
 * how `compileDesiredState` qualifies `table` — the common case (a same-schema rename) needs no
 * qualification from the caller.
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` if the DataSource is not initialized (mirrors
 *   `compileDesiredState`); if `renamedFrom` resolves to the entity's own (new) table name (a
 *   no-op rename left in place); or if two entities declare the same `renamedFrom` (ambiguous —
 *   which one is the real successor is undecidable here).
 */
export function collectRenames(dataSource: DataSource): ReadonlyMap<string, string> {
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before collecting renames — entityMetadatas is empty otherwise',
    );
  }

  const entities = dataSource.entityMetadatas.filter(
    (em) => typeof em.target === 'function' && hasTimescaleMetadata(em.target as Ctor),
  );

  const renames = new Map<string, string>();
  // Reverse index (old table → the desired table that claims it) purely to produce a clear
  // "which two entities collided" error message; not needed for the map itself.
  const claimedBy = new Map<string, string>();

  for (const em of entities) {
    const meta = getTimescaleMetadata(em.target as Ctor);
    const renamedFrom = meta?.options.renamedFrom;
    if (renamedFrom === undefined) continue;

    const schema = em.schema ?? 'public';
    const newTable = `${schema}.${em.tableName}`;
    const oldTable = renamedFrom.includes('.') ? renamedFrom : `${schema}.${renamedFrom}`;

    if (oldTable === newTable) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `hypertable ${newTable}: renamedFrom must differ from the current table name`,
        { table: newTable },
      );
    }
    const existingClaimant = claimedBy.get(oldTable);
    if (existingClaimant !== undefined) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `ambiguous rename: both ${existingClaimant} and ${newTable} declare renamedFrom(${oldTable})`,
        { oldTable, desired: [existingClaimant, newTable] },
      );
    }
    claimedBy.set(oldTable, newTable);
    renames.set(newTable, oldTable);
  }

  return renames;
}

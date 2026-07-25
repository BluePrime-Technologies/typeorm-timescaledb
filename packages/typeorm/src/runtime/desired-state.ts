import type { DataSource } from 'typeorm';
import {
  TimescaleError,
  TimescaleErrorCode,
  validateHypertableMetadata,
  type ColumnstoreState,
  type DimensionState,
  type HypertableState,
  type OrderByElement,
  type PolicyState,
  type SchemaStateIR,
} from '@blueprime/timescaledb-core';
import { getTimescaleMetadata, hasTimescaleMetadata } from '../decorators/index.js';

type Ctor = abstract new (...args: never[]) => unknown;

/**
 * Compile the **desired** TimescaleDB schema state from the `@Hypertable` entities registered on a
 * DataSource into the canonical {@link SchemaStateIR} — the same shape `introspect()` produces for the
 * **current** live-DB state (M4.0). The migration diff engine (M4.2) compares the two:
 * `diffSchemaState(introspect(ds), compileDesiredState(ds))`.
 *
 * Producing the identical IR shape on both sides is what makes the diff normalization-comparable: the
 * table is always schema-qualified (default `public`, matching `introspect()`), physical column names
 * are resolved (`@Column({ name })`), and columnstore ORDER BY carries the Postgres per-direction NULLS
 * default (ASC → NULLS LAST, DESC → NULLS FIRST) — the same value `introspect()` reads back.
 *
 * **This encodes ONLY what the decorators declare** — it deliberately does NOT fill the defaults the
 * TimescaleDB engine adds. So identical shape is necessary but NOT sufficient for an unchanged schema to
 * diff to empty: the M4.2 diff engine (S2) MUST reconcile the system-filled defaults `introspect()` reads
 * back but this compiler omits, via `TIMESCALE_DEFAULTS` (see `normalize.ts`). The known divergences —
 * pinned as characterization tests in `desired-state.test.ts` so S2 cannot silently regress them:
 *   1. **time-dim `chunkInterval`** undeclared here → `introspect()` reads a concrete default (`'7 days'`);
 *   2. **columnstore `orderBy`** when only `compressAfter` is set → `[]` here, but the engine auto-fills
 *      the time column DESC → `introspect()` reads that back;
 *   3. **policy `scheduleInterval`** absent here → every background job has one, so `introspect()` reads it.
 * `timescaledbVersion` is likewise omitted here (a read-time pin, not a diffed field — S2 must exclude it).
 *
 * Scope (M4.2 S1): hypertables + dimensions + columnstore + compression/retention policies.
 * **Continuous aggregates are not yet compiled** (`continuousAggregates` is always `[]`) — the CAGG
 * structural-facet diff needs `introspect()`'s `ContinuousAggregateState` enriched first (a later slice).
 * Until then the S2 diff MUST be hypertable-scoped and must NOT act on CAGGs (else it would drop every
 * CAGG in a live DB, which this always-empty list would otherwise imply).
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` if the DataSource is not initialized (entityMetadatas is
 *   empty until `initialize()`), or `NO_TIME_COLUMN` if a hypertable entity has no resolvable time column.
 */
export function compileDesiredState(dataSource: DataSource): SchemaStateIR {
  // entityMetadatas is empty until initialize() builds it; fail loudly rather than silently
  // producing an empty desired state (which would diff as "drop everything").
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before compiling desired state — entityMetadatas is empty otherwise',
    );
  }

  const entities = dataSource.entityMetadatas
    .filter((em) => typeof em.target === 'function' && hasTimescaleMetadata(em.target as Ctor))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));

  const hypertables: HypertableState[] = [];

  for (const em of entities) {
    const meta = getTimescaleMetadata(em.target as Ctor);
    // Unreachable (filtered above), but keeps the type honest.
    if (!meta) continue;
    validateHypertableMetadata(meta, em.tableName);

    const timeColumn = meta.timeColumn ?? meta.options.timeColumn;
    if (timeColumn === undefined) {
      // validateHypertableMetadata already guarantees this; narrow for the type system.
      throw new TimescaleError(
        TimescaleErrorCode.NO_TIME_COLUMN,
        `${em.tableName} has no time column`,
        {
          table: em.tableName,
        },
      );
    }

    // Decorators capture the entity PROPERTY name; the IR carries the physical column, so the diff
    // compares against introspect()'s catalog names. Falls back to the name as-is when no column
    // metadata is present (mirrors generate.ts).
    const dbColumn = new Map<string, string>(
      (em.columns ?? []).map((c) => [c.propertyName, c.databaseName]),
    );
    const toDb = (property: string): string => dbColumn.get(property) ?? property;

    // Always schema-qualify (default public) so desired state compares directly to introspect().
    const table = `${em.schema ?? 'public'}.${em.tableName}`;
    const space = meta.options.spacePartition;

    // Time dimension first, then space — the order introspect() reports (and the M4.0 round-trip asserts).
    const dimensions: DimensionState[] = [
      {
        column: toDb(timeColumn),
        kind: 'time',
        ...(meta.options.chunkInterval !== undefined && {
          chunkInterval: meta.options.chunkInterval,
        }),
      },
    ];
    if (space !== undefined) {
      dimensions.push({
        column: toDb(space.column),
        kind: 'space',
        numPartitions: space.partitions,
      });
    }

    const cs = meta.options.columnstore;
    const columnstore: ColumnstoreState | undefined =
      cs === undefined
        ? undefined
        : {
            segmentBy: (cs.segmentBy ?? []).map(toDb),
            orderBy: (cs.orderBy ?? []).map(
              (o): OrderByElement => ({
                column: toDb(o.column),
                desc: o.direction === 'DESC',
                // Decorators don't express NULLS placement; use Postgres's per-direction default,
                // matching what introspect() reads back (ASC → NULLS LAST, DESC → NULLS FIRST).
                nullsFirst: o.direction === 'DESC',
              }),
            ),
          };

    // The columnstore `compressAfter` becomes the compression POLICY; segmentBy/orderBy are the
    // columnstore state above. Retention becomes the retention policy.
    const compressionPolicy: PolicyState | undefined =
      cs?.compressAfter === undefined
        ? undefined
        : { kind: 'compression', after: cs.compressAfter };
    const retentionPolicy: PolicyState | undefined =
      meta.options.retention === undefined
        ? undefined
        : { kind: 'retention', after: meta.options.retention.dropAfter };

    hypertables.push({
      table,
      dimensions,
      ...(columnstore !== undefined && { columnstore }),
      ...(compressionPolicy !== undefined && { compressionPolicy }),
      ...(retentionPolicy !== undefined && { retentionPolicy }),
    });
  }

  return { hypertables, continuousAggregates: [] };
}

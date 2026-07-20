import type { DataSource } from 'typeorm';
import {
  compareHypertable,
  compareContinuousAggregate,
  formatDrift,
  TIMESCALEDB_PRESENCE_SQL,
  TimescaleError,
  TimescaleErrorCode,
  validateHypertableMetadata,
  type ActualHypertable,
  type ActualContinuousAggregate,
  type DriftItem,
  type ExpectedHypertable,
  type ExpectedContinuousAggregate,
} from '@blueprime/timescaledb-core';
import {
  getTimescaleMetadata,
  hasTimescaleMetadata,
  getContinuousAggregateMeta,
  assertTypeOrmPrimaryKeyIncludesPartitioning,
} from '../decorators/index.js';

type Ctor = abstract new (...args: never[]) => unknown;

const defaultLogger = (message: string): void => console.warn(message);

export interface AssertSchemaOptions {
  /**
   * `'assert'` (default) throws `TimescaleError(SCHEMA_DRIFT)` on any drift;
   * `'warn'` logs the drift and returns it instead.
   */
  readonly mode?: 'assert' | 'warn';
  /** Sink for `'warn'` mode. Defaults to `console.warn`. */
  readonly logger?: (message: string) => void;
  /**
   * `@ContinuousAggregate` classes to also check for drift. CAGGs are not TypeORM
   * entities, so — like `generateTimescaleMigration` — they are passed explicitly.
   */
  readonly continuousAggregates?: ReadonlyArray<Ctor>;
}

/** Split an optionally schema-qualified view name into `{ schema, view }` (defaults to `public`). */
function splitView(name: string): { schema: string; view: string } {
  const dot = name.indexOf('.');
  return dot === -1
    ? { schema: 'public', view: name }
    : { schema: name.slice(0, dot), view: name.slice(dot + 1) };
}

/** Read the live state of one continuous aggregate from `timescaledb_information.*`. */
async function readActualCagg(
  dataSource: DataSource,
  schema: string,
  view: string,
): Promise<ActualContinuousAggregate> {
  const rows: Array<{ materialized_only: unknown }> = await dataSource.query(
    `SELECT materialized_only FROM timescaledb_information.continuous_aggregates
       WHERE view_schema = $1 AND view_name = $2`,
    [schema, view],
  );
  if (rows.length === 0) {
    return { exists: false, materializedOnly: false, hasRefreshPolicy: false };
  }
  // Version-robust refresh-job match: jobs.hypertable_name is the user-facing view on
  // newer servers but the internal materialization hypertable on 2.18 (see M2.5c).
  const policy: unknown[] = await dataSource.query(
    `SELECT 1 FROM timescaledb_information.jobs j
       WHERE j.proc_name = 'policy_refresh_continuous_aggregate' AND (
         (j.hypertable_schema = $1 AND j.hypertable_name = $2)
         OR EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates c
           WHERE c.view_schema = $1 AND c.view_name = $2
             AND c.materialization_hypertable_schema = j.hypertable_schema
             AND c.materialization_hypertable_name = j.hypertable_name))`,
    [schema, view],
  );
  // node-pg maps bool → boolean, but coerce defensively so a raw/other driver returning
  // the Postgres text form ('t'/'f') still reads correctly.
  const mo = rows[0]?.materialized_only;
  return {
    exists: true,
    materializedOnly: mo === true || mo === 't',
    hasRefreshPolicy: policy.length > 0,
  };
}

/** Read the live state of one hypertable from `timescaledb_information.*`. */
async function readActual(
  dataSource: DataSource,
  schema: string,
  table: string,
): Promise<ActualHypertable> {
  const ht: unknown[] = await dataSource.query(
    `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_schema = $1 AND hypertable_name = $2`,
    [schema, table],
  );
  if (ht.length === 0) {
    return {
      isHypertable: false,
      dimensionColumns: [],
      hasColumnstorePolicy: false,
      hasRetentionPolicy: false,
    };
  }
  const dims: Array<{ column_name: string }> = await dataSource.query(
    `SELECT column_name FROM timescaledb_information.dimensions WHERE hypertable_schema = $1 AND hypertable_name = $2`,
    [schema, table],
  );
  const jobs: Array<{ proc_name: string }> = await dataSource.query(
    `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_schema = $1 AND hypertable_name = $2`,
    [schema, table],
  );
  const procs = jobs.map((j) => j.proc_name);
  return {
    isHypertable: true,
    dimensionColumns: dims.map((d) => d.column_name),
    hasColumnstorePolicy: procs.includes('policy_compression'),
    hasRetentionPolicy: procs.includes('policy_retention'),
  };
}

/**
 * Verify the live database matches every `@Hypertable` entity on the DataSource.
 * For each entity it compares `timescaledb_information.*` against the declared
 * metadata (is-hypertable, partition columns, columnstore/retention policies).
 *
 * On drift: `mode: 'assert'` (default) throws `TimescaleError(SCHEMA_DRIFT)` with a
 * human diff; `mode: 'warn'` logs it and returns the drift list. Returns `[]` when
 * the schema is in sync. The DataSource must be initialized.
 *
 * If any `@Hypertable` entities are registered, this first checks that the
 * `timescaledb` extension itself is installed and fails fast with the stable
 * `TSDB_TIMESCALEDB_MISSING` error if not — otherwise a plain-PostgreSQL target
 * would fail later with a raw `relation "timescaledb_information.hypertables"
 * does not exist` error instead.
 */
export async function assertSchema(
  dataSource: DataSource,
  options: AssertSchemaOptions = {},
): Promise<DriftItem[]> {
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before asserting the schema',
    );
  }

  const drift: DriftItem[] = [];
  const hypertables = dataSource.entityMetadatas.filter(
    (em) => typeof em.target === 'function' && hasTimescaleMetadata(em.target as Ctor),
  );

  if (hypertables.length > 0) {
    const presence: unknown[] = await dataSource.query(TIMESCALEDB_PRESENCE_SQL);
    if (!Array.isArray(presence) || presence.length === 0) {
      throw new TimescaleError(
        TimescaleErrorCode.TIMESCALEDB_MISSING,
        'timescaledb is not installed on this database — run `CREATE EXTENSION timescaledb;` ' +
          '(or connect to a TimescaleDB-enabled database) before calling assertSchema()',
      );
    }
  }

  for (const em of hypertables) {
    const meta = getTimescaleMetadata(em.target as Ctor);
    if (!meta) continue;
    validateHypertableMetadata(meta, em.tableName);

    const dbColumn = new Map<string, string>(
      (em.columns ?? []).map((c) => [c.propertyName, c.databaseName]),
    );
    const toDb = (property: string): string => dbColumn.get(property) ?? property;

    const timeColumn = meta.timeColumn ?? meta.options.timeColumn;
    if (timeColumn === undefined) continue; // validateHypertableMetadata already guarantees this
    // A plain TypeORM @PrimaryColumn key that omits a partitioning column is caught here at boot,
    // not at first write with a raw Postgres error (partitioning columns are property names).
    assertTypeOrmPrimaryKeyIncludesPartitioning(em, [
      timeColumn,
      ...(meta.options.spacePartition ? [meta.options.spacePartition.column] : []),
    ]);

    const schema = em.schema ?? 'public';
    const expected: ExpectedHypertable = {
      table: `${schema}.${em.tableName}`,
      timeColumn: toDb(timeColumn),
      ...(meta.options.spacePartition !== undefined && {
        spacePartitionColumn: toDb(meta.options.spacePartition.column),
      }),
      expectColumnstorePolicy: meta.options.columnstore?.compressAfter !== undefined,
      expectRetentionPolicy: meta.options.retention !== undefined,
    };

    const actual = await readActual(dataSource, schema, em.tableName);
    drift.push(...compareHypertable(expected, actual));
  }

  // Continuous aggregates (passed explicitly — they are not TypeORM entities).
  for (const caggCtor of options.continuousAggregates ?? []) {
    const meta = getContinuousAggregateMeta(caggCtor);
    if (!meta) continue; // not a @ContinuousAggregate — ignore
    const { schema, view } = splitView(meta.viewName);
    const expected: ExpectedContinuousAggregate = {
      view: `${schema}.${view}`,
      materializedOnly: meta.materializedOnly ?? false,
      expectRefreshPolicy: meta.refresh !== undefined,
    };
    const actual = await readActualCagg(dataSource, schema, view);
    drift.push(...compareContinuousAggregate(expected, actual));
  }

  if (drift.length > 0) {
    const message = formatDrift(drift);
    if ((options.mode ?? 'assert') === 'assert') {
      throw new TimescaleError(TimescaleErrorCode.SCHEMA_DRIFT, message, { drift });
    }
    (options.logger ?? defaultLogger)(message);
  }

  return drift;
}

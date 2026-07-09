/**
 * Schema-drift comparison: does the live database match what an entity declares?
 *
 * Pure and framework-neutral — the ORM binding queries `timescaledb_information.*`
 * to build {@link ActualHypertable}, this module decides what (if anything) drifted.
 */

/** What an entity's `@Hypertable` metadata expects the database to look like. */
export interface ExpectedHypertable {
  /** Schema-qualified display name, e.g. `public.metrics` (used in messages). */
  readonly table: string;
  /** The time/partition column (physical column name). */
  readonly timeColumn: string;
  /** Optional space-partition column (physical column name). */
  readonly spacePartitionColumn?: string;
  /** A columnstore policy is expected (entity declared `columnstore.compressAfter`). */
  readonly expectColumnstorePolicy: boolean;
  /** A retention policy is expected (entity declared `retention`). */
  readonly expectRetentionPolicy: boolean;
}

/** The relevant live state read from `timescaledb_information.*`. */
export interface ActualHypertable {
  /** The table is registered as a hypertable. */
  readonly isHypertable: boolean;
  /** Partitioning dimension columns (`timescaledb_information.dimensions.column_name`). */
  readonly dimensionColumns: readonly string[];
  /** A columnstore (compression) policy job exists. */
  readonly hasColumnstorePolicy: boolean;
  /** A retention policy job exists. */
  readonly hasRetentionPolicy: boolean;
}

/** A single detected drift between expected and actual state. */
export interface DriftItem {
  /** The table the drift concerns. */
  readonly table: string;
  /** Human-readable description of the drift. */
  readonly message: string;
}

/**
 * Compare one entity's expectation against the live database, returning a list of
 * drifts (empty when the database matches). Detects only what the entity declares is
 * missing — it does not flag extra policies the database may have beyond the entity.
 */
export function compareHypertable(
  expected: ExpectedHypertable,
  actual: ActualHypertable,
): DriftItem[] {
  const drift: DriftItem[] = [];
  const add = (message: string): void => {
    drift.push({ table: expected.table, message });
  };

  if (!actual.isHypertable) {
    add(`expected a hypertable but "${expected.table}" is not one — run the generated migration`);
    // Without a hypertable, the remaining checks are meaningless.
    return drift;
  }

  if (!actual.dimensionColumns.includes(expected.timeColumn)) {
    add(
      `time column "${expected.timeColumn}" is not a partitioning dimension (found: ${actual.dimensionColumns.join(', ') || 'none'})`,
    );
  }

  if (
    expected.spacePartitionColumn !== undefined &&
    !actual.dimensionColumns.includes(expected.spacePartitionColumn)
  ) {
    add(`space-partition column "${expected.spacePartitionColumn}" is not a dimension`);
  }

  if (expected.expectColumnstorePolicy && !actual.hasColumnstorePolicy) {
    add('columnstore policy is missing');
  }

  if (expected.expectRetentionPolicy && !actual.hasRetentionPolicy) {
    add('retention policy is missing');
  }

  return drift;
}

/** What a `@ContinuousAggregate` declares the database should look like. */
export interface ExpectedContinuousAggregate {
  /** Schema-qualified view name, e.g. `public.reading_hourly` (used in messages). */
  readonly view: string;
  /** `timescaledb.materialized_only` the decorator declares (real-time when false). */
  readonly materializedOnly: boolean;
  /** A refresh policy is expected (the decorator declared `refresh`). */
  readonly expectRefreshPolicy: boolean;
}

/** The relevant live state of a continuous aggregate read from `timescaledb_information.*`. */
export interface ActualContinuousAggregate {
  /** The view exists as a continuous aggregate. */
  readonly exists: boolean;
  /** Its live `materialized_only` flag (meaningful only when `exists`). */
  readonly materializedOnly: boolean;
  /** A refresh-policy job exists for it. */
  readonly hasRefreshPolicy: boolean;
}

/**
 * Compare one `@ContinuousAggregate`'s expectation against the live database. Missing-only
 * semantics, mirroring {@link compareHypertable}: it flags a view that is absent, a
 * `materialized_only` mismatch, or an expected-but-absent refresh policy — it does not flag
 * policies or views the database has beyond what the decorator declares.
 */
export function compareContinuousAggregate(
  expected: ExpectedContinuousAggregate,
  actual: ActualContinuousAggregate,
): DriftItem[] {
  const drift: DriftItem[] = [];
  const add = (message: string): void => {
    drift.push({ table: expected.view, message });
  };

  if (!actual.exists) {
    add(
      `expected a continuous aggregate but "${expected.view}" does not exist — run the generated migration`,
    );
    // Without the view, the remaining checks are meaningless.
    return drift;
  }

  if (expected.materializedOnly !== actual.materializedOnly) {
    add(
      `materialized_only mismatch (expected ${expected.materializedOnly}, found ${actual.materializedOnly})`,
    );
  }

  if (expected.expectRefreshPolicy && !actual.hasRefreshPolicy) {
    add('refresh policy is missing');
  }

  return drift;
}

/** Render drift items as a single human-readable diff block. */
export function formatDrift(drift: readonly DriftItem[]): string {
  if (drift.length === 0) return 'no schema drift';
  return `schema drift detected:\n${drift.map((d) => `  - ${d.table}: ${d.message}`).join('\n')}`;
}

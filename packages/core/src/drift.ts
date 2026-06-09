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

/** Render drift items as a single human-readable diff block. */
export function formatDrift(drift: readonly DriftItem[]): string {
  if (drift.length === 0) return 'no schema drift';
  return `schema drift detected:\n${drift.map((d) => `  - ${d.table}: ${d.message}`).join('\n')}`;
}

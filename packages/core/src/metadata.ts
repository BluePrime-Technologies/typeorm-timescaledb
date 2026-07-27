import { z } from 'zod';
import { assertSafeIdentifier } from './identifier.js';
import { INTERVAL_PATTERN } from './interval.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';

/**
 * Framework-neutral hypertable metadata model + option validation. The TypeORM
 * decorators (and any future ORM binding) capture user intent into this shape;
 * SQL generation and the boot-time validator consume it.
 */

/**
 * A PostgreSQL interval of the form `<n> <unit>`, e.g. `'7 days'`. Validated as an
 * interval (not just a string) because these values are emitted into DDL; callers
 * must still bind/parameterize, never concatenate raw user input.
 */
const Interval = z
  .string()
  .regex(INTERVAL_PATTERN, 'must be a PostgreSQL interval like "7 days" (<n> <unit>)');

const OrderBySchema = z.strictObject({
  column: z.string(),
  direction: z.enum(['ASC', 'DESC']).default('ASC'),
});

/** Hypercore columnstore configuration (the modern name for "compression"). */
export const ColumnstoreOptionsSchema = z.strictObject({
  segmentBy: z.array(z.string()).optional(),
  orderBy: z.array(OrderBySchema).optional(),
  /** Auto-convert chunks to columnstore after this interval, e.g. `'7 days'`. */
  compressAfter: Interval.optional(),
});

export const RetentionOptionsSchema = z.strictObject({
  /** Drop chunks older than this interval, e.g. `'90 days'`. */
  dropAfter: Interval,
});

export const SpacePartitionOptionsSchema = z.strictObject({
  column: z.string(),
  partitions: z.number().int().positive(),
});

export const HypertableOptionsSchema = z.strictObject({
  /** Time/partition column. Optional here when marked with `@TimeColumn` instead. */
  timeColumn: z.string().optional(),
  /** Chunk interval, e.g. `'7 days'`. */
  chunkInterval: Interval.optional(),
  columnstore: ColumnstoreOptionsSchema.optional(),
  retention: RetentionOptionsSchema.optional(),
  spacePartition: SpacePartitionOptionsSchema.optional(),
  /**
   * The hypertable's PREVIOUS physical table name (bare, e.g. `'old_trades'`, or schema-qualified,
   * e.g. `'analytics.old_trades'` — an unqualified value is resolved against the entity's own
   * schema). Declare this the migration after renaming the entity's table so the M4.2 diff engine
   * matches the hypertable by its old identity instead of emitting a drop-then-create (the
   * Prisma/EF anti-pattern) — see `diffSchemaState`'s `renames` option. Remove it once the rename
   * has been applied everywhere the migration will run.
   */
  renamedFrom: z.string().optional(),
});

export type HypertableOptions = z.infer<typeof HypertableOptionsSchema>;
export type ColumnstoreOptions = z.infer<typeof ColumnstoreOptionsSchema>;
export type RetentionOptions = z.infer<typeof RetentionOptionsSchema>;
export type SpacePartitionOptions = z.infer<typeof SpacePartitionOptionsSchema>;

/** Captured hypertable metadata for one entity. */
export interface TimescaleEntityMetadata {
  readonly options: HypertableOptions;
  /** Resolved from `@TimeColumn` (preferred) or `options.timeColumn`. */
  readonly timeColumn?: string;
  /** Columns marked with `@HypertablePrimaryKey` (TimescaleDB requires the time column in the PK). */
  readonly primaryKeyColumns: readonly string[];
}

/** Validate and normalize `@Hypertable` options at decoration time. */
export function parseHypertableOptions(input: unknown): HypertableOptions {
  const result = HypertableOptionsSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_HYPERTABLE_CONFIG,
      `invalid @Hypertable options: ${result.error.message}`,
      { issues: result.error.issues },
    );
  }
  return result.data;
}

/**
 * Validate captured hypertable metadata. Enforces: a time column exists; every
 * identifier that will reach SQL is allow-list-safe; and (TimescaleDB rule) the
 * primary key, if declared, includes the time column.
 */
export function validateHypertableMetadata(
  meta: TimescaleEntityMetadata,
  entityName = 'entity',
): void {
  const timeColumn = meta.timeColumn ?? meta.options.timeColumn;
  if (!timeColumn) {
    throw new TimescaleError(
      TimescaleErrorCode.NO_TIME_COLUMN,
      `@Hypertable ${entityName} declares no time column — mark one with @TimeColumn() or pass { timeColumn }`,
      { entityName },
    );
  }

  // Every dynamic identifier that will be emitted into DDL must be allow-list-safe.
  assertSafeIdentifier(timeColumn, `${entityName}.timeColumn`);
  for (const c of meta.options.columnstore?.segmentBy ?? []) assertSafeIdentifier(c, 'segmentBy');
  for (const o of meta.options.columnstore?.orderBy ?? [])
    assertSafeIdentifier(o.column, 'orderBy');
  if (meta.options.spacePartition) {
    assertSafeIdentifier(meta.options.spacePartition.column, 'spacePartition');
  }
  for (const c of meta.primaryKeyColumns) assertSafeIdentifier(c, 'primaryKey');

  if (meta.primaryKeyColumns.length > 0) {
    // TimescaleDB requires every unique/primary key to contain ALL partitioning
    // columns — the time column and, if present, the space-partition column.
    const partitioningColumns = [timeColumn];
    if (meta.options.spacePartition) partitioningColumns.push(meta.options.spacePartition.column);
    const missing = partitioningColumns.filter((c) => !meta.primaryKeyColumns.includes(c));
    if (missing.length > 0) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_HYPERTABLE_PK,
        `hypertable ${entityName}: primary key [${meta.primaryKeyColumns.join(', ')}] must include all partitioning columns; missing: ${missing.join(', ')}`,
        {
          entityName,
          partitioningColumns,
          missing,
          primaryKeyColumns: [...meta.primaryKeyColumns],
        },
      );
    }
  }
}

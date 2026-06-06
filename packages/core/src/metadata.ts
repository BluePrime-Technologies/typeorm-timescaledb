import { z } from 'zod';
import { assertSafeIdentifier } from './identifier.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';

/**
 * Framework-neutral hypertable metadata model + option validation. The TypeORM
 * decorators (and any future ORM binding) capture user intent into this shape;
 * SQL generation and the boot-time validator consume it.
 */

const OrderBySchema = z.strictObject({
  column: z.string(),
  direction: z.enum(['ASC', 'DESC']).default('ASC'),
});

/** Hypercore columnstore configuration (the modern name for "compression"). */
export const ColumnstoreOptionsSchema = z.strictObject({
  segmentBy: z.array(z.string()).optional(),
  orderBy: z.array(OrderBySchema).optional(),
  /** Auto-convert chunks to columnstore after this interval, e.g. `'7 days'`. */
  compressAfter: z.string().optional(),
});

export const RetentionOptionsSchema = z.strictObject({
  /** Drop chunks older than this interval, e.g. `'90 days'`. */
  dropAfter: z.string(),
});

export const SpacePartitionOptionsSchema = z.strictObject({
  column: z.string(),
  partitions: z.number().int().positive(),
});

export const HypertableOptionsSchema = z.strictObject({
  /** Time/partition column. Optional here when marked with `@TimeColumn` instead. */
  timeColumn: z.string().optional(),
  /** Chunk interval, e.g. `'7 days'`. */
  chunkInterval: z.string().optional(),
  columnstore: ColumnstoreOptionsSchema.optional(),
  retention: RetentionOptionsSchema.optional(),
  spacePartition: SpacePartitionOptionsSchema.optional(),
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

  if (meta.primaryKeyColumns.length > 0 && !meta.primaryKeyColumns.includes(timeColumn)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_HYPERTABLE_PK,
      `hypertable ${entityName}: primary key [${meta.primaryKeyColumns.join(', ')}] must include the time column "${timeColumn}" (TimescaleDB requires every unique/primary key to contain all partitioning columns)`,
      { entityName, timeColumn, primaryKeyColumns: [...meta.primaryKeyColumns] },
    );
  }
}

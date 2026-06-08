import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import {
  addColumnstorePolicySQL,
  addRetentionPolicySQL,
  createHypertableSQL,
  TimescaleError,
  TimescaleErrorCode,
  validateHypertableMetadata,
  type MigrationStatement,
} from '@blueprime-technologies/timescaledb-core';
import { getTimescaleMetadata, hasTimescaleMetadata } from '../decorators/index.js';

type Ctor = abstract new (...args: never[]) => unknown;

/** A reversible TimescaleDB migration generated from `@Hypertable` metadata. */
export interface GeneratedMigration {
  /** TypeORM migration class name, e.g. `Timescale1700000000000`. */
  readonly name: string;
  /** Timestamp embedded in the name — also TypeORM's ordering key. */
  readonly timestamp: number;
  /** Atomic `up` statements, in apply order. */
  readonly up: readonly string[];
  /** Atomic `down` statements — the reverse of `up`, never destructive. */
  readonly down: readonly string[];
}

export interface GenerateMigrationOptions {
  /** Class-name prefix (must be a valid identifier). Default `'Timescale'`. */
  readonly name?: string;
  /** Override the timestamp (for reproducible output / tests). Default `Date.now()`. */
  readonly timestamp?: number;
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Generate a TimescaleDB migration from the `@Hypertable` entities registered on a
 * DataSource. For each hypertable entity it emits, in order:
 *   1. `create_hypertable` (+ `add_dimension` for a space partition),
 *   2. columnstore enable (+ `add_columnstore_policy`) if `columnstore` is set,
 *   3. `add_retention_policy` if `retention` is set,
 * and the exact reverse — non-destructive — as `down`.
 *
 * Entities are processed in a deterministic order (by table name) so regenerating
 * an unchanged schema yields identical SQL. This is migration-driven: the output is
 * a reviewable artifact you commit; nothing is applied here and `synchronize` is
 * never used.
 *
 * The DataSource must have its metadata built (it is read via `entityMetadatas`),
 * but it does not need an open connection.
 *
 * Schema: an entity without an explicit schema (`@Entity({ schema })` or
 * `DataSource` `schema` option) is pinned to `public` so the migration is
 * deterministic rather than `search_path`-dependent. If you use a non-`public`
 * schema, set it explicitly so the generated DDL targets the same tables.
 */
export function generateTimescaleMigration(
  dataSource: DataSource,
  options: GenerateMigrationOptions = {},
): GeneratedMigration {
  const base = options.name ?? 'Timescale';
  if (!VALID_NAME.test(base)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `migration name prefix must be a valid identifier, got: ${base}`,
      { name: base },
    );
  }
  const timestamp = options.timestamp ?? Date.now();
  // TypeORM's migration executor derives ordering from `parseInt(className.slice(-13))`
  // and rejects names whose last 13 chars aren't a number — so the timestamp must be a
  // 13-digit (JS millisecond) integer, which `Date.now()` already is.
  if (
    !Number.isInteger(timestamp) ||
    timestamp < 1_000_000_000_000 ||
    timestamp > 9_999_999_999_999
  ) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `timestamp must be a 13-digit millisecond integer (TypeORM parses the last 13 chars of the migration name as its ordering key), got: ${String(timestamp)}`,
      { timestamp },
    );
  }

  const hypertables = dataSource.entityMetadatas
    .filter((em) => typeof em.target === 'function' && hasTimescaleMetadata(em.target as Ctor))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));

  const up: string[] = [];
  const down: string[] = [];

  for (const em of hypertables) {
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
        { table: em.tableName },
      );
    }

    // Decorators capture the entity PROPERTY name; the DDL must reference the physical
    // column. Map property -> databaseName so `@Column({ name })` overrides resolve
    // correctly (falls back to the name as-is when no column metadata is present).
    const dbColumn = new Map<string, string>(
      (em.columns ?? []).map((c) => [c.propertyName, c.databaseName]),
    );
    const toDb = (property: string): string => dbColumn.get(property) ?? property;

    const table = em.schema ? `${em.schema}.${em.tableName}` : em.tableName;
    const space = meta.options.spacePartition;
    const statements: MigrationStatement[] = [
      createHypertableSQL({
        table,
        timeColumn: toDb(timeColumn),
        ...(meta.options.chunkInterval !== undefined && {
          chunkInterval: meta.options.chunkInterval,
        }),
        ...(space !== undefined && {
          spacePartition: { column: toDb(space.column), partitions: space.partitions },
        }),
      }),
    ];

    const columnstore = meta.options.columnstore;
    if (columnstore) {
      statements.push(
        addColumnstorePolicySQL({
          table,
          ...(columnstore.segmentBy !== undefined && {
            segmentBy: columnstore.segmentBy.map(toDb),
          }),
          ...(columnstore.orderBy !== undefined && {
            orderBy: columnstore.orderBy.map((o) => ({
              column: toDb(o.column),
              direction: o.direction,
            })),
          }),
          ...(columnstore.compressAfter !== undefined && {
            after: columnstore.compressAfter,
          }),
        }),
      );
    }

    if (meta.options.retention) {
      statements.push(
        addRetentionPolicySQL({ table, dropAfter: meta.options.retention.dropAfter }),
      );
    }

    for (const s of statements) up.push(...s.up);
    // Reverse builder order so the most-recently-applied change is undone first.
    for (const s of [...statements].reverse()) down.push(...s.down);
  }

  return { name: `${base}${timestamp}`, timestamp, up, down };
}

/** Render a {@link GeneratedMigration} as TypeORM migration TypeScript source. */
export function renderTimescaleMigration(migration: GeneratedMigration): string {
  const body = (statements: readonly string[]): string =>
    statements.length === 0
      ? '    // no-op'
      : statements.map((sql) => `    await queryRunner.query(${JSON.stringify(sql)});`).join('\n');

  return `// Generated by typeorm-timescaledb — regenerate rather than editing by hand.
// down() is intentionally non-destructive: hypertable and columnstore conversions
// are NOT reverted (that would drop/decompress data); only policies are removed.
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ${migration.name} implements MigrationInterface {
  name = '${migration.name}';

  public async up(queryRunner: QueryRunner): Promise<void> {
${body(migration.up)}
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
${body(migration.down)}
  }
}
`;
}

/**
 * Materialize a {@link GeneratedMigration} as a runnable TypeORM `MigrationInterface`,
 * for programmatic use without writing a file. Each statement runs in its own query.
 */
export function createTimescaleMigration(migration: GeneratedMigration): MigrationInterface {
  return {
    name: migration.name,
    async up(queryRunner: QueryRunner): Promise<void> {
      for (const sql of migration.up) await queryRunner.query(sql);
    },
    async down(queryRunner: QueryRunner): Promise<void> {
      for (const sql of migration.down) await queryRunner.query(sql);
    },
  };
}

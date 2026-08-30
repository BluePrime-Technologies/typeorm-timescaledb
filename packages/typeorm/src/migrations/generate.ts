import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { resolveContinuousAggregates } from '../runtime/cagg-resolve.js';
import {
  compileOperation,
  compileOperations,
  compilePlan,
  TimescaleError,
  TimescaleErrorCode,
  validateHypertableMetadata,
  type Operation,
  type Plan,
} from '@blueprime/timescaledb-core';
import {
  getTimescaleMetadata,
  hasTimescaleMetadata,
  assertTypeOrmPrimaryKeyIncludesPartitioning,
} from '../decorators/index.js';

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
  /**
   * `@ContinuousAggregate` classes to emit CAGG DDL for, after the hypertables. They are
   * NOT TypeORM entities (a CAGG is a view, not a table), so they can't be discovered
   * from `entityMetadatas` — pass them explicitly. Each CAGG's `source` must be a
   * `@Hypertable` entity registered on the DataSource.
   */
  readonly continuousAggregates?: ReadonlyArray<Ctor>;
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve and validate a migration class name + ordering timestamp, shared by every generator
 * ({@link generateTimescaleMigration} desired-state, {@link planToMigration} diff-based). The prefix
 * must be a valid identifier; the timestamp must be a 13-digit millisecond integer because TypeORM's
 * executor derives ordering from `parseInt(className.slice(-13))` and rejects non-numeric tails.
 */
function resolveMigrationName(
  base: string,
  timestampOpt?: number,
): { readonly name: string; readonly timestamp: number } {
  if (!VALID_NAME.test(base)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `migration name prefix must be a valid identifier, got: ${base}`,
      { name: base },
    );
  }
  const timestamp = timestampOpt ?? Date.now();
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
  return { name: `${base}${timestamp}`, timestamp };
}

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
 * The DataSource must be **initialized** (`await dataSource.initialize()`) before
 * calling this — entity metadata is read via `entityMetadatas`, which is empty until
 * then. Generating from an uninitialized DataSource throws rather than silently
 * producing a no-op migration.
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
  const { name, timestamp } = resolveMigrationName(options.name ?? 'Timescale', options.timestamp);

  // entityMetadatas is empty until initialize() builds it; fail loudly rather than
  // silently emitting an empty migration when configured hypertables exist.
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before generating a migration — entityMetadatas is empty otherwise',
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
    // Catch a plain TypeORM @PrimaryColumn key that omits a partitioning column at codegen time,
    // not at migration-run time with a raw Postgres error (partitioning columns are property names).
    assertTypeOrmPrimaryKeyIncludesPartitioning(em, [timeColumn, ...(space ? [space.column] : [])]);
    // Build the per-hypertable operation IR (M4.1), then compile it through the single SQL
    // choke point. Ordering + up/down assembly stay HERE (not in the compile core).
    const operations: Operation[] = [
      {
        kind: 'createHypertable',
        table,
        timeColumn: toDb(timeColumn),
        ...(meta.options.chunkInterval !== undefined && {
          chunkInterval: meta.options.chunkInterval,
        }),
        ...(space !== undefined && {
          spacePartition: { column: toDb(space.column), partitions: space.partitions },
        }),
      },
    ];

    const columnstore = meta.options.columnstore;
    if (columnstore) {
      operations.push({
        kind: 'addColumnstorePolicy',
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
      });
    }

    if (meta.options.retention) {
      operations.push({
        kind: 'addRetentionPolicy',
        table,
        dropAfter: meta.options.retention.dropAfter,
      });
    }

    const statements = compileOperations(operations);
    for (const s of statements) up.push(...s.up);
    // Reverse builder order so the most-recently-applied change is undone first.
    for (const s of [...statements].reverse()) down.push(...s.down);
  }

  // Continuous aggregates, after the hypertables (a CAGG needs its source to exist).
  // Their `up` is appended after the hypertable `up`; their `down` is prepended before it.
  const caggUp: string[] = [];
  const caggDown: string[] = [];
  // Order the CAGGs so a hierarchical parent (whose source is another CAGG in this set) is
  // created AFTER its child. Independent CAGGs keep a deterministic view-name order. The
  // per-CAGG `down` is `unshift`ed below, so this ordering also drops parents before children.
  for (const resolved of resolveContinuousAggregates(
    dataSource,
    options.continuousAggregates ?? [],
  )) {
    const meta = resolved.meta;
    const stmt = compileOperation({ kind: 'createContinuousAggregate', ...resolved.create });
    caggUp.push(...stmt.up);
    // Per-CAGG down: DROP the view (reversed relative to `up`). A refresh policy, if any,
    // is removed BEFORE the DROP (true reverse of "create then add policy").
    const caggThisDown: string[] = [...stmt.down];

    if (meta.refresh) {
      // Always pass schedule_interval (default = the bucket width): TimescaleDB 2.18, our
      // supported floor, has no `add_continuous_aggregate_policy` overload that omits it.
      const policy = compileOperation({
        kind: 'addContinuousAggregatePolicy',
        ...resolved.refresh!,
      });
      caggUp.push(...policy.up); // add policy AFTER the CREATE MATERIALIZED VIEW
      caggThisDown.unshift(...policy.down); // remove policy BEFORE the DROP
    }

    // Prepend each CAGG's down block so the overall CAGG teardown is the exact reverse of
    // creation order (the CAGG created last is dropped first) while keeping remove-policy
    // before DROP within each. Matters once CAGGs can depend on each other (hierarchical).
    caggDown.unshift(...caggThisDown);
  }
  up.push(...caggUp);
  down.unshift(...caggDown);

  return { name, timestamp, up, down };
}

/** Options for {@link planToMigration} — just the name/timestamp knobs (no CAGG discovery: a diff
 * {@link Plan} already carries every operation, including CAGGs, so nothing is discovered here). */
export interface PlanMigrationOptions {
  /** Class-name prefix (must be a valid identifier). Default `'Timescale'`. */
  readonly name?: string;
  /** Override the timestamp (for reproducible output / tests). Default `Date.now()`. */
  readonly timestamp?: number;
}

/**
 * Turn a diff {@link Plan} (from `diffSchemaState`) into a {@link GeneratedMigration} — the bridge
 * that makes the M4.2 diff engine's output committable (today a `Plan` is only previewable via the
 * `check` verb). Delegates the SQL to the core `compilePlan` choke point: `up` in step order, `down`
 * each step's own reversible inverse with the step sequence reversed (never destructive).
 *
 * Unlike {@link generateTimescaleMigration} (which derives a desired-state migration from decorators),
 * this consumes a ready plan verbatim and does not touch a DataSource — the caller owns diffing.
 */
export function planToMigration(
  plan: Plan,
  options: PlanMigrationOptions = {},
): GeneratedMigration {
  const { name, timestamp } = resolveMigrationName(options.name ?? 'Timescale', options.timestamp);
  const { up, down } = compilePlan(plan);
  return { name, timestamp, up, down };
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
 * Render a {@link GeneratedMigration} as a raw `.sql` artifact — the `output: 'sql'` emit target. Two
 * sections (`-- Up` / `-- Down`), one statement per line, so it's reviewable and runnable through psql
 * or any plain-SQL migration runner. The core builders already emit each statement WITH its trailing
 * `;`, so statements are written verbatim (appending another `;` would double-terminate). An empty
 * section is a `-- no-op` comment. Same non-destructive-`down` contract as
 * {@link renderTimescaleMigration}; the compiled SQL is identical (both go through the single core
 * choke point) — only the wrapper differs.
 */
export function renderTimescaleMigrationSql(migration: GeneratedMigration): string {
  // Builders already terminate each statement with `;`; guard defensively so a hypothetical
  // unterminated statement is still terminated, without ever double-terminating (`;;`).
  const terminate = (sql: string): string => (sql.endsWith(';') ? sql : `${sql};`);
  // Each section runs as ONE transaction.
  //
  // psql is autocommit, so without this every statement committed independently and a failure
  // halfway through left the database in a state no `down` describes. That is tolerable for
  // additive policy work and NOT tolerable for a continuous-aggregate recreate, whose `up` is
  // `DROP` followed by `CREATE`: a CREATE that fails after the DROP succeeded leaves the aggregate
  // permanently gone rather than merely emptied.
  //
  // The other two emit paths already had this. `applyDirect` opens a transaction by default
  // (`runtime/apply.ts`), and TypeORM wraps `.ts` migrations in one — so the raw artifact was the
  // only path without it, which is also the one run by hand under the most pressure.
  //
  // Safe for everything this emitter can produce: the whole Operation union is DDL and policy
  // calls, all of which already run inside `applyDirect`'s transaction in the integration suite.
  // `CALL refresh_continuous_aggregate(...)` genuinely cannot run in a transaction block — it is
  // deliberately NOT an Operation, and must stay out of this path.
  const section = (statements: readonly string[]): string =>
    statements.length === 0
      ? '-- no-op'
      : ['BEGIN;', ...statements.map(terminate), 'COMMIT;'].join('\n');

  return `-- Generated by typeorm-timescaledb — regenerate rather than editing by hand.
-- Migration: ${migration.name}
-- Each section is wrapped in a transaction: a failure part-way through rolls the
-- whole section back rather than leaving a half-applied schema. This matters most
-- for a continuous-aggregate recreate, whose up is DROP followed by CREATE.
-- down is intentionally non-destructive: hypertable and columnstore conversions
-- are NOT reverted (that would drop/decompress data); only policies are removed.

-- Up
${section(migration.up)}

-- Down
${section(migration.down)}
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

import { assertSafeIdentifier, quoteIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { assertInterval, assertPositiveInterval } from '../interval.js';
import { TimescaleError, TimescaleErrorCode } from '../errors.js';

/**
 * Pure SQL builders for TimescaleDB hypertable DDL. No database access — each
 * function returns ready-to-run SQL. They are the single source of truth for the
 * exact DDL the migration generator (T4b) and CLI (T4c) emit.
 *
 * Target: TimescaleDB **≥ 2.18** (the columnstore DDL — `enable_columnstore`,
 * `add_columnstore_policy`; 2.17 and earlier had only the legacy compression
 * syntax). Verified against the latest stable line (2.27).
 *
 * Safety: every table/column flows through {@link assertSafeIdentifier}; values in
 * identifier position are quoted with {@link quoteIdent}, values in string-literal
 * position with {@link quoteLiteral}; intervals are validated with {@link assertInterval}.
 */

/**
 * Catalog query: number of rows is the `timescaledb`-installed flag (0 = missing).
 * Mirrors {@link import('./toolkit.js').TOOLKIT_PRESENCE_SQL} but for the base
 * `timescaledb` extension rather than `timescaledb_toolkit`.
 */
export const TIMESCALEDB_PRESENCE_SQL = "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'";

/** A reversible, inspectable unit of hypertable DDL. */
export interface MigrationStatement {
  /**
   * Atomic SQL statements that apply the change, in order. Each entry is a single
   * statement (run it with its own `queryRunner.query(...)` call — TimescaleDB/pg
   * reject multiple commands in one prepared query).
   */
  readonly up: readonly string[];
  /**
   * Atomic SQL statements that reverse the change — **never destroys data**.
   * Policies are removed (`if_exists => TRUE`); a hypertable conversion and an
   * enabled columnstore are left in place (reverting them would drop/decompress
   * data) with a `RAISE NOTICE`.
   */
  readonly down: readonly string[];
  /**
   * Read-only SQL that reports the current applied state (for tests / drift checks).
   *
   * @experimental The exact catalog views/columns (notably the policy `proc_name`
   * in `timescaledb_information.jobs`) are confirmed against a live TimescaleDB
   * catalog in T4d's integration tests; treat the `inspect` shape as unstable
   * until then.
   */
  readonly inspect: string;
}

/** @internal — shared across core SQL builders; not part of the public API surface. */
export interface ParsedTable {
  /** Schema name; defaults to `public` when the table is unqualified. */
  readonly schema: string;
  /** Bare table name. */
  readonly name: string;
  /** Quoted identifier form, e.g. `"public"."metrics"` (for `ALTER TABLE …`). */
  readonly ident: string;
  /** `regclass` string-literal form, e.g. `'"public"."metrics"'` (for `create_hypertable('…')`). */
  readonly regclass: string;
}

/**
 * Parse and validate a possibly schema-qualified table name. Migrations are
 * deterministic, so an unqualified name is pinned to the `public` schema rather
 * than left to `search_path`.
 */
/** @internal — shared across core SQL builders; not part of the public API surface. */
export function parseTable(table: string): ParsedTable {
  if (typeof table !== 'string' || table.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'table must be a non-empty string',
    );
  }
  const parts = table.split('.');
  if (parts.length > 2) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `table must be "name" or "schema.name", got: ${table}`,
      { table },
    );
  }
  // `?? ''` makes a malformed part (e.g. "a." or ".b") fail the allow-list cleanly.
  const schema =
    parts.length === 2 ? assertSafeIdentifier(parts[0] ?? '', 'table schema') : 'public';
  const name = assertSafeIdentifier(parts[parts.length - 1] ?? '', 'table name');
  const ident = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  return { schema, name, ident, regclass: quoteLiteral(ident) };
}

/** A no-op `down` that documents why the `up` is intentionally not reversed. */
function nonDestructiveNotice(reason: string, tableIdent: string): string {
  return `DO $$ BEGIN RAISE NOTICE ${quoteLiteral(`timescaledb: not reverting ${reason} on % — reverting would lose data (non-destructive down)`)}, ${quoteLiteral(tableIdent)}; END $$;`;
}

export interface CreateHypertableInput {
  /** Table name, optionally `schema.table` (defaults to the `public` schema). */
  readonly table: string;
  /** The time/partition column. */
  readonly timeColumn: string;
  /** Chunk interval, e.g. `'7 days'`. Omit to use TimescaleDB's default. */
  readonly chunkInterval?: string;
  /** Optional secondary hash (space) partition. */
  readonly spacePartition?: { readonly column: string; readonly partitions: number };
  /** `if_not_exists` — make `up` idempotent. Default `true`. */
  readonly ifNotExists?: boolean;
  /** `migrate_data` — move existing rows into chunks. Default `false` (fast; fails if the table is non-empty). */
  readonly migrateData?: boolean;
}

/**
 * Convert an existing (TypeORM-created) table into a hypertable using the modern
 * dimension-builder API: `create_hypertable(relation, by_range(time, INTERVAL …))`.
 *
 * `down` is a non-destructive no-op: TimescaleDB cannot demote a hypertable back to
 * a plain table without dropping data, so it only raises a NOTICE.
 */
export function createHypertableSQL(input: CreateHypertableInput): MigrationStatement {
  const t = parseTable(input.table);
  const timeColumn = assertSafeIdentifier(input.timeColumn, 'timeColumn');
  const ifNotExists = input.ifNotExists ?? true;
  const migrateData = input.migrateData ?? false;

  if (input.spacePartition && migrateData) {
    // add_dimension requires an empty hypertable; with migrateData the table is
    // populated by create_hypertable first, so the add_dimension below would fail.
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'spacePartition cannot be combined with migrateData: add_dimension requires an empty hypertable — add the space dimension before loading data (or in a separate migration on an empty table)',
      { table: input.table },
    );
  }

  const range =
    input.chunkInterval === undefined
      ? `by_range(${quoteLiteral(timeColumn)})`
      : `by_range(${quoteLiteral(timeColumn)}, INTERVAL ${quoteLiteral(assertPositiveInterval(input.chunkInterval, 'chunkInterval'))})`;

  const up: string[] = [
    `SELECT create_hypertable(${t.regclass}, ${range}` +
      `, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'}` +
      `, migrate_data => ${migrateData ? 'TRUE' : 'FALSE'});`,
  ];

  if (input.spacePartition) {
    const col = assertSafeIdentifier(input.spacePartition.column, 'spacePartition.column');
    if (
      !Number.isInteger(input.spacePartition.partitions) ||
      input.spacePartition.partitions <= 0
    ) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        'spacePartition.partitions must be a positive integer',
        { partitions: input.spacePartition.partitions },
      );
    }
    up.push(
      `SELECT add_dimension(${t.regclass}, by_hash(${quoteLiteral(col)}, ${input.spacePartition.partitions})` +
        `, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'});`,
    );
  }

  const inspect =
    `SELECT hypertable_schema, hypertable_name, num_dimensions FROM timescaledb_information.hypertables ` +
    `WHERE hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`;

  return { up, down: [nonDestructiveNotice('hypertable', t.ident)], inspect };
}

export interface ColumnstorePolicyInput {
  /** Table name, optionally `schema.table`. */
  readonly table: string;
  /** Columns to segment by (groups rows in the columnstore). */
  readonly segmentBy?: readonly string[];
  /** Columns to order by within a segment. */
  readonly orderBy?: ReadonlyArray<{
    readonly column: string;
    readonly direction?: 'ASC' | 'DESC';
  }>;
  /** Auto-convert chunks to the columnstore after this interval, e.g. `'7 days'`. Omit to enable the columnstore without a policy. */
  readonly after?: string;
  /** `if_not_exists` on the policy — make `up` idempotent. Default `true`. */
  readonly ifNotExists?: boolean;
}

/**
 * Enable the columnstore on a hypertable and (optionally) add a policy that
 * auto-converts chunks after `after`.
 *
 * `down` removes the policy only (`remove_columnstore_policy`, `if_exists`). The
 * columnstore is intentionally left enabled — disabling it would require
 * decompressing existing chunks, so it is not reversed automatically.
 */
export function addColumnstorePolicySQL(input: ColumnstorePolicyInput): MigrationStatement {
  const t = parseTable(input.table);

  // TimescaleDB parses the segmentby/orderby reloption strings as identifier lists
  // (case-folding unquoted names), so each column is double-quoted to preserve the
  // exact, possibly mixed-case, name — matching the columns TypeORM created.
  const options: string[] = ['timescaledb.enable_columnstore = true'];
  if (input.segmentBy && input.segmentBy.length > 0) {
    const cols = input.segmentBy
      .map((c) => quoteIdent(assertSafeIdentifier(c, 'segmentBy')))
      .join(', ');
    options.push(`timescaledb.segmentby = ${quoteLiteral(cols)}`);
  }
  if (input.orderBy && input.orderBy.length > 0) {
    const cols = input.orderBy
      .map(
        (o) => `${quoteIdent(assertSafeIdentifier(o.column, 'orderBy'))} ${o.direction ?? 'ASC'}`,
      )
      .join(', ');
    options.push(`timescaledb.orderby = ${quoteLiteral(cols)}`);
  }

  const up: string[] = [`ALTER TABLE ${t.ident} SET (${options.join(', ')});`];
  let down: string[];

  if (input.after === undefined) {
    down = [nonDestructiveNotice('columnstore', t.ident)];
  } else {
    const ifNotExists = input.ifNotExists ?? true;
    up.push(
      `CALL add_columnstore_policy(${t.regclass}, after => INTERVAL ${quoteLiteral(assertInterval(input.after, 'after'))}, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'});`,
    );
    down = [`CALL remove_columnstore_policy(${t.regclass}, if_exists => TRUE);`];
  }

  // proc_name verified against a live catalog in T4d.
  const inspect =
    `SELECT job_id, proc_name, schedule_interval, config FROM timescaledb_information.jobs ` +
    `WHERE proc_name = 'policy_compression' AND hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`;

  return { up, down, inspect };
}

export interface RetentionPolicyInput {
  /** Table name, optionally `schema.table`. */
  readonly table: string;
  /** Drop chunks older than this interval, e.g. `'90 days'`. */
  readonly dropAfter: string;
  /** `if_not_exists` on the policy — make `up` idempotent. Default `true`. */
  readonly ifNotExists?: boolean;
}

/**
 * Add a data-retention policy that drops chunks older than `dropAfter`.
 *
 * `down` removes the policy (`remove_retention_policy`, `if_exists`) — it only
 * stops future drops and never deletes existing data.
 */
export function addRetentionPolicySQL(input: RetentionPolicyInput): MigrationStatement {
  const t = parseTable(input.table);
  const ifNotExists = input.ifNotExists ?? true;

  const up = [
    `SELECT add_retention_policy(${t.regclass}, drop_after => INTERVAL ${quoteLiteral(assertInterval(input.dropAfter, 'dropAfter'))}, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'});`,
  ];
  const down = [`SELECT remove_retention_policy(${t.regclass}, if_exists => TRUE);`];

  // proc_name verified against a live catalog in T4d.
  const inspect =
    `SELECT job_id, proc_name, schedule_interval, config FROM timescaledb_information.jobs ` +
    `WHERE proc_name = 'policy_retention' AND hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`;

  return { up, down, inspect };
}

import { assertSafeIdentifier, quoteIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { assertParsableInterval, isShortening } from '../normalize.js';
import { TimescaleError, TimescaleErrorCode } from '../errors.js';

/**
 * Validate a columnstore `orderby` direction against the `ASC`/`DESC` allow-list. The value is
 * typed `'ASC'|'DESC'` but these builders are the standalone runtime boundary (a JS/`any` caller
 * can pass anything), and the direction is inlined into the reloption — so an arbitrary string
 * would emit a malformed `timescaledb.orderby` that fails opaquely at PG. Fail fast instead.
 */
function orderByDirection(direction: string | undefined): 'ASC' | 'DESC' {
  const value = direction ?? 'ASC';
  if (value !== 'ASC' && value !== 'DESC') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `orderBy direction must be "ASC" or "DESC", got: ${String(direction)}`,
      { role: 'orderBy direction', value: String(direction) },
    );
  }
  return value;
}

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

/**
 * Dollar-quote tag for the generated `DO` blocks. A bare `$$` is unusable here: `$` is a legal
 * PostgreSQL identifier character (and is allowed by `assertSafeIdentifier`), so a table like
 * `a$$b` renders a `$$` INSIDE the block body. PostgreSQL's dollar-quote lexer ignores single
 * quotes and closes the body at the first `$$`, making the whole statement a syntax error — the
 * generated `down()` could not be executed at all. A named tag is only terminated by that exact
 * delimiter.
 */
const DO_TAG = '$tsdb_notice$';

/** A no-op `down` that documents why the `up` is intentionally not reversed. */
export function nonDestructiveNotice(reason: string, tableIdent: string): string {
  const body = `BEGIN RAISE NOTICE ${quoteLiteral(`timescaledb: not reverting ${reason} on % — reverting would lose data (non-destructive down)`)}, ${quoteLiteral(tableIdent)}; END`;
  if (body.includes(DO_TAG)) {
    // Unreachable for any allow-listed identifier, but never emit a block the tag cannot close.
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `identifier contains the reserved dollar-quote tag ${DO_TAG}`,
      { table: tableIdent },
    );
  }
  return `DO ${DO_TAG} ${body} ${DO_TAG};`;
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
      : `by_range(${quoteLiteral(timeColumn)}, INTERVAL ${quoteLiteral(assertParsableInterval(input.chunkInterval, 'chunkInterval', { positive: true }))})`;

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

export interface RenameTableInput {
  /** The hypertable's current (before) table name, optionally `schema.table`. */
  readonly from: string;
  /** The hypertable's new (after) table name, optionally `schema.table` — must be the SAME schema
   * as `from` (a cross-schema move needs `ALTER TABLE ... SET SCHEMA`, which this does not emit). */
  readonly to: string;
}

/**
 * Rename a hypertable's underlying table (`ALTER TABLE ... RENAME TO ...`). TimescaleDB updates the
 * hypertable catalog (and dependent chunks/CAGGs) automatically on a standard table rename — this is
 * a catalog-only, near-instant metadata change, not a data rewrite.
 *
 * `down` renames back to `from`, so it is cleanly, losslessly reversible (unlike every other
 * destructive/irreversible builder in this module).
 */
export function renameHypertableSQL(input: RenameTableInput): MigrationStatement {
  const from = parseTable(input.from);
  const to = parseTable(input.to);
  if (from.schema !== to.schema) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `renaming a hypertable across schemas is not supported (${from.ident} -> ${to.ident}) — use a schema-move migration instead`,
      { from: input.from, to: input.to },
    );
  }
  if (from.name === to.name) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `renamedFrom must differ from the current table name (${from.ident})`,
      { table: input.from },
    );
  }

  const up = [`ALTER TABLE ${from.ident} RENAME TO ${quoteIdent(to.name)};`];
  const down = [`ALTER TABLE ${to.ident} RENAME TO ${quoteIdent(from.name)};`];
  const inspect =
    `SELECT hypertable_schema, hypertable_name FROM timescaledb_information.hypertables ` +
    `WHERE hypertable_schema = ${quoteLiteral(to.schema)} AND hypertable_name = ${quoteLiteral(to.name)};`;

  return { up, down, inspect };
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
        (o) =>
          `${quoteIdent(assertSafeIdentifier(o.column, 'orderBy'))} ${orderByDirection(o.direction)}`,
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
      `CALL add_columnstore_policy(${t.regclass}, after => INTERVAL ${quoteLiteral(assertParsableInterval(input.after, 'after', { nonNegative: true }))}, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'});`,
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
  /**
   * Drop chunks older than this interval, e.g. `'90 days'`.
   *
   * ⚠️ A zero interval (`'0 days'`) is a valid shape and is accepted here — it installs a policy
   * that drops every chunk older than *now*, i.e. effectively all data on each run. This is a
   * deliberate footgun (zero is meaningful for other policies), so pass a positive interval unless
   * you truly intend continuous full-drop.
   */
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
    `SELECT add_retention_policy(${t.regclass}, drop_after => INTERVAL ${quoteLiteral(assertParsableInterval(input.dropAfter, 'dropAfter', { nonNegative: true }))}, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'});`,
  ];
  const down = [`SELECT remove_retention_policy(${t.regclass}, if_exists => TRUE);`];

  // proc_name verified against a live catalog in T4d.
  const inspect =
    `SELECT job_id, proc_name, schedule_interval, config FROM timescaledb_information.jobs ` +
    `WHERE proc_name = 'policy_retention' AND hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`;

  return { up, down, inspect };
}

// SQL fragments shared by the compression-policy add/alter builders (M4.2 AS2). The columnstore must
// already be enabled on the hypertable — these manage only the auto-convert POLICY job, never the
// `ALTER TABLE ... SET (timescaledb.enable_columnstore)` (that stays put; see addColumnstorePolicySQL).
function compressionPolicyInspect(t: ParsedTable): string {
  return (
    `SELECT job_id, proc_name, schedule_interval, config FROM timescaledb_information.jobs ` +
    `WHERE proc_name = 'policy_compression' AND hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`
  );
}
const removeCompressionPolicyCall = (t: ParsedTable): string =>
  `CALL remove_columnstore_policy(${t.regclass}, if_exists => TRUE);`;
const addCompressionPolicyCall = (
  t: ParsedTable,
  after: string,
  ifNotExists: boolean,
  scheduleInterval?: string,
): string =>
  `CALL add_columnstore_policy(${t.regclass}, after => INTERVAL ${quoteLiteral(after)}, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'}${scheduleArg(scheduleInterval)});`;
const removeRetentionPolicyCall = (t: ParsedTable): string =>
  `SELECT remove_retention_policy(${t.regclass}, if_exists => TRUE);`;
const scheduleArg = (scheduleInterval: string | undefined): string =>
  scheduleInterval === undefined
    ? ''
    : `, schedule_interval => INTERVAL ${quoteLiteral(scheduleInterval)}`;

const addRetentionPolicyCall = (
  t: ParsedTable,
  dropAfter: string,
  ifNotExists: boolean,
  scheduleInterval?: string,
): string =>
  `SELECT add_retention_policy(${t.regclass}, drop_after => INTERVAL ${quoteLiteral(dropAfter)}, if_not_exists => ${ifNotExists ? 'TRUE' : 'FALSE'}${scheduleArg(scheduleInterval)});`;

export interface AddCompressionPolicyInput {
  /** Table name, optionally `schema.table`. The columnstore must already be enabled. */
  readonly table: string;
  /** Auto-convert chunks to the columnstore after this interval, e.g. `'7 days'`. */
  readonly after: string;
  /** `if_not_exists` on the policy — make `up` idempotent. Default `true`. */
  readonly ifNotExists?: boolean;
}

/**
 * Add ONLY the compression (columnstore) policy job to a hypertable whose columnstore is already
 * enabled — unlike {@link addColumnstorePolicySQL}, it does not re-assert `ALTER TABLE ... SET`. Used
 * to close the "columnstore enabled but no compression policy" drift. `down` removes the policy
 * (`remove_columnstore_policy`, `if_exists`); it never disables the columnstore or touches data.
 */
export function addCompressionPolicySQL(input: AddCompressionPolicyInput): MigrationStatement {
  const t = parseTable(input.table);
  const after = assertParsableInterval(input.after, 'after', { nonNegative: true });
  const ifNotExists = input.ifNotExists ?? true;
  return {
    up: [addCompressionPolicyCall(t, after, ifNotExists)],
    down: [removeCompressionPolicyCall(t)],
    inspect: compressionPolicyInspect(t),
  };
}

export interface AlterPolicyInput {
  /** Table name, optionally `schema.table`. */
  readonly table: string;
  /** The current threshold interval (for `down` — restore the prior policy). */
  readonly from: string;
  /** The desired threshold interval (for `up` — the new policy). */
  readonly to: string;
  /**
   * The job's current `schedule_interval`. These builders REMOVE then re-ADD the policy, which
   * creates a fresh job at TimescaleDB's default cadence — silently discarding a cadence the user
   * tuned with `alter_job`, and not restoring it on `down` either. Pass the introspected value to
   * preserve it on both sides. Omit only when the job is known to use the default.
   */
  readonly scheduleInterval?: string;
}

export interface SetChunkIntervalInput {
  /** Table name, optionally `schema.table`. */
  readonly table: string;
  /** The current time-dimension chunk interval (for `down`). */
  readonly from: string;
  /** The desired time-dimension chunk interval (for `up`). */
  readonly to: string;
}

/**
 * Change the time (range) dimension's chunk interval via `set_chunk_time_interval`. This affects only
 * FUTURE chunks — existing chunks keep their size — so it rewrites no data and is online-safe; `down`
 * restores the prior interval. Uses the two-argument form, which targets the hypertable's primary
 * time/range dimension.
 */
export function setChunkIntervalSQL(input: SetChunkIntervalInput): MigrationStatement {
  const t = parseTable(input.table);
  // `from` originates from introspection (Postgres output form — may be `HH:MM:SS` for a sub-day
  // interval), so accept any parseable interval form, not just `<n> <unit>`; still require positivity.
  const to = assertParsableInterval(input.to, 'to', { positive: true });
  const from = assertParsableInterval(input.from, 'from', { positive: true });
  const setInterval = (iv: string): string =>
    `SELECT set_chunk_time_interval(${t.regclass}, INTERVAL ${quoteLiteral(iv)});`;
  const inspect =
    `SELECT time_interval FROM timescaledb_information.dimensions ` +
    `WHERE hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)} ` +
    `AND dimension_type = 'Time' ORDER BY dimension_number LIMIT 1;`;
  return { up: [setInterval(to)], down: [setInterval(from)], inspect };
}

/** A columnstore's segment-by + order-by configuration (the diffable content of the columnstore). */
export interface ColumnstoreConfig {
  readonly segmentBy: readonly string[];
  readonly orderBy: ReadonlyArray<{ readonly column: string; readonly direction?: 'ASC' | 'DESC' }>;
}

export interface AlterColumnstoreConfigInput {
  /** Table name, optionally `schema.table`. The columnstore must already be enabled. */
  readonly table: string;
  /** The current config (for `down`). */
  readonly from: ColumnstoreConfig;
  /** The desired config (for `up`). */
  readonly to: ColumnstoreConfig;
}

/** Render the `timescaledb.segmentby`/`timescaledb.orderby` reloption clause for a columnstore config
 * (same quoting/direction rules as {@link addColumnstorePolicySQL}; omits an empty facet). */
function columnstoreConfigClause(config: ColumnstoreConfig): string {
  const options: string[] = [];
  if (config.segmentBy.length > 0) {
    const cols = config.segmentBy
      .map((c) => quoteIdent(assertSafeIdentifier(c, 'segmentBy')))
      .join(', ');
    options.push(`timescaledb.segmentby = ${quoteLiteral(cols)}`);
  }
  if (config.orderBy.length > 0) {
    const cols = config.orderBy
      .map(
        (o) =>
          `${quoteIdent(assertSafeIdentifier(o.column, 'orderBy'))} ${orderByDirection(o.direction)}`,
      )
      .join(', ');
    options.push(`timescaledb.orderby = ${quoteLiteral(cols)}`);
  }
  return options.join(', ');
}

/**
 * Change an existing columnstore's segment-by / order-by configuration via `ALTER TABLE ... SET`. The
 * columnstore must already be enabled (this never re-enables or disables it). NOT data-safe to apply
 * silently: on a hypertable with compressed chunks the engine must decompress + recompress to honour
 * the new layout — hence the `needs-recompress` safety class. `down` restores the prior config.
 */
export function alterColumnstoreConfigSQL(input: AlterColumnstoreConfigInput): MigrationStatement {
  const t = parseTable(input.table);
  const toClause = columnstoreConfigClause(input.to);
  if (toClause === '') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `alterColumnstoreConfig on ${t.ident} needs at least one of segmentBy/orderBy in the target config`,
      { table: input.table },
    );
  }
  // `ALTER TABLE ... SET (reloption)` is ADDITIVE: an option the clause omits keeps its old value.
  // So a `to` that empties a facet the current config has set cannot be expressed — the statement
  // would succeed while leaving the old value in place, i.e. report success on a state it did not
  // reach (and `down` would be wrong the same way). Refuse instead of silently diverging. The diff
  // engine is unaffected: it back-fills an undeclared facet from the current state before building.
  for (const facet of ['segmentBy', 'orderBy'] as const) {
    if (input.to[facet].length === 0 && input.from[facet].length > 0) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `alterColumnstoreConfig on ${t.ident}: cannot clear "${facet}" — ALTER TABLE ... SET is ` +
          `additive, so the existing value would silently remain. Pass the explicit target value, ` +
          `or use a hand-written migration to reset the columnstore configuration.`,
        { table: input.table, facet },
      );
    }
  }
  const fromClause = columnstoreConfigClause(input.from);
  const up = [`ALTER TABLE ${t.ident} SET (${toClause});`];
  // `from` is the introspected current config (a live columnstore always reports its orderby), so it is
  // normally non-empty; guard the degenerate empty case with a non-destructive notice rather than a
  // malformed empty SET.
  const down =
    fromClause === ''
      ? [nonDestructiveNotice('columnstore configuration', t.ident)]
      : [`ALTER TABLE ${t.ident} SET (${fromClause});`];
  // Select the direction/nulls columns too: `orderby` alone reports only column NAMES, so an
  // ASC↔DESC change (which this builder can emit) was invisible to the inspect query.
  const inspect =
    `SELECT segmentby, orderby, orderby_desc, orderby_nullsfirst ` +
    `FROM _timescaledb_catalog.compression_settings cs ` +
    `JOIN pg_class cl ON cl.oid = cs.relid JOIN pg_namespace n ON n.oid = cl.relnamespace ` +
    `WHERE n.nspname = ${quoteLiteral(t.schema)} AND cl.relname = ${quoteLiteral(t.name)};`;
  return { up, down, inspect };
}

export interface RemovePolicyInput {
  /** Table name, optionally `schema.table`. */
  readonly table: string;
  /** The threshold the policy currently has — used by `down` to re-add the removed policy. */
  readonly restoreAfter: string;
  /** The job's current `schedule_interval`, so `down` restores the cadence as well as the threshold. */
  readonly scheduleInterval?: string;
}

/**
 * Remove a hypertable's retention policy (a background job). `up` removes it (`if_exists`); `down`
 * re-adds it at `restoreAfter` (the threshold it had when removed) — so the removal is cleanly
 * reversible. Non-destructive: removing the policy only STOPS future chunk drops, it deletes nothing.
 */
export function removeRetentionPolicySQL(input: RemovePolicyInput): MigrationStatement {
  const t = parseTable(input.table);
  const restore = assertParsableInterval(input.restoreAfter, 'restoreAfter', { positive: true });
  const inspect =
    `SELECT job_id, proc_name, schedule_interval, config FROM timescaledb_information.jobs ` +
    `WHERE proc_name = 'policy_retention' AND hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`;
  return {
    up: [removeRetentionPolicyCall(t)],
    down: [addRetentionPolicyCall(t, restore, true, input.scheduleInterval)],
    inspect,
  };
}

/**
 * Remove a hypertable's compression (columnstore) policy job — leaving the columnstore itself enabled.
 * `up` removes it (`if_exists`); `down` re-adds it at `restoreAfter`. Non-destructive and reversible:
 * removing the policy only STOPS future auto-compression; existing compressed chunks are untouched.
 */
export function removeCompressionPolicySQL(input: RemovePolicyInput): MigrationStatement {
  const t = parseTable(input.table);
  const restore = assertParsableInterval(input.restoreAfter, 'restoreAfter', { positive: true });
  return {
    up: [removeCompressionPolicyCall(t)],
    down: [addCompressionPolicyCall(t, restore, true, input.scheduleInterval)],
    inspect: compressionPolicyInspect(t),
  };
}

/**
 * Change a compression policy's `after` threshold. A policy's threshold is not editable in place, so
 * this is a **remove-then-add**: `up` removes the current policy and adds one at `to`; `down` removes
 * that and restores `from`. Non-destructive — a policy is a background job, so toggling it rewrites no
 * data (the columnstore stays enabled throughout). Emit only when the columnstore already exists.
 */
export function alterCompressionPolicySQL(input: AlterPolicyInput): MigrationStatement {
  const t = parseTable(input.table);
  // `from` is the introspected current threshold (Postgres output form — may be `HH:MM:SS` for a
  // sub-day interval like `compress after '6 hours'`); accept any parseable form, not just `<n> <unit>`.
  const to = assertParsableInterval(input.to, 'to', { positive: true });
  const from = assertParsableInterval(input.from, 'from', { positive: true });
  // The add half asserts fresh (`if_not_exists => FALSE`): after the preceding remove the policy must
  // be gone, so a duplicate here means the remove did not take effect — fail loudly rather than silently
  // no-op and leave the OLD threshold in place (a silent drift). remove precedes add, so the block stays
  // idempotent on re-run.
  return {
    up: [
      removeCompressionPolicyCall(t),
      addCompressionPolicyCall(t, to, false, input.scheduleInterval),
    ],
    down: [
      removeCompressionPolicyCall(t),
      addCompressionPolicyCall(t, from, false, input.scheduleInterval),
    ],
    inspect: compressionPolicyInspect(t),
  };
}

/**
 * Change a retention policy's `drop_after` threshold, as a **remove-then-add** (see
 * {@link alterCompressionPolicySQL}). Non-destructive: it only re-schedules future drops; `down`
 * restores the prior threshold. It never deletes existing data.
 */
export function alterRetentionPolicySQL(input: AlterPolicyInput): MigrationStatement {
  const t = parseTable(input.table);
  // `from` is the introspected current threshold (may be a sub-day `HH:MM:SS` form); accept any
  // parseable interval form, not just `<n> <unit>`.
  const to = assertParsableInterval(input.to, 'to', { positive: true });
  const from = assertParsableInterval(input.from, 'from', { positive: true });
  const inspect =
    `SELECT job_id, proc_name, schedule_interval, config FROM timescaledb_information.jobs ` +
    `WHERE proc_name = 'policy_retention' AND hypertable_schema = ${quoteLiteral(t.schema)} AND hypertable_name = ${quoteLiteral(t.name)};`;
  // Assert fresh (`if_not_exists => FALSE`) after the remove — a duplicate means the remove failed;
  // fail loudly rather than silently leave the old threshold. remove precedes add → block idempotent.
  // `down()` may only restore the previous threshold when doing so LENGTHENS retention. Restoring a
  // SHORTER threshold is a data-loss event on the next scheduler tick — rolling back a 30d → 365d
  // change would re-install 30d on a hypertable that has been retaining a year, and ~11 months of
  // chunks become eligible for dropping. `down()` never destroys data, so it declines instead.
  //
  // isShortening(from, to) describes the UP direction. down goes to → from, so:
  //   true      up shortened   → down lengthens  → safe to restore
  //   false     up lengthened  → down shortens   → refuse, emit a notice
  //   undefined not comparable → cannot prove it is safe → refuse, emit a notice (fail closed)
  const upShortens = isShortening(from, to);
  const downIsSafe = upShortens === true;
  return {
    up: [
      removeRetentionPolicyCall(t),
      addRetentionPolicyCall(t, to, false, input.scheduleInterval),
    ],
    down: downIsSafe
      ? [
          removeRetentionPolicyCall(t),
          addRetentionPolicyCall(t, from, false, input.scheduleInterval),
        ]
      : [nonDestructiveNotice(`the retention threshold (${from} → ${to})`, t.ident)],
    inspect,
  };
}

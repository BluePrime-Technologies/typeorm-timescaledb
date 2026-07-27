import { assertSafeIdentifier, quoteIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { assertPositiveInterval } from '../interval.js';
import { TimescaleError, TimescaleErrorCode } from '../errors.js';
import { timeBucketExpr } from './hyperfunctions.js';
import { parseTable, type MigrationStatement } from './hypertable.js';

/**
 * Pure SQL builders for TimescaleDB **continuous aggregates** (CAGGs).
 *
 * Empirically verified against TimescaleDB 2.28 (see issue #95):
 * - `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous) … WITH NO DATA` and
 *   `add_continuous_aggregate_policy(...)` run **inside** a transaction, so the
 *   generated migration stays transaction-safe (no `transaction:false` needed).
 * - `CALL refresh_continuous_aggregate(...)` **cannot** run inside a transaction — it
 *   is a runtime-only operation ({@link refreshContinuousAggregateSQL}), never emitted
 *   into a migration.
 *
 * Every identifier flows through {@link assertSafeIdentifier}; the bucket interval is
 * validated with {@link assertPositiveInterval}; aggregate functions are allow-listed.
 */

/** Standard SQL aggregates a CAGG SELECT may use (allow-listed). */
export type ContinuousAggregateFn = 'avg' | 'sum' | 'min' | 'max' | 'count';

const CAGG_AGG_FNS: ReadonlySet<string> = new Set(['avg', 'sum', 'min', 'max', 'count']);

/** One aggregate column in the CAGG SELECT, e.g. `avg(value) AS avg_v`. */
export interface ContinuousAggregateColumn {
  /** Allow-listed aggregate function. */
  readonly fn: ContinuousAggregateFn;
  /** Column to aggregate. Omit only for `count` → `count(*)`. */
  readonly column?: string;
  /** Output column alias. */
  readonly as: string;
}

export interface CreateContinuousAggregateInput {
  /** CAGG view name, optionally `schema.view` (defaults to the `public` schema). */
  readonly view: string;
  /** Source hypertable, optionally `schema.table`. */
  readonly source: string;
  /** Time/partition column on the source hypertable. */
  readonly timeColumn: string;
  /** Bucket width, e.g. `'1 hour'`. */
  readonly bucketInterval: string;
  /** Alias for the `time_bucket(...)` column. Default `'bucket'`. */
  readonly bucketAlias?: string;
  /** Extra `GROUP BY` columns beyond the time bucket (e.g. `['sensor']`). */
  readonly groupBy?: readonly string[];
  /** Aggregate output columns; must be non-empty. */
  readonly aggregates: readonly ContinuousAggregateColumn[];
  /**
   * `timescaledb.materialized_only`. Default `false` → **real-time aggregation on**
   * (materialized rows unioned with the latest raw data). `true` → only materialized.
   */
  readonly materializedOnly?: boolean;
}

/** Build one allow-listed `fn(col) AS "alias"` (or `count(*) AS "alias"`) SELECT item. */
function aggregateSelectItem(a: ContinuousAggregateColumn): string {
  const fn = String(a.fn).toLowerCase();
  if (!CAGG_AGG_FNS.has(fn)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unsupported continuous-aggregate function "${String(a.fn)}" (allowed: avg, sum, min, max, count)`,
      { fn: String(a.fn) },
    );
  }
  const alias = quoteIdent(assertSafeIdentifier(a.as, 'aggregate alias'));
  if (fn === 'count' && (a.column === undefined || a.column === '')) {
    return `count(*) AS ${alias}`;
  }
  if (a.column === undefined || a.column === '') {
    throw new TimescaleError(TimescaleErrorCode.INVALID_ARGUMENT, `${fn} requires a column`, {
      fn,
    });
  }
  return `${fn}(${quoteIdent(assertSafeIdentifier(a.column, `${fn} column`))}) AS ${alias}`;
}

/**
 * Build the DDL for a continuous aggregate. The `up` always creates the view
 * `WITH NO DATA` (transaction-safe; the caller triggers the first
 * {@link refreshContinuousAggregateSQL} at runtime). `down` drops the derived view —
 * it removes only the materialized (recomputable) rows, never the source hypertable
 * data.
 */
export function createContinuousAggregateSQL(
  input: CreateContinuousAggregateInput,
): MigrationStatement {
  const view = parseTable(input.view);
  const source = parseTable(input.source);
  const timeColumn = assertSafeIdentifier(input.timeColumn, 'timeColumn');
  const bucketAlias = assertSafeIdentifier(input.bucketAlias ?? 'bucket', 'bucketAlias');
  const materializedOnly = input.materializedOnly ?? false;

  if (!Array.isArray(input.aggregates) || input.aggregates.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'a continuous aggregate needs at least one aggregate column',
      { view: input.view },
    );
  }

  const bucketExpr = timeBucketExpr({
    interval: assertPositiveInterval(input.bucketInterval, 'bucketInterval'),
    column: timeColumn,
  });
  const groupCols = (input.groupBy ?? []).map((c) =>
    quoteIdent(assertSafeIdentifier(c, 'groupBy column')),
  );

  const selectItems = [
    `${bucketExpr} AS ${quoteIdent(bucketAlias)}`,
    ...groupCols,
    ...input.aggregates.map(aggregateSelectItem),
  ];
  // GROUP BY the time_bucket EXPRESSION, not the output alias. For a hierarchical CAGG the
  // bucket alias can equal a source column name (e.g. parent buckets a child's "bucket"
  // column and re-aliases the result "bucket"); Postgres then resolves an ambiguous GROUP BY
  // name to the *input* column, dropping the time_bucket from the GROUP BY and tripping
  // TimescaleDB's "must include a valid time bucket function". Grouping by the expression is
  // unambiguous and equivalent for flat CAGGs.
  const groupByItems = [bucketExpr, ...groupCols];

  const up = [
    `CREATE MATERIALIZED VIEW ${view.ident} ` +
      `WITH (timescaledb.continuous, timescaledb.materialized_only = ${materializedOnly ? 'TRUE' : 'FALSE'}) AS ` +
      `SELECT ${selectItems.join(', ')} FROM ${source.ident} ` +
      `GROUP BY ${groupByItems.join(', ')} WITH NO DATA;`,
  ];
  const down = [`DROP MATERIALIZED VIEW IF EXISTS ${view.ident};`];
  const inspect =
    `SELECT view_schema, view_name, materialized_only FROM timescaledb_information.continuous_aggregates ` +
    `WHERE view_schema = ${quoteLiteral(view.schema)} AND view_name = ${quoteLiteral(view.name)};`;

  return { up, down, inspect };
}

/**
 * Input for {@link addContinuousAggregatePolicySQL} — an automatic refresh policy
 * (`add_continuous_aggregate_policy`) attached to an existing continuous aggregate.
 */
export interface ContinuousAggregatePolicyInput {
  /** CAGG view name, optionally `schema.view`. */
  readonly view: string;
  /**
   * How far back from *now* the refresh window starts, as an INTERVAL literal
   * (e.g. `'1 month'`). `null` = open (refresh from the beginning of time — expensive).
   */
  readonly startOffset: string | null;
  /**
   * How far back from *now* the refresh window ends, as an INTERVAL literal
   * (e.g. `'1 hour'`, to leave the still-filling latest bucket alone). `null` = up to now.
   *
   * Must be *smaller* than `startOffset` — TimescaleDB requires `start_offset > end_offset`
   * (magnitude is the DB's authority; an inverted window fails loudly at migration time).
   */
  readonly endOffset: string | null;
  /**
   * How often the policy runs, as an INTERVAL literal.
   *
   * **Required.** TimescaleDB **2.18** — this package's supported floor — has no
   * `add_continuous_aggregate_policy` overload that omits `schedule_interval`, so leaving it out
   * produced SQL that failed at migration time with `function add_continuous_aggregate_policy(...)
   * does not exist`. The migration generator already always supplies one (defaulting to the bucket
   * width); making it required moves the remaining direct-caller mistake to compile time.
   */
  readonly scheduleInterval: string;
}

/**
 * Build the DDL for a continuous-aggregate **refresh policy**. Verified against a live
 * TimescaleDB (2.18 + latest): the call runs inside a transaction (migration-safe) and
 * `if_not_exists => TRUE` is idempotent (a duplicate is skipped, not an error). `down`
 * removes only the policy/job with `if_exists => TRUE` — it never touches the CAGG or
 * the source data.
 */
export function addContinuousAggregatePolicySQL(
  input: ContinuousAggregatePolicyInput,
): MigrationStatement {
  const v = parseTable(input.view);
  const offset = (val: string | null, role: string): string =>
    val === null ? 'NULL' : `INTERVAL ${quoteLiteral(assertPositiveInterval(val, role))}`;

  const args = [
    v.regclass,
    `start_offset => ${offset(input.startOffset, 'startOffset')}`,
    `end_offset => ${offset(input.endOffset, 'endOffset')}`,
  ];
  {
    args.push(
      `schedule_interval => INTERVAL ${quoteLiteral(assertPositiveInterval(input.scheduleInterval, 'scheduleInterval'))}`,
    );
  }
  args.push('if_not_exists => TRUE');

  const up = [`SELECT add_continuous_aggregate_policy(${args.join(', ')});`];
  const down = [`SELECT remove_continuous_aggregate_policy(${v.regclass}, if_exists => TRUE);`];
  // `jobs.hypertable_name` is version-divergent: newer servers report the user-facing
  // view (public.<view>), 2.18 reports the internal materialization hypertable. Match
  // either — directly by the view name, or via the CAGG's materialization hypertable.
  const inspect =
    // Cast the interval to text so it reads back as a stable string ('00:30:00') rather
    // than the driver's parsed interval object; the offsets are JSON text already.
    `SELECT j.schedule_interval::text AS schedule_interval, j.config ->> 'start_offset' AS start_offset, ` +
    `j.config ->> 'end_offset' AS end_offset ` +
    `FROM timescaledb_information.jobs j ` +
    `WHERE j.proc_name = 'policy_refresh_continuous_aggregate' AND (` +
    `(j.hypertable_schema = ${quoteLiteral(v.schema)} AND j.hypertable_name = ${quoteLiteral(v.name)}) ` +
    `OR EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates c ` +
    `WHERE c.view_schema = ${quoteLiteral(v.schema)} AND c.view_name = ${quoteLiteral(v.name)} ` +
    `AND c.materialization_hypertable_schema = j.hypertable_schema ` +
    `AND c.materialization_hypertable_name = j.hypertable_name));`;

  return { up, down, inspect };
}

/** A refresh bound token: a positional placeholder (`$1`) or the literal `NULL` (open bound). */
function assertRefreshBound(token: string, role: string): string {
  if (!/^(\$[1-9]\d*|NULL)$/.test(token)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a positional placeholder ("$1") or NULL, got ${JSON.stringify(token)}`,
      { role, token: String(token) },
    );
  }
  return token;
}

/**
 * `CALL refresh_continuous_aggregate(<view>, <start>, <end>)` — the **runtime** refresh.
 * MUST be executed standalone (it cannot run inside a transaction block). `start`/`end`
 * are bound tokens: a positional placeholder (`$1`) or `NULL` for an open bound.
 */
export function refreshContinuousAggregateSQL(
  view: string,
  startToken: string,
  endToken: string,
): string {
  const v = parseTable(view);
  // A positional placeholder must be cast to timestamptz — the procedure's window
  // bounds are timestamptz and PostgreSQL cannot infer a bare `$1`'s type in a CALL.
  const bound = (token: string, role: string): string => {
    const t = assertRefreshBound(token, role);
    return t === 'NULL' ? 'NULL' : `${t}::timestamptz`;
  };
  return `CALL refresh_continuous_aggregate(${v.regclass}, ${bound(startToken, 'start')}, ${bound(endToken, 'end')});`;
}

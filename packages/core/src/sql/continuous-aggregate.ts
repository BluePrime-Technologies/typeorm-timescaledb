import { assertSafeIdentifier, quoteIdent } from '../identifier.js';
import { quoteLiteral } from '../literal.js';
import { assertPositiveInterval } from '../interval.js';
import { assertParsableInterval } from '../normalize.js';
import { TimescaleError, TimescaleErrorCode } from '../errors.js';
import { timeBucketExpr } from './hyperfunctions.js';
import { parseTable, nonDestructiveNotice, type MigrationStatement } from './hypertable.js';
import { findUnquotedToken } from '../sql-lex.js';

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

  const body = `SELECT ${selectItems.join(', ')} FROM ${source.ident} GROUP BY ${groupByItems.join(', ')}`;
  // IF NOT EXISTS, matching the `if_not_exists => TRUE` every other builder in this package already
  // sets (create_hypertable, add_retention_policy, add_columnstore_policy,
  // add_continuous_aggregate_policy). This was the ONE statement without an idempotence escape, and
  // `generate` is a DESIRED-STATE emitter — it writes a CREATE for every declared aggregate, not
  // only the missing ones. So adding a second aggregate to a project that already has one produced
  // a migration whose first statement died with `relation "…" already exists`, leaving the drift
  // `check` reported permanently unfixable through the migration workflow (#189).
  //
  // Verified on TimescaleDB 2.18.0-pg16 and latest-pg17: accepted alongside
  // `WITH (timescaledb.continuous)`, and a repeat run reports
  // `NOTICE: continuous aggregate "…" already exists, skipping`.
  //
  // Tradeoff, deliberate and shared with the other builders: this SKIPS rather than errors when a
  // view of the same name exists with a DIFFERENT definition. Detecting that is the diff engine's
  // job (it compares presence and reports an existing aggregate as not-compared), not this
  // builder's — a migration that must be replay-safe cannot also be the thing that refuses on
  // conflict.
  const up = [
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${view.ident} ` +
      `WITH (timescaledb.continuous, timescaledb.materialized_only = ${materializedOnly ? 'TRUE' : 'FALSE'}) AS ` +
      `${body} WITH NO DATA;`,
  ];
  const down = [`DROP MATERIALIZED VIEW IF EXISTS ${view.ident};`];
  const inspect =
    `SELECT view_schema, view_name, materialized_only FROM timescaledb_information.continuous_aggregates ` +
    `WHERE view_schema = ${quoteLiteral(view.schema)} AND view_name = ${quoteLiteral(view.name)};`;

  return { up, down, inspect };
}

/**
 * Render just the `SELECT …` body of a continuous aggregate — byte-identical to what
 * {@link createContinuousAggregateSQL} embeds, because that function now builds its statement from
 * this exact string.
 *
 * Exists for the DESIRED-STATE path: `SchemaStateIR.ContinuousAggregateState` carries the CAGG as
 * SQL text, so the decorator side needs the same rendering the builder would use. Sharing one
 * renderer means the two can never drift apart.
 *
 * NOTE this text is NOT comparable to the catalog's `view_definition`. `pg_get_viewdef` is a
 * parse-tree deparse — it re-renders intervals (`INTERVAL '1 hour'` -> `'01:00:00'::interval`),
 * unquotes identifiers, drops the schema qualifier and parenthesises GROUP BY — so an identical
 * CAGG compares UNEQUAL. Never diff desired-vs-current CAGG structure on this string.
 */
export function renderContinuousAggregateSelect(input: CreateContinuousAggregateInput): string {
  return extractSelectBody(createContinuousAggregateSQL(input).up[0] ?? '');
}

/**
 * Pull the `SELECT … ` body back out of a rendered CREATE MATERIALIZED VIEW statement.
 *
 * Exported (under an explicit `ForTest` name, not part of the documented surface) ONLY so its
 * failure mode is pinnable: it is reachable in production solely through
 * `renderContinuousAggregateSelect`, whose own input always matches, so the throw below could not
 * otherwise be exercised — and an unexercised throw is an unpinned one.
 */
export function extractSelectBodyForTest(statement: string): string {
  return extractSelectBody(statement);
}

function extractSelectBody(statement: string): string {
  // Whitespace-tolerant: the builder emits `) AS <body> WITH NO DATA;` on one line today, but a
  // reformat that broke the line would silently stop matching.
  const open = /\)\s+AS\s+/.exec(statement);
  const close = /\s+WITH\s+NO\s+DATA;?\s*$/.exec(statement);
  if (open === null || close === null) {
    // Deliberately THROW rather than fall back to the whole statement. The previous fallback
    // returned the entire `CREATE MATERIALIZED VIEW ... AS SELECT ...` text as if it were the
    // SELECT body — which a raw-create then embeds inside another CREATE, producing nonsense SQL
    // from a silent mismatch. A loud failure here is the only safe behaviour for a function whose
    // output goes on to be emitted as DDL.
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'could not locate the SELECT body in the generated continuous-aggregate statement — the builder output shape changed',
    );
  }
  return statement.slice(open.index + open[0].length, close.index);
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
    val === null
      ? 'NULL'
      : `INTERVAL ${quoteLiteral(assertParsableInterval(val, role, { positive: true }))}`;

  const args = [
    v.regclass,
    `start_offset => ${offset(input.startOffset, 'startOffset')}`,
    `end_offset => ${offset(input.endOffset, 'endOffset')}`,
  ];
  {
    args.push(
      `schedule_interval => INTERVAL ${quoteLiteral(assertParsableInterval(input.scheduleInterval, 'scheduleInterval', { positive: true }))}`,
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

/**
 * Input for {@link createContinuousAggregateRawSQL} — reproduce an EXISTING continuous
 * aggregate from the definition the database itself reports, rather than from a structured
 * spec.
 */
export interface CreateContinuousAggregateRawInput {
  /** CAGG view name, optionally `schema.view` (defaults to the `public` schema). */
  readonly view: string;
  /**
   * The CAGG's `SELECT` body, verbatim from
   * `timescaledb_information.continuous_aggregates.view_definition`.
   *
   * **This is passed through to the emitted SQL unparsed** — see the trust note on
   * {@link createContinuousAggregateRawSQL}.
   */
  readonly definition: string;
  /** `timescaledb.materialized_only`. Default `false` (real-time aggregation on). */
  readonly materializedOnly?: boolean;
  /**
   * What this statement is FOR. It changes `down()` and the safety classification, and nothing else.
   *
   * - `'reproduce'` (DEFAULT) — the aggregate already exists somewhere and is already materialized;
   *   this reproduces it elsewhere (the `pull` path). `down()` must NOT drop it: its rows may be
   *   the only surviving copy of data whose source chunks a retention policy has already dropped.
   * - `'create'` — the aggregate does not exist and is being created new (the diff path). It is
   *   created `WITH NO DATA` and holds nothing, so `down()` dropping it is genuinely lossless —
   *   and leaving it behind instead means a reverted migration strands an empty, unwanted view.
   *
   * Defaults to `'reproduce'` deliberately: a caller who forgets gets the NON-destructive `down()`.
   * The cost of that default is a stranded empty view; the cost of the other default is deleting a
   * rollup that cannot be recomputed.
   */
  readonly intent?: 'reproduce' | 'create';
}

/**
 * `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous) AS <definition> WITH NO DATA` —
 * the **reproduce** counterpart to {@link createContinuousAggregateSQL}.
 *
 * Why this exists: {@link createContinuousAggregateSQL} builds a CAGG from a structured spec
 * (time column + bucket interval + an allow-listed aggregate set), which is right for
 * hand-authored/decorator-declared CAGGs. It cannot express a CAGG that already exists in a
 * database, because introspection only recovers the view's SQL text — and real CAGGs routinely
 * use toolkit aggregates (`candlestick_agg`, `stats_agg`), `first`/`last`, filters, and
 * expressions that the five-function allow-list rejects. Round-tripping that text back into the
 * structured form would be wrong more often than right, so `pull` emits the database's own
 * definition instead.
 *
 * **TRUST BOUNDARY — read before reusing.** Unlike every other builder here, `definition` is
 * NOT identifier-validated: it is opaque SQL. That is sound for BOTH of its current callers, and
 * NOT sound for user- or config-supplied text:
 *   1. `stateToOperations` (the `pull` path) — fed by `introspect()`, i.e. the server's own catalog;
 *   2. `diffContinuousAggregates` (the desired-state path) — fed by
 *      `renderContinuousAggregateSelect`, i.e. text THIS package rendered, with every identifier
 *      already through `assertSafeIdentifier` and every aggregate function allow-listed.
 * Neither source is free text. Do not add a third caller without re-establishing that its
 * `definition` has the same provenance. (This note previously claimed a single caller; the
 * desired-state path was added later and the claim was left stale — the kind of invariant a reader
 * relies on, so it is spelled out rather than trimmed.)
 * The one structural guard applied is single-statement-ness: a
 * definition that still contains a `;` after its trailing terminator is stripped is rejected, so
 * a catalog value can never smuggle extra statements into the migration. The view NAME is
 * validated normally.
 */
/** Why a raw definition cannot be reproduced, or `'usable'`. */
export type DefinitionVerdict = 'usable' | 'empty' | 'multi-statement' | 'unterminated';

/** Operator-facing explanation per non-`usable` verdict. Shared by the builder (which throws) and
 * `stateToOperations` (which reports), so the two can never disagree about the reason. */
export const DEFINITION_REJECTION: Record<Exclude<DefinitionVerdict, 'usable'>, string> = {
  empty: 'empty definition — nothing to reproduce',
  'multi-statement': 'definition contains a statement separator outside any literal or comment',
  unterminated:
    'definition ends inside an unterminated block comment or dollar-quoted string, so the appended WITH NO DATA clause would be swallowed',
};

/** Strip the catalog's trailing terminator and surrounding whitespace; we re-terminate ourselves. */
export function normalizeCaggDefinitionBody(definition: string): string {
  return definition.trim().replace(/;\s*$/, '').trim();
}

/**
 * Decide whether a normalized definition body can be safely embedded in a
 * `CREATE MATERIALIZED VIEW … AS <body> WITH NO DATA;` statement.
 *
 * A naive `body.includes(';')` is WRONG, and was the first implementation: a perfectly legal
 * continuous aggregate can carry a semicolon inside a constant — `count(*) FILTER (WHERE tag <>
 * 'a;b')`, `to_char(ts, 'HH24;MI')`, `string_agg(x, ';')`. `pg_get_viewdef` preserves those
 * literals, so rejecting them refuses to reproduce a valid schema AND reports "multiple
 * statements", an explanation that is simply false.
 *
 * So scan properly, skipping single-quoted literals (with `''` escapes), dollar-quoted blocks, and
 * both comment forms. A `;` found outside all of those is a real separator.
 *
 * An UNTERMINATED block comment or dollar quote is rejected separately: the appended clause would
 * land inside it. A line comment running to end-of-input is fine, because the clause is appended
 * after a newline.
 */
const SEPARATOR_ONLY = [';'] as const;

export function classifyDefinitionBody(body: string): DefinitionVerdict {
  if (body.length === 0) return 'empty';
  // The walk itself lives in `sql-lex.ts`, shared with `assertSafeFragment`. It used to live here,
  // and a second, naive copy appeared in that other guard — see that module's header.
  //
  // Comment openers are NOT passed as tokens: a view body may legally contain comments, so they are
  // regions to skip. Only a top-level `;` makes this a second statement.
  const found = findUnquotedToken(body, SEPARATOR_ONLY);
  if (found.kind === 'unterminated') return 'unterminated';
  return found.kind === 'found' ? 'multi-statement' : 'usable';
}

export function createContinuousAggregateRawSQL(
  input: CreateContinuousAggregateRawInput,
): MigrationStatement {
  const view = parseTable(input.view);
  const materializedOnly = input.materializedOnly ?? false;

  const body = normalizeCaggDefinitionBody(input.definition);
  const verdict = classifyDefinitionBody(body);
  if (verdict !== 'usable') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `continuous aggregate ${input.view}: ${DEFINITION_REJECTION[verdict]}`,
      { view: input.view },
    );
  }

  const up = [
    `CREATE MATERIALIZED VIEW ${view.ident} ` +
      `WITH (timescaledb.continuous, timescaledb.materialized_only = ${materializedOnly ? 'TRUE' : 'FALSE'}) AS ` +
      // NEWLINE, not a space, before the appended clause. A definition ending in a `--` line comment
      // would otherwise swallow `WITH NO DATA` *and* the terminator — and Postgres accepts an
      // unterminated single statement, so it would SUCCEED and materialize the whole history inside
      // a migration, silently falsifying this operation's "created WITH NO DATA" safety premise.
      `${body}\nWITH NO DATA;`,
  ];
  // `down` depends on WHY this statement exists — the two cases are genuinely different objects.
  //
  // reproduce (pull): the aggregate ALREADY EXISTS and is ALREADY MATERIALIZED elsewhere. Its rows
  // may be the only surviving copy of data whose source chunks a retention policy has long since
  // dropped, so dropping is unrecoverable. Same treatment as a hypertable/columnstore conversion.
  //
  // create (diff): the aggregate did not exist and is created here `WITH NO DATA`, so it holds
  // nothing and dropping it is lossless — exactly the reasoning `createContinuousAggregateSQL`
  // already documents. Refusing to drop it in this case is not caution, it is a bug: a reverted
  // migration leaves behind an empty view the user never had and cannot easily notice.
  const down =
    (input.intent ?? 'reproduce') === 'create'
      ? [`DROP MATERIALIZED VIEW IF EXISTS ${view.ident};`]
      : [nonDestructiveNotice('continuous aggregate', view.ident)];
  const inspect =
    `SELECT view_schema, view_name, materialized_only FROM timescaledb_information.continuous_aggregates ` +
    `WHERE view_schema = ${quoteLiteral(view.schema)} AND view_name = ${quoteLiteral(view.name)};`;

  return { up, down, inspect };
}

/**
 * DROP + CREATE an existing continuous aggregate whose definition has drifted from the declaration.
 *
 * **This discards the aggregate's materialized rows.** TimescaleDB cannot `ALTER` a continuous
 * aggregate's `SELECT`, so there is no other convergence path; the operation is classified
 * `refuse-by-default` and is emitted only behind an explicit opt-in.
 *
 * Two deliberate choices in the emitted SQL:
 *
 * - **`up` drops before creating**, with `IF EXISTS` so a re-run after a partial failure is not
 *   itself a failure. The recreate is `WITH NO DATA`, matching {@link createContinuousAggregateRawSQL}
 *   — materializing history inside a migration makes the statement's cost unbounded, which is the
 *   caller's decision (a `refresh`), not this builder's.
 * - **`down` does NOT drop the recreated view.** Reverting cannot bring back the rows `up` discarded,
 *   so dropping the replacement as well would leave the user with neither the old aggregate nor the
 *   new one. Same reasoning as `intent: 'reproduce'` above: the destructive act has already happened
 *   and is not undoable, so `down` limits the damage rather than doubling it.
 */
export function recreateContinuousAggregateSQL(
  input: CreateContinuousAggregateRawInput,
): MigrationStatement {
  const view = parseTable(input.view);
  const materializedOnly = input.materializedOnly ?? false;

  // Same guard as the raw create: the definition is passed through UNPARSED, so it must first be
  // proven free of anything that could terminate the statement or comment out the appended clause.
  const body = normalizeCaggDefinitionBody(input.definition);
  const verdict = classifyDefinitionBody(body);
  if (verdict !== 'usable') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `continuous aggregate ${input.view}: ${DEFINITION_REJECTION[verdict]}`,
      { view: input.view },
    );
  }

  const up = [
    `DROP MATERIALIZED VIEW IF EXISTS ${view.ident};`,
    `CREATE MATERIALIZED VIEW ${view.ident} ` +
      `WITH (timescaledb.continuous, timescaledb.materialized_only = ${materializedOnly ? 'TRUE' : 'FALSE'}) AS ` +
      // NEWLINE, not a space — a definition ending in a `--` line comment would otherwise swallow
      // `WITH NO DATA` and the terminator, and Postgres accepts an unterminated single statement, so
      // it would SUCCEED while materializing the entire history.
      `${body}\nWITH NO DATA;`,
  ];

  const down = [nonDestructiveNotice('continuous aggregate', view.ident)];

  const inspect =
    `SELECT view_schema, view_name, materialized_only FROM timescaledb_information.continuous_aggregates ` +
    `WHERE view_schema = ${quoteLiteral(view.schema)} AND view_name = ${quoteLiteral(view.name)};`;

  return { up, down, inspect };
}

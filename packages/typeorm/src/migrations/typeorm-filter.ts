import type { SchemaStateIR } from '@blueprime/timescaledb-core';
import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import type { TypeormDiff, TypeormStatement } from './typeorm-diff.js';

/**
 * The protective filter — slice 2 of M4.5 (#235).
 *
 * TypeORM's schema diff knows nothing about TimescaleDB, so it treats objects TimescaleDB created
 * as orphans and proposes removing them. Measured on a live database while planning this milestone,
 * the very first statement of an otherwise ordinary diff was:
 *
 * ```sql
 * DROP INDEX "public"."readings_time_idx"
 * ```
 *
 * That index is created by `create_hypertable` (verified: absent before, present after). No entity
 * will ever declare it, so TypeORM re-proposes the drop on *every* run. Merging the two halves
 * naively would therefore ship a migration that silently removes the hypertable's time index,
 * forever.
 *
 * So every TypeORM statement is classified before composition:
 *
 * - **keep** — ordinary relational DDL. TypeORM owns the base table and this engine must not
 *   interfere with it; filtering these would break the composition it exists to enable.
 * - **filtered** — targets an object TimescaleDB owns. Dropped from the composed migration and
 *   REPORTED, never silently discarded.
 * - **unclassified** — refuses. A filter is an allow-list, and this repo has twice been bitten by
 *   an allow-list missing an entry (`check-version-claims.mjs`'s `SURFACES`). Passing an
 *   unrecognised statement through risks executing something destructive against a Timescale
 *   object; dropping it risks losing legitimate user DDL. Stopping and naming it is the only
 *   option that cannot be silently wrong.
 */

/** Objects TimescaleDB created and owns, derived from a live {@link SchemaStateIR}. */
export interface TimescaleOwnedObjects {
  /** Bare (unqualified) hypertable names. */
  readonly hypertables: ReadonlySet<string>;
  /** Auto-created time index names, e.g. `readings_time_idx`, derived from each time dimension. */
  readonly autoIndexes: ReadonlySet<string>;
  /** Bare continuous-aggregate view names. */
  readonly continuousAggregates: ReadonlySet<string>;
}

/**
 * Derive the owned-object set from introspected state.
 *
 * The auto-index name is reconstructed rather than read from the catalog, because the composer runs
 * against the DESIRED plan too, where a hypertable may not exist yet. TimescaleDB's convention is
 * `<table>_<timecolumn>_idx`.
 */
export function timescaleOwnedObjects(state: SchemaStateIR): TimescaleOwnedObjects {
  const hypertables = new Set<string>();
  const autoIndexes = new Set<string>();

  for (const ht of state.hypertables) {
    const bare = bareName(ht.table);
    hypertables.add(bare);
    for (const dim of ht.dimensions) {
      // Only the TIME dimension. `create_hypertable` indexes that column; a space dimension gets no
      // such index, so deriving one would filter a user's own index that happened to share the name.
      if (dim.kind === 'time') autoIndexes.add(`${bare}_${dim.column}_idx`);
    }
  }

  const continuousAggregates = new Set(
    (state.continuousAggregates ?? []).map((c) => bareName(c.viewName)),
  );

  return { hypertables, autoIndexes, continuousAggregates };
}

/** What the filter decided about one statement. */
export type StatementDisposition =
  | { readonly verdict: 'keep' }
  | { readonly verdict: 'filtered'; readonly object: string; readonly reason: string }
  | { readonly verdict: 'unclassified'; readonly reason: string };

/** A statement the filter removed, kept for reporting. */
export interface FilteredStatement {
  readonly statement: TypeormStatement;
  readonly side: 'up' | 'down';
  readonly object: string;
  readonly reason: string;
}

/** The result of filtering a whole diff. */
export interface FilteredTypeormDiff {
  readonly diff: TypeormDiff;
  /** Statements removed because TimescaleDB owns their target. Never silently dropped. */
  readonly filtered: readonly FilteredStatement[];
}

/** How strict to be about statements that touch Timescale-owned objects. */
export type FilterMode = 'filter' | 'strict';

/**
 * Names TimescaleDB uses for its own internal objects. These never belong to a user entity, so a
 * TypeORM statement naming one is always TimescaleDB's, whatever the verb.
 */
const INTERNAL_PATTERNS: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /^_hyper_\d+_\d+_chunk$/, what: 'a hypertable chunk' },
  {
    re: /^_materialized_hypertable_\d+$/,
    what: "a continuous aggregate's materialization hypertable",
  },
  { re: /^_direct_view_\d+$/, what: "a continuous aggregate's direct view" },
  { re: /^_partial_view_\d+$/, what: "a continuous aggregate's partial view" },
  { re: /^compress_hyper_\d+_\d+_chunk$/, what: 'a compressed chunk' },
];

/** Schemas that are entirely TimescaleDB's. */
const INTERNAL_SCHEMAS = new Set([
  '_timescaledb_internal',
  '_timescaledb_catalog',
  '_timescaledb_config',
  '_timescaledb_cache',
  'timescaledb_information',
  'timescaledb_experimental',
]);

/**
 * A possibly schema-qualified object name.
 *
 * A fully-quoted identifier is matched FIRST, so `"users"("id" ...)` and the (legal, if unusual)
 * `"readings_time_idx"ON ...` both yield the identifier alone. A space-delimited fallback covers
 * unquoted names. Getting this wrong is not merely cosmetic: an unparsed name resolves to no owned
 * object and so falls through to `keep`, which would let a `DROP INDEX` of the hypertable's time
 * index survive into the migration — precisely the failure this module exists to prevent.
 */
const OBJ = String.raw`(?<obj>"[^"]+"(?:\."[^"]+")*|[^\s(;]+)`;

const recognise = (body: string, target: 'index' | 'table' | 'view' | 'other') => ({
  re: new RegExp(String.raw`^\s*${body}`, 'i'),
  target,
});

/**
 * Statement forms this filter positively recognises as ordinary TypeORM DDL.
 *
 * Deliberately an allow-list of VERBS rather than a deny-list: an unrecognised verb reaches the
 * `unclassified` refusal instead of being waved through. `typeorm_metadata` and
 * `query-result-cache` are TypeORM's own bookkeeping tables — the latter appears whenever a user
 * enables the database query-result cache, exactly as it does in `migration:generate`, so it must
 * be classified rather than refused.
 *
 * The list is not guesswork. It was checked against every DDL verb `PostgresQueryRunner` actually
 * emits, which is what caught `ALTER TYPE` (8 call sites), `ALTER INDEX` (8) and `ALTER SEQUENCE`
 * (4) missing from an earlier draft. `ALTER TYPE ... RENAME TO` is how TypeORM performs every enum
 * change, so omitting it would have refused composition for any entity with an enum column — an
 * allow-list gap of exactly the kind this repo has shipped twice before.
 *
 * Deliberately still absent, because the schema builder never emits them: `TRUNCATE TABLE` (only
 * `queryRunner.clearTable()`), and `CREATE`/`DROP DATABASE`. Those refuse, which is correct — they
 * are destructive and have no business in a generated migration.
 */
const RECOGNISED = [
  recognise(
    String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${OBJ}`,
    'index',
  ),
  recognise(String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?${OBJ}`, 'index'),
  // Renaming an index. Classified as an index so a rename OF the auto time index is still caught.
  recognise(String.raw`ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?${OBJ}`, 'index'),
  recognise(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${OBJ}`, 'table'),
  recognise(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${OBJ}`, 'table'),
  recognise(String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?${OBJ}`, 'table'),
  recognise(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${OBJ}`,
    'view',
  ),
  recognise(String.raw`DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?${OBJ}`, 'view'),
  recognise(String.raw`ALTER\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?${OBJ}`, 'view'),
  recognise(String.raw`(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+${OBJ}`, 'table'),
  // Types, sequences, schemas, extensions, functions and triggers are never Timescale-owned objects
  // this filter tracks, so the verb alone settles it — no target needs reading.
  recognise(
    String.raw`(?:CREATE|DROP|ALTER)\s+(?:TYPE|SEQUENCE|SCHEMA|EXTENSION|FUNCTION|TRIGGER)\b`,
    'other',
  ),
  recognise(String.raw`COMMENT\s+ON\b`, 'other'),
] as const;

/** Classify a single statement against the owned set. */
export function classifyTypeormStatement(
  sql: string,
  owned: TimescaleOwnedObjects,
): StatementDisposition {
  const match = RECOGNISED.find((r) => r.re.test(sql));
  if (match === undefined) {
    return {
      verdict: 'unclassified',
      reason:
        'not a statement form this filter recognises, so it cannot be proven safe to keep OR safe ' +
        'to drop',
    };
  }

  // Verbs with no single object (CREATE TYPE, COMMENT ON, ...) target nothing Timescale owns.
  if (match.target === 'other') return { verdict: 'keep' };

  const raw = match.re.exec(sql)?.groups?.['obj'];
  if (raw === undefined) {
    return {
      verdict: 'unclassified',
      reason: 'the target object could not be read from the statement',
    };
  }

  const { schema, name } = splitQualified(raw);

  if (schema !== undefined && INTERNAL_SCHEMAS.has(schema)) {
    return {
      verdict: 'filtered',
      object: raw,
      reason: `lives in ${schema}, which is TimescaleDB's own schema`,
    };
  }

  for (const p of INTERNAL_PATTERNS) {
    if (p.re.test(name)) {
      return {
        verdict: 'filtered',
        object: raw,
        reason: `is ${p.what}, created and owned by TimescaleDB`,
      };
    }
  }

  if (match.target === 'index' && owned.autoIndexes.has(name)) {
    return {
      verdict: 'filtered',
      object: raw,
      reason:
        'is the index create_hypertable() creates on the time column. No entity declares it, so ' +
        'TypeORM proposes dropping it on every run',
    };
  }

  if (match.target === 'view' && owned.continuousAggregates.has(name)) {
    return {
      verdict: 'filtered',
      object: raw,
      reason: 'is a continuous aggregate, which this engine owns and diffs structurally',
    };
  }

  // A hypertable's BASE TABLE is TypeORM's to manage — that is the whole point of composing, so
  // `ALTER TABLE readings ADD "note"` must survive. Dropping one is the exception: it is
  // destructive AND both engines claim it (this engine never drops a hypertable), so the
  // disagreement is refused rather than silently resolved either way.
  if (match.target === 'table' && /^\s*DROP\s+TABLE\b/i.test(sql) && owned.hypertables.has(name)) {
    return {
      verdict: 'unclassified',
      reason:
        `${raw} is a hypertable. TypeORM proposes dropping it, but this engine never drops a ` +
        'hypertable — its chunks may hold the only copy of data whose retention window has passed. ' +
        'Resolve by hand rather than letting either engine decide',
    };
  }

  return { verdict: 'keep' };
}

/**
 * Apply {@link classifyTypeormStatement} across a diff.
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` on any unclassified statement, or — in `'strict'`
 *   mode — on any statement that would merely have been filtered.
 */
export function filterTypeormDiff(
  diff: TypeormDiff,
  owned: TimescaleOwnedObjects,
  options: { readonly mode?: FilterMode } = {},
): FilteredTypeormDiff {
  const mode = options.mode ?? 'filter';
  const filtered: FilteredStatement[] = [];

  const run = (statements: readonly TypeormStatement[], side: 'up' | 'down'): TypeormStatement[] =>
    statements.filter((statement) => {
      const d = classifyTypeormStatement(statement.sql, owned);

      if (d.verdict === 'unclassified') {
        throw new TimescaleError(
          TimescaleErrorCode.INVALID_ARGUMENT,
          `Cannot compose: a statement in TypeORM's ${side} diff ${d.reason}: ${statement.sql}`,
          { side, sql: statement.sql, reason: d.reason },
        );
      }

      if (d.verdict === 'filtered') {
        if (mode === 'strict') {
          throw new TimescaleError(
            TimescaleErrorCode.INVALID_ARGUMENT,
            `Cannot compose in strict mode: TypeORM's ${side} diff targets ${d.object}, which ` +
              `${d.reason}. Use the default 'filter' mode to drop such statements and continue: ` +
              statement.sql,
            { side, sql: statement.sql, object: d.object, reason: d.reason },
          );
        }
        filtered.push({ statement, side, object: d.object, reason: d.reason });
        return false;
      }

      return true;
    });

  return { diff: { up: run(diff.up, 'up'), down: run(diff.down, 'down') }, filtered };
}

/**
 * `"public"."readings"` / `public.readings` / `"readings"` → `{ schema?, name }`, unquoted.
 *
 * The name is the LAST part and the schema the one before it, so a three-part
 * `"db"."public"."readings"` still resolves to the schema that matters rather than the catalog.
 * Deliberately no whitespace-trimming or empty-part handling: input reaches here only from TypeORM's
 * schema builder or the introspection catalog, neither of which can produce `public . readings` or
 * `public..readings`, and mutation testing showed such guards were untestable dead weight.
 */
function splitQualified(raw: string): { schema?: string; name: string } {
  const parts = raw.split('.').map((p) => p.replace(/^"(.*)"$/s, '$1'));
  const name = parts[parts.length - 1] ?? '';
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return schema !== undefined ? { schema, name } : { name };
}

/** `public.readings` → `readings`. Comparison is on bare names; schemas are handled separately. */
function bareName(qualified: string): string {
  return splitQualified(qualified).name;
}

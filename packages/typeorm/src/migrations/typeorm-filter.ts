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
 *
 * Two asymmetries drive the details below, and both were learned rather than assumed:
 *
 * 1. **Over-filtering is worse than refusing.** A refusal is visible. Silently removing the user's
 *    own DDL from a migration they believe is complete is not. Ownership is therefore matched on
 *    fully schema-qualified identity and on the object KIND, never on a bare name.
 * 2. **Failing to parse falls through to `keep`, which is the destructive direction.** An
 *    identifier this module reads wrongly resolves to no owned object, so an owned `DROP INDEX`
 *    would survive into the migration. Identifier parsing is exact for that reason.
 */

/** Postgres truncates every identifier to this many BYTES (`NAMEDATALEN - 1`). */
const MAX_IDENTIFIER_BYTES = 63;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Clip to `n` bytes without splitting a multibyte character, as `pg_mbcliplen` does. */
function clipBytes(bytes: Uint8Array, n: number): string {
  let end = Math.min(n, bytes.length);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return fromUtf8.decode(bytes.subarray(0, end));
}

/**
 * Port of Postgres's `makeObjectName()` — how a generated index name is actually built.
 *
 * An earlier revision truncated the finished `<table>_<column>_idx` string at 63 bytes. That is NOT
 * what the server does, and the difference is not subtle. Measured on `timescaledb:2.18.0-pg16`:
 *
 * ```text
 * constructed : sensor_readings_from_the_northern_field_station_array_observed_at_utc_timestamp_value_idx
 * naive clip  : sensor_readings_from_the_northern_field_station_array_observed_
 * ACTUAL      : sensor_readings_from_the_nort_observed_at_utc_timestamp_val_idx
 * ```
 *
 * Postgres shortens the COMPONENTS to fit, preferentially trimming the longer one, and preserves
 * both separators and the `_idx` label. A reconstructed key that differs from the catalog name
 * matches nothing, so the destructive `DROP INDEX` survives — the failure this module exists to
 * prevent. This implementation reproduces the observed name exactly.
 *
 * Not reproduced: the collision suffixes (`_idx1`, `_idx2`, ...) `ChooseRelationName` appends when
 * the generated name is already taken. Guessing one risks filtering a DIFFERENT index, which is the
 * over-filtering direction; {@link OwnedObjectOptions.knownAutoIndexes} is the way out.
 */
function makeObjectName(name1: string, name2: string, label: string): string {
  const b1 = utf8.encode(name1);
  const b2 = utf8.encode(name2);

  // overhead = '_' + label, plus the '_' between the two names.
  const overhead = utf8.encode(label).length + 1 + (b2.length > 0 ? 1 : 0);
  const availchars = MAX_IDENTIFIER_BYTES - overhead;

  let n1 = b1.length;
  let n2 = b2.length;
  while (n1 + n2 > availchars) {
    if (n1 > n2) n1--;
    else n2--;
  }

  const p1 = clipBytes(b1, n1);
  return b2.length > 0 ? `${p1}_${clipBytes(b2, n2)}_${label}` : `${p1}_${label}`;
}

/** A parsed, schema-qualified object name with Postgres's quoting rules already applied. */
interface QualifiedName {
  readonly schema?: string;
  readonly name: string;
}

/** Objects TimescaleDB created and owns, derived from a live {@link SchemaStateIR}. */
export interface TimescaleOwnedObjects {
  /** Schema-qualified hypertable names, e.g. `public.readings`. */
  readonly hypertables: ReadonlySet<string>;
  /** Schema-qualified auto-created time index names, e.g. `public.readings_time_idx`. */
  readonly autoIndexes: ReadonlySet<string>;
  /**
   * Expected column list for each RECONSTRUCTED auto index, keyed as in {@link autoIndexes}.
   *
   * Present only for names this module derived, so a `CREATE INDEX` reusing a derived name can be
   * checked against its definition instead of filtered on the name alone. Names supplied through
   * {@link OwnedObjectOptions.knownAutoIndexes} are catalog truth and are deliberately absent here,
   * since there is nothing to second-guess.
   */
  readonly autoIndexColumns: ReadonlyMap<string, readonly string[]>;
  /** Schema-qualified continuous-aggregate view names. */
  readonly continuousAggregates: ReadonlySet<string>;
  /** The schema an unqualified statement resolves against. */
  readonly defaultSchema: string;
}

/** Options for {@link timescaleOwnedObjects}. */
export interface OwnedObjectOptions {
  /**
   * The schema an unqualified name resolves to. Defaults to `public`.
   *
   * This matters for correctness, not convenience: with bare-name matching, an `analytics.readings`
   * hypertable would make a perfectly legitimate `DROP INDEX "public"."readings_time_idx"` look
   * Timescale-owned and vanish from the user's migration.
   */
  readonly defaultSchema?: string;
  /**
   * Auto-index names read from the catalog, REPLACING reconstruction entirely.
   *
   * {@link makeObjectName} reproduces Postgres's generated-name algorithm for the common case, but
   * it cannot know about collision suffixes, nor about indexes created by a `create_hypertable`
   * call that this library did not emit. A caller introspecting a live database can pass the real
   * names instead.
   *
   * Supplying this **replaces** the reconstructed set rather than adding to it, and that is the
   * whole point. Collision suffixes exist precisely because the reconstructed name was already
   * taken — by a USER's index. Unioning the two would filter both the real auto index
   * (`..._time_idx1`) and the user's own `..._time_idx`, silently deleting their DDL. So when this
   * is provided it must be the complete, authoritative list for every hypertable in `state`.
   */
  readonly knownAutoIndexes?: readonly string[];
}

/**
 * Derive the owned-object set from introspected state.
 *
 * Auto-index names are reconstructed rather than read from the catalog because the composer also
 * runs against the DESIRED plan, where a hypertable may not exist yet. TimescaleDB's convention is
 * `<table>_<timecolumn>_idx`, truncated to Postgres's identifier limit.
 */
export function timescaleOwnedObjects(
  state: SchemaStateIR,
  options: OwnedObjectOptions = {},
): TimescaleOwnedObjects {
  const defaultSchema = options.defaultSchema ?? 'public';
  const qualify = (raw: string): string => key(parseCatalogName(raw), defaultSchema);

  const hypertables = new Set<string>();
  const autoIndexes = new Set<string>();
  const autoIndexColumns = new Map<string, readonly string[]>();

  // Catalog names REPLACE reconstruction — see OwnedObjectOptions.knownAutoIndexes. Unioning them
  // would filter the user's own index whenever a collision suffix was the reason for supplying
  // catalog names in the first place.
  const fromCatalog = options.knownAutoIndexes !== undefined;

  for (const ht of state.hypertables) {
    const parsed = parseCatalogName(ht.table);
    hypertables.add(key(parsed, defaultSchema));

    if (fromCatalog) continue;

    // ONLY the time index is reconstructed.
    //
    // Whether a space partition also yields a composite `(space, time)` index depends on HOW the
    // hypertable was made, which this IR does not record. Measured on timescaledb:2.18.0-pg16:
    //
    //   create_hypertable('a','time', partitioning_column=>'sensor_id')
    //     -> a_time_idx, a_sensor_id_time_idx          (composite CREATED)
    //   create_hypertable('b', by_range('time')); add_dimension('b', by_hash('sensor_id', 4))
    //     -> b_time_idx                                (composite NOT created)
    //
    // The second sequence is the one THIS LIBRARY emits (`core/src/sql/hypertable.ts`), so for
    // hypertables it manages the composite does not exist. A previous revision derived it anyway,
    // which would have filtered a user's own `<table>_<space>_<time>_idx` — over-filtering, the
    // silent direction. Reconstruction therefore covers only what this library itself creates;
    // anything else must come from the catalog via `knownAutoIndexes`.
    for (const dim of ht.dimensions) {
      if (dim.kind !== 'time') continue;
      const k = key(
        { ...parsed, name: makeObjectName(parsed.name, dim.column, 'idx') },
        defaultSchema,
      );
      autoIndexes.add(k);
      autoIndexColumns.set(k, [dim.column]);
    }
  }

  for (const known of options.knownAutoIndexes ?? []) autoIndexes.add(qualify(known));

  const continuousAggregates = new Set(
    (state.continuousAggregates ?? []).map((c) => qualify(c.viewName)),
  );

  return { hypertables, autoIndexes, autoIndexColumns, continuousAggregates, defaultSchema };
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

/**
 * Schemas that are entirely TimescaleDB's.
 *
 * Not written from memory. Enumerated from a live 2.18.0 container — the floor of the supported
 * range — by asking Postgres which namespaces the extension actually owns:
 *
 * ```sql
 * SELECT n.nspname FROM pg_namespace n
 *   JOIN pg_depend d ON d.objid = n.oid AND d.classid = 'pg_namespace'::regclass
 *   JOIN pg_extension e ON e.oid = d.refobjid
 *  WHERE e.extname LIKE 'timescaledb%';
 * ```
 *
 * That found `_timescaledb_functions` AND `_timescaledb_debug` missing from an earlier draft; the
 * review had spotted only the first. Same lesson as the `ALTER TYPE` gap: ask the system, do not
 * recall.
 */
const INTERNAL_SCHEMAS = new Set([
  '_timescaledb_cache',
  '_timescaledb_catalog',
  '_timescaledb_config',
  '_timescaledb_debug',
  '_timescaledb_functions',
  '_timescaledb_internal',
  'timescaledb_experimental',
  'timescaledb_information',
]);

/** Extensions whose lifecycle this library owns, not TypeORM's entity metadata. */
const OWNED_EXTENSIONS = new Set(['timescaledb', 'timescaledb_toolkit']);

/**
 * A possibly schema-qualified object name.
 *
 * Quoted identifiers are matched first and understand Postgres's doubled-quote escape, so
 * `"users"("id" ...)` yields `users` and `"a""b"` yields the single identifier `a"b` rather than
 * stopping at the inner quote. A space-delimited fallback covers unquoted names.
 */
const QUOTED = String.raw`"(?:[^"]|"")*"`;
const OBJ = String.raw`(?<obj>${QUOTED}(?:\.${QUOTED})*|[^\s(;]+)`;

/**
 * `ALTER <kind> <obj> RENAME TO "new"` — the destination of a rename.
 *
 * ANCHORED to the head of the statement rather than searched for anywhere in the text. A free
 * `\bRENAME\s+TO\b` scan also matches inside string literals and comments, so a legitimate
 * `CREATE VIEW "notes" AS SELECT 'RENAME TO "readings_hourly"'` looked like a rename onto an owned
 * aggregate and was silently filtered — the over-filtering direction again.
 */
const RENAME_TO = new RegExp(
  String.raw`^\s*ALTER\s+(?:INDEX|TABLE|(?:MATERIALIZED\s+)?VIEW)\s+(?:ONLY\s+|IF\s+EXISTS\s+)?` +
    String.raw`(?:${QUOTED}(?:\.${QUOTED})*|[^\s(;]+)\s+RENAME\s+TO\s+(?<dest>${QUOTED}|[^\s(;]+)`,
  'i',
);

/**
 * The `ON <table> [USING m] (<cols>)` tail of a `CREATE INDEX`, matched against the text AFTER the
 * index name has already been consumed.
 *
 * Anchored with `^` on the remainder rather than scanned from the head of the statement. A lazy
 * `[\s\S]*?\bON\s+` scan could match an `ON` occurring INSIDE a quoted index name — so
 * `CREATE INDEX "foo ON _timescaledb_internal.x" ON "analytics"."events" ("ts")` resolved the
 * user's analytics index into an internal schema and silently filtered it.
 *
 * `cols` deliberately refuses to match nested parentheses. An expression index such as
 * `(lower(name))` therefore yields no column list, and an unparsed definition is treated as
 * "cannot prove this is the auto index" rather than assumed to be one.
 */
const CREATE_INDEX_TAIL = new RegExp(
  String.raw`^\s*ON\s+(?:ONLY\s+)?(?<table>${QUOTED}(?:\.${QUOTED})*|[^\s(;]+)` +
    String.raw`(?:\s+USING\s+(?<using>\w+))?\s*(?:\((?<cols>[^()]*)\))?(?<rest>[\s\S]*)$`,
  'i',
);

/**
 * Column names from an index column list, or `undefined` if the list carries anything this filter
 * cannot account for.
 *
 * A trailing `DESC` is accepted because that is how `create_hypertable` builds the time index. An
 * explicit `ASC` or `NULLS` ordering is NOT: it denotes a different index, and TypeORM never emits
 * one (`createIndexSql` joins bare `"col"` names), so refusing costs nothing real.
 */
function indexColumns(cols: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of cols.split(',')) {
    const part = raw
      .trim()
      .replace(/\s+DESC$/i, '')
      .trim();
    if (part.length === 0) return undefined;
    if (/\s/.test(part.replace(/^"(?:[^"]|"")*"$/, ''))) return undefined; // ASC / NULLS / expression
    out.push(part.startsWith('"') ? parseQualified(part).name : part.toLowerCase());
  }
  return out.length > 0 ? out : undefined;
}

/** `CREATE TABLE "schema"."name"` — used to spot tables this diff creates. */
const CREATE_TABLE_TARGET = new RegExp(
  String.raw`^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${OBJ}`,
  'i',
);

/** What kind of object a recognised statement targets. */
type TargetKind = 'index' | 'table' | 'view' | 'schema' | 'extension' | 'other' | 'none';

const recognise = (body: string, target: TargetKind) => ({
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
 * Every entry that names an object CAPTURES it. An earlier draft short-circuited the
 * schema/extension verbs to `keep` without reading their target, which would have let
 * `DROP SCHEMA "_timescaledb_internal" CASCADE` through — destroying a schema this very module
 * declares entirely Timescale-owned.
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
  recognise(
    String.raw`(?:CREATE|DROP|ALTER)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${OBJ}`,
    'schema',
  ),
  recognise(
    String.raw`(?:CREATE|DROP|ALTER)\s+EXTENSION\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${OBJ}`,
    'extension',
  ),
  recognise(
    String.raw`(?:CREATE|DROP|ALTER)\s+(?:TYPE|SEQUENCE|FUNCTION|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${OBJ}`,
    'other',
  ),
  recognise(String.raw`(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+${OBJ}`, 'table'),
  // Metadata only, and its target may be a column or constraint rather than a relation.
  recognise(String.raw`COMMENT\s+ON\b`, 'none'),
] as const;

/**
 * Cross-statement context, which a single statement cannot supply on its own.
 *
 * Only {@link filterTypeormDiff} can build this, because it is the only caller that sees both
 * sides of the diff at once.
 */
export interface ClassifyContext {
  /**
   * Qualified names of tables CREATED by the up side of this same diff.
   *
   * A `DROP TABLE` in `down` that inverts a `CREATE TABLE` in `up` is not the destructive removal
   * of an existing hypertable — it is the ordinary inverse of a table this migration creates.
   * Without this distinction the composer refuses every INITIAL migration for a new hypertable,
   * which is the milestone's primary use case.
   */
  readonly createdTables?: ReadonlySet<string>;
}

/** Classify a single statement against the owned set. */
export function classifyTypeormStatement(
  sql: string,
  owned: TimescaleOwnedObjects,
  context: ClassifyContext = {},
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

  if (match.target === 'none') return { verdict: 'keep' };

  const raw = match.re.exec(sql)?.groups?.['obj'];
  if (raw === undefined) {
    return {
      verdict: 'unclassified',
      reason: 'the target object could not be read from the statement',
    };
  }

  const parsed = parseQualified(raw);

  // Parse the CREATE INDEX tail from the text AFTER the index name, never by scanning the whole
  // statement — an `ON` inside a quoted index name would otherwise be read as the table clause.
  const head = match.re.exec(sql);
  const isCreateIndex = match.target === 'index' && /^\s*CREATE\b/i.test(sql);
  const tail =
    isCreateIndex && head !== null
      ? CREATE_INDEX_TAIL.exec(sql.slice(head.index + head[0].length))
      : null;

  // `CREATE INDEX` cannot qualify its index name — Postgres creates the index in the schema of the
  // table being indexed, so that is where the name must be resolved.
  const indexSchema =
    parsed.schema === undefined ? parseQualified(tail?.groups?.['table'] ?? '').schema : undefined;
  const resolved: QualifiedName =
    indexSchema !== undefined ? { schema: indexSchema, name: parsed.name } : parsed;
  const qualified = key(resolved, owned.defaultSchema);

  // Internal-object NAMES only establish ownership inside an internal SCHEMA. TimescaleDB puts
  // chunks, materialization hypertables and partial/direct views exclusively in its own schemas, so
  // a `app._hyper_1_1_chunk` is a user table with an unfortunate name — and filtering it would
  // silently delete their DDL. The name still refines the reason, which is worth keeping.
  // Uses RESOLVED, not `parsed`. For `CREATE INDEX "n" ON "_timescaledb_internal"."t"` the index
  // name cannot be qualified, so `parsed.schema` is undefined and this guard silently did not fire
  // — leaving an index creation against a Timescale-owned internal table in the migration.
  // `?? owned.defaultSchema` because that is how `key()` resolves an unqualified name. Without it
  // the two disagreed: with `defaultSchema: '_timescaledb_internal'`, `DROP TABLE "_hyper_1_1_chunk"`
  // keyed into an internal schema but was classified as ordinary user DDL.
  const effectiveSchema = resolved.schema ?? owned.defaultSchema;
  if (INTERNAL_SCHEMAS.has(effectiveSchema)) {
    const internal = INTERNAL_PATTERNS.find((p) => p.re.test(resolved.name));
    return {
      verdict: 'filtered',
      object: raw,
      reason:
        internal !== undefined
          ? `is ${internal.what}, created and owned by TimescaleDB`
          : `lives in ${effectiveSchema}, which is TimescaleDB's own schema`,
    };
  }

  if (match.target === 'schema' && INTERNAL_SCHEMAS.has(parsed.name)) {
    return {
      verdict: 'filtered',
      object: raw,
      reason: "is one of TimescaleDB's own schemas, which TypeORM must never create or destroy",
    };
  }

  if (match.target === 'extension' && OWNED_EXTENSIONS.has(parsed.name.toLowerCase())) {
    return {
      verdict: 'filtered',
      object: raw,
      reason: 'is an extension whose lifecycle this library owns, not TypeORM entity metadata',
    };
  }

  // A rename must get the SAME disposition at both ends. TypeORM's down statement inverts the
  // rename, so it names the owned object as the DESTINATION rather than the target. Classifying
  // only the target would filter the up statement and keep the down one, leaving a down migration
  // that references an index which was never created.
  const renamed = renameDestination(sql, resolved, owned.defaultSchema);

  if (
    match.target === 'index' &&
    (owned.autoIndexes.has(qualified) || hasOwned(owned.autoIndexes, renamed))
  ) {
    // A CREATE whose name matches a RECONSTRUCTED auto index must also match its DEFINITION.
    // Nothing stops a user declaring `@Index('readings_time_idx', ['value'])` on a new hypertable:
    // the desired-state name collides, but the index is theirs. Filtering it by name alone silently
    // dropped their index and substituted TimescaleDB's. Names that came from the catalog
    // (`knownAutoIndexes`) are authoritative and skip this check.
    const expected = owned.autoIndexColumns.get(qualified);
    if (isCreateIndex && expected !== undefined) {
      const mismatch = autoIndexMismatch(sql, tail, expected);
      if (mismatch !== undefined) {
        return {
          verdict: 'unclassified',
          reason:
            `${raw} has the name create_hypertable() would generate for the time index on ` +
            `(${expected.join(', ')}), but ${mismatch}. Keeping it would collide with the index ` +
            'create_hypertable() creates; dropping it would lose yours. Rename yours to resolve',
        };
      }
    }

    return {
      verdict: 'filtered',
      object: raw,
      reason:
        'is the index create_hypertable() creates on the time column. No entity declares it, so ' +
        'TypeORM proposes dropping it on every run',
    };
  }

  if (
    match.target === 'view' &&
    (owned.continuousAggregates.has(qualified) || hasOwned(owned.continuousAggregates, renamed))
  ) {
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
  if (
    match.target === 'table' &&
    /^\s*DROP\s+TABLE\b/i.test(sql) &&
    owned.hypertables.has(qualified) &&
    // ...unless THIS diff created the table. Then the drop is just the inverse of its own
    // CREATE TABLE, dropping something that did not exist before the migration ran. Refusing it
    // would block the initial composed migration for every new hypertable — the case the whole
    // milestone exists to serve.
    context.createdTables?.has(qualified) !== true
  ) {
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

  // Tables this diff creates. A `DROP TABLE` in `down` that inverts one of these is ordinary, not
  // the destructive removal of an existing hypertable. Only this function can know that, because
  // it is the only place both sides are in scope.
  const createdTables = new Set<string>();
  for (const { sql } of diff.up) {
    const created = CREATE_TABLE_TARGET.exec(sql)?.groups?.['obj'];
    if (created !== undefined) createdTables.add(key(parseQualified(created), owned.defaultSchema));
  }
  const context: ClassifyContext = { createdTables };

  const run = (statements: readonly TypeormStatement[], side: 'up' | 'down'): TypeormStatement[] =>
    statements.filter((statement) => {
      const d = classifyTypeormStatement(statement.sql, owned, context);

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

/** The qualified key of a `RENAME TO` destination, if this statement is a rename. */
function renameDestination(
  sql: string,
  source: QualifiedName,
  defaultSchema: string,
): string | undefined {
  const dest = RENAME_TO.exec(sql)?.groups?.['dest'];
  if (dest === undefined) return undefined;
  // Postgres forbids qualifying the new name, so it inherits the source's schema.
  const name = parseQualified(dest).name;
  return key(
    source.schema !== undefined ? { schema: source.schema, name } : { name },
    defaultSchema,
  );
}

function hasOwned(set: ReadonlySet<string>, qualified: string | undefined): boolean {
  return qualified !== undefined && set.has(qualified);
}

/** Order matters for an index, so this is a positional comparison, not a set comparison. */
function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/**
 * Why a `CREATE INDEX` is NOT the auto index whose name it reuses, or `undefined` if it is.
 *
 * The column list alone is not enough. `@Index('readings_time_idx', ['time'], { unique: true })`
 * and a partial index on the same column both produce a matching column list while being entirely
 * different indexes, so filtering on columns silently removed them. `createIndexSql` can emit
 * `UNIQUE`, an index-type clause and a `WHERE` predicate, and every one of those changes what the
 * index means — so the whole definition must match, and anything unrecognised refuses.
 */
function autoIndexMismatch(
  sql: string,
  tail: RegExpExecArray | null,
  expected: readonly string[],
): string | undefined {
  if (/^\s*CREATE\s+UNIQUE\b/i.test(sql)) {
    return 'this one is UNIQUE, which the auto index is not';
  }

  const using = tail?.groups?.['using'];
  if (using !== undefined && using.toLowerCase() !== 'btree') {
    return `this one uses the ${using} access method, not btree`;
  }

  const trailing = (tail?.groups?.['rest'] ?? '').trim().replace(/;$/, '').trim();
  if (trailing.length > 0) {
    // WHERE, INCLUDE, WITH, TABLESPACE, NULLS NOT DISTINCT — all change the index's meaning.
    return `this one carries an extra clause the auto index does not have (${trailing})`;
  }

  const cols = tail?.groups?.['cols'];
  const actual = cols === undefined ? undefined : indexColumns(cols);
  if (actual === undefined) {
    return 'this one is defined on an expression or ordering this filter cannot read';
  }
  if (!sameColumns(actual, expected)) {
    return `this one defines it on (${actual.join(', ')})`;
  }

  return undefined;
}

/** `{ schema, name }` → the `schema.name` string both sides of a comparison are keyed by. */
function key(n: QualifiedName, defaultSchema: string): string {
  return `${n.schema ?? defaultSchema}.${n.name}`;
}

/**
 * Parse a name that came from the CATALOG rather than from SQL text.
 *
 * `SchemaStateIR` holds raw catalog values — `public.Readings` means a table genuinely named
 * `Readings`, not an unquoted token to be case-folded. Running these through
 * {@link parseQualified} lower-cased them, so a mixed-case hypertable's owned entry never matched
 * the quoted `"public"."Readings_time_idx"` TypeORM emits, and the destructive DROP survived.
 *
 * So: split on the last dot, strip surrounding quotes defensively, and preserve case exactly.
 */
function parseCatalogName(raw: string): QualifiedName {
  const unquote = (s: string): string => s.replace(/^"(.*)"$/s, '$1');
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return { name: unquote(raw) };
  return { schema: unquote(raw.slice(0, dot)), name: unquote(raw.slice(dot + 1)) };
}

/**
 * Parse a possibly-qualified identifier the way Postgres reads one.
 *
 * Quoted parts keep their case and may contain dots or doubled quotes (`"a""b"` is the single
 * identifier `a"b`); unquoted parts fold to lower case. A naive `split('.')` gets all three wrong,
 * and each mistake resolves to no owned object — which falls through to `keep`, the destructive
 * direction for this module.
 */
function parseQualified(raw: string): QualifiedName {
  const parts: string[] = [];
  let i = 0;

  while (i < raw.length) {
    if (raw[i] === '"') {
      let out = '';
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === '"') {
          if (raw[j + 1] !== '"') break;
          out += '"';
          j += 2;
          continue;
        }
        out += raw[j];
        j++;
      }
      parts.push(out);
      i = j + 1; // past the closing quote
      if (raw[i] === '.') i++;
    } else {
      let j = i;
      while (j < raw.length && raw[j] !== '.') j++;
      parts.push(raw.slice(i, j).toLowerCase());
      i = j + 1;
    }
  }

  const name = parts[parts.length - 1] ?? '';
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return schema !== undefined ? { schema, name } : { name };
}

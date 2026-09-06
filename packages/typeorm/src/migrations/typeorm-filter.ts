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

/**
 * Reproduce Postgres's identifier truncation.
 *
 * `create_hypertable` relies on Postgres's standard index naming, so a constructed
 * `<table>_<timecolumn>_idx` longer than 63 bytes is stored TRUNCATED. Keeping the full string
 * would mean `owned.autoIndexes` never matches the name TypeORM actually reports, and the
 * destructive `DROP INDEX` this module exists to remove would survive. Truncation clips on a
 * character boundary, as `pg_mbcliplen` does, rather than splitting a multibyte character.
 *
 * Not reproduced: Postgres's collision suffixes (`_idx1`, `_idx2`, ...), which it appends only when
 * the truncated name is already taken. That case stays unhandled deliberately — guessing a suffix
 * risks filtering a DIFFERENT index, which is the over-filtering direction. See
 * {@link timescaleOwnedObjects} for how a caller supplies real catalog names instead.
 */
function truncateIdentifier(name: string): string {
  const bytes = utf8.encode(name);
  if (bytes.length <= MAX_IDENTIFIER_BYTES) return name;

  let end = MAX_IDENTIFIER_BYTES;
  // Back off while sitting on a UTF-8 continuation byte (0b10xxxxxx).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return fromUtf8.decode(bytes.subarray(0, end));
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
   * {@link truncateIdentifier} reproduces Postgres's naming for the common case, but it cannot know
   * about collision suffixes. A caller introspecting a live database can pass the real names
   * instead.
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
  const qualify = (raw: string): string => key(parseQualified(raw), defaultSchema);

  const hypertables = new Set<string>();
  const autoIndexes = new Set<string>();

  // Catalog names REPLACE reconstruction — see OwnedObjectOptions.knownAutoIndexes. Unioning them
  // would filter the user's own index whenever a collision suffix was the reason for supplying
  // catalog names in the first place.
  const fromCatalog = options.knownAutoIndexes !== undefined;

  for (const ht of state.hypertables) {
    const parsed = parseQualified(ht.table);
    hypertables.add(key(parsed, defaultSchema));

    if (fromCatalog) continue;

    for (const dim of ht.dimensions) {
      // Only the TIME dimension. `create_hypertable` indexes that column; a space dimension gets no
      // such index, so deriving one would filter a user's own index that shared the name.
      if (dim.kind !== 'time') continue;
      const indexName = truncateIdentifier(`${parsed.name}_${dim.column}_idx`);
      autoIndexes.add(key({ ...parsed, name: indexName }, defaultSchema));
    }
  }

  for (const known of options.knownAutoIndexes ?? []) autoIndexes.add(qualify(known));

  const continuousAggregates = new Set(
    (state.continuousAggregates ?? []).map((c) => qualify(c.viewName)),
  );

  return { hypertables, autoIndexes, continuousAggregates, defaultSchema };
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

/** `... RENAME TO "new_name"` — the destination of a rename, always unqualified in Postgres. */
const RENAME_TO = new RegExp(String.raw`\bRENAME\s+TO\s+(?<dest>${QUOTED}|[^\s(;]+)`, 'i');

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

  if (match.target === 'none') return { verdict: 'keep' };

  const raw = match.re.exec(sql)?.groups?.['obj'];
  if (raw === undefined) {
    return {
      verdict: 'unclassified',
      reason: 'the target object could not be read from the statement',
    };
  }

  const parsed = parseQualified(raw);
  const qualified = key(parsed, owned.defaultSchema);

  // Internal-object NAMES only establish ownership inside an internal SCHEMA. TimescaleDB puts
  // chunks, materialization hypertables and partial/direct views exclusively in its own schemas, so
  // a `app._hyper_1_1_chunk` is a user table with an unfortunate name — and filtering it would
  // silently delete their DDL. The name still refines the reason, which is worth keeping.
  if (parsed.schema !== undefined && INTERNAL_SCHEMAS.has(parsed.schema)) {
    const internal = INTERNAL_PATTERNS.find((p) => p.re.test(parsed.name));
    return {
      verdict: 'filtered',
      object: raw,
      reason:
        internal !== undefined
          ? `is ${internal.what}, created and owned by TimescaleDB`
          : `lives in ${parsed.schema}, which is TimescaleDB's own schema`,
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
  const renamed = renameDestination(sql, parsed, owned.defaultSchema);

  if (
    match.target === 'index' &&
    (owned.autoIndexes.has(qualified) || hasOwned(owned.autoIndexes, renamed))
  ) {
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
    owned.hypertables.has(qualified)
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

/** `{ schema, name }` → the `schema.name` string both sides of a comparison are keyed by. */
function key(n: QualifiedName, defaultSchema: string): string {
  return `${n.schema ?? defaultSchema}.${n.name}`;
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

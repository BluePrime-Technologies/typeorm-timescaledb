import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import type { GeneratedMigration } from './generate.js';
import { resolveMigrationName } from './generate.js';
import type { TypeormDiff } from './typeorm-diff.js';
import type { FilteredStatement, FilterMode, TimescaleOwnedObjects } from './typeorm-filter.js';
import { createdTableKeys, filterTypeormDiff, parseQualified } from './typeorm-filter.js';

/**
 * The composer — slice 3 of M4.5 (#235).
 *
 * Slice 1 reads TypeORM's half of the diff and slice 2 decides which of its statements survive.
 * This joins them to the TimescaleDB half so ONE command produces ONE migration, closing the
 * `PULL_BASE_DDL_CAVEAT` gap where a `create_hypertable` was emitted against a table this engine
 * never creates and the user had to run two generators and hand-merge them.
 *
 * Ordering is settled by the dependency, not by preference.
 */

/** One statement in a composed migration, with its bound parameters preserved. */
export interface ComposedStatement {
  /** The SQL text. */
  readonly sql: string;
  /**
   * Bound parameters, when the statement has any. Absent (not `[]`) when it does not.
   *
   * Only TypeORM's half can carry these — every TimescaleDB statement is literal DDL built by the
   * core SQL choke point. See {@link renderComposedMigrationSql} for why the `.sql` target is the
   * one surface that cannot accept them.
   */
  readonly parameters?: readonly unknown[];
}

/** A migration composed from TypeORM's base DDL and the TimescaleDB layer. */
export interface ComposedMigration {
  /** TypeORM migration class name, e.g. `Timescale1700000000000`. */
  readonly name: string;
  /** Timestamp embedded in the name — also TypeORM's ordering key. */
  readonly timestamp: number;
  /** Statements that bring the database up, base DDL first. */
  readonly up: readonly ComposedStatement[];
  /** The inverse, TimescaleDB first. Never destructive on the TimescaleDB half. */
  readonly down: readonly ComposedStatement[];
  /**
   * TypeORM statements the filter removed, and why.
   *
   * Surfaced rather than discarded: composition silently deleting a statement the user can see in
   * `migration:generate` is the failure this milestone must not ship.
   */
  readonly filtered: readonly FilteredStatement[];
}

/** Options for {@link composeMigration}. */
export interface ComposeMigrationOptions {
  /** Class-name prefix. Defaults to the name already on the TimescaleDB migration. */
  readonly name?: string;
  /** Timestamp override. Defaults to the one already on the TimescaleDB migration. */
  readonly timestamp?: number;
  /** Passed through to {@link filterTypeormDiff}. Default `'filter'`. */
  readonly mode?: FilterMode;
}

/**
 * Compose TypeORM's base DDL with the TimescaleDB layer into a single migration.
 *
 * **Ordering is forced by the dependency.** `create_hypertable` converts a table that must already
 * exist, so:
 *
 * - `up` — TypeORM's statements first, then the TimescaleDB plan.
 * - `down` — the exact reverse: the TimescaleDB plan's own inverse first, then TypeORM's `down`
 *   REVERSED.
 *
 * That last reversal is not a stylistic choice and not symmetry for its own sake. TypeORM
 * accumulates `downQueries` in the same order as `upQueries` (`BaseQueryRunner` pushes to both),
 * and reverses them at the point of use — `MigrationGenerateCommand` emits `downSqls.reverse()`
 * and `executeMemoryDownSql` iterates `downQueries.reverse()`. Slice 1 therefore preserved
 * TypeORM's raw order deliberately, so that this function stays byte-comparable with
 * `migration:generate`; reversing here is what makes the composed `down` actually correct.
 *
 * The name and timestamp default to the TimescaleDB migration's, keeping TypeORM's 13-digit
 * ordering key so a composed migration sorts correctly against hand-written TypeORM migrations.
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` via {@link filterTypeormDiff} when a TypeORM
 *   statement cannot be classified, or — in `'strict'` mode — when one merely needs filtering.
 */
export function composeMigration(
  typeorm: TypeormDiff,
  timescale: GeneratedMigration,
  owned: TimescaleOwnedObjects,
  options: ComposeMigrationOptions = {},
): ComposedMigration {
  const { diff, filtered } = filterTypeormDiff(typeorm, owned, {
    ...(options.mode !== undefined && { mode: options.mode }),
  });

  const literal = (sql: string): ComposedStatement => ({ sql });

  // A hypertable rename on the TimescaleDB half collides with TypeORM creating that same name.
  // Only `up` needs checking: the inverse pairing in `down` is DROP + RENAME, which has no
  // collision, and refusing here blocks the whole composition anyway.
  assertRenameTargetNotCreated(diff.up, timescale.up, owned.defaultSchema);

  // Resolve the PAIR, never independently. The 13-digit suffix in the class name is TypeORM's
  // ordering key and the renderer emits only the name, so a `timestamp` override that does not
  // reach the name silently does nothing — and a `name` prefix used verbatim would produce a class
  // with no ordering key at all. `name` is a PREFIX here, matching every other generator.
  const prefix = (options.name ?? timescale.name).replace(/\d{13}$/, '');
  const { name, timestamp } = resolveMigrationName(
    prefix,
    options.timestamp ?? timescale.timestamp,
  );

  return {
    name,
    timestamp,
    // Base DDL, then the TimescaleDB layer that depends on it.
    up: [...diff.up, ...timescale.up.map(literal)],
    // The exact inverse: undo TimescaleDB first, then TypeORM's own down in reverse.
    down: [...timescale.down.map(literal), ...[...diff.down].reverse()],
    filtered,
  };
}

/** `ALTER TABLE a RENAME TO b` — the TimescaleDB half's `renameHypertable` SQL. */
const RENAME_TABLE =
  /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?(?<from>"(?:[^"]|"")*"(?:\."(?:[^"]|"")*")*|[^\s(;]+)\s+RENAME\s+TO\s+(?<to>"(?:[^"]|"")*"|[^\s(;]+)/i;

/**
 * Schema-qualified key of a rename's DESTINATION, or `undefined` if the statement is not a rename.
 *
 * `RENAME TO` takes an unqualified name — Postgres keeps the table in its existing schema — so the
 * destination inherits the source's. Parsed with slice 2's quote-aware {@link parseQualified}
 * rather than a local `split('.')`, which broke on a quoted name CONTAINING a period
 * (`"analytics"."old.name"` split into three parts and dropped the real schema).
 *
 * The `?? defaultSchema` fallback is DEFENSIVE and deliberately untested. The only producer of
 * these statements is `renameHypertableSQL`, which builds its source through `parseTable` — and
 * that always returns a qualified `ident` (`quoteIdent(schema).quoteIdent(name)`, schema defaulting
 * to `public`), so an unqualified source never arrives. It is kept rather than removed because the
 * two failure directions are not symmetric: with the fallback an unqualified source resolves and
 * the guard still fires, whereas without it the key becomes `undefined.<name>`, matches nothing,
 * and the collision ships SILENTLY. Writing a test for it would mean hand-building a statement
 * shape the producer cannot emit — the exact habit that let the previous guard certify itself.
 */
function renameDestinationKey(sql: string, defaultSchema: string): string | undefined {
  const m = RENAME_TABLE.exec(sql);
  const from = m?.groups?.['from'];
  const to = m?.groups?.['to'];
  if (from === undefined || to === undefined) return undefined;
  const schema = parseQualified(from).schema ?? defaultSchema;
  return `${schema}.${parseQualified(to).name}`;
}

/**
 * Refuse a hypertable rename whose destination TypeORM is CREATING in the same migration.
 *
 * This replaces a guard that could never fire. The earlier version looked for the same rename on
 * BOTH halves, on the stated premise that "TypeORM's diff independently detected the same rename —
 * which it will, because renaming an entity's table is base DDL and TypeORM owns base DDL". That
 * premise is false, and the plan for this milestone warned in writing against exactly how it was
 * arrived at: derive TypeORM's behaviour from its source, never from memory.
 *
 * `readTypeormDiff` is a pass-through to `RdbmsSchemaBuilder`, which has NO table-rename step —
 * `executeSchemaSyncOperationsInProperOrder()` lists `renameColumns()` and `createNewTables()` and
 * nothing that renames a table (`renameTable` appears zero times in the file). `PostgresQueryRunner`
 * can emit `ALTER TABLE ... RENAME TO`, but only from a hand-written migration, never from the
 * schema builder. So the old guard's map was always empty and it returned before looking at the
 * TimescaleDB half.
 *
 * Checking that the grep for `rename` in `typeorm-diff.ts` returns zero is NOT the argument — that
 * file only forwards TypeORM's output. The reachability of `RdbmsSchemaBuilder` is.
 *
 * The collision that IS reachable was therefore unguarded. Renaming a hypertable entity
 * (`@Hypertable({ renamedFrom })`) makes `diffSchemaState` emit `renameHypertable` on the
 * TimescaleDB half, while TypeORM — diffing the same database, where the new name does not exist
 * yet — emits `CREATE TABLE` for it. Both survive the filter, which refuses only `DROP TABLE` on an
 * owned hypertable, so the composed `up` reads:
 *
 * ```sql
 * CREATE TABLE "public"."sensor_data" (...);              -- TypeORM
 * ALTER TABLE "public"."readings" RENAME TO "sensor_data"; -- TimescaleDB
 * -- ERROR: relation "sensor_data" already exists
 * ```
 *
 * Refused rather than de-duplicated, and which side you would drop is not obvious — which is the
 * point. Dropping the rename strands the original hypertable's data under the old name behind a new
 * empty table; dropping the CREATE assumes TypeORM's column set matches what the rename preserves.
 * Failing at generate time is strictly better than either.
 */
function assertRenameTargetNotCreated(
  typeormUp: readonly ComposedStatement[],
  timescaleUp: readonly string[],
  defaultSchema: string,
): void {
  const created = createdTableKeys(
    typeormUp.map((s) => s.sql),
    defaultSchema,
  );
  for (const sql of timescaleUp) {
    const destination = renameDestinationKey(sql, defaultSchema);
    if (destination === undefined || !created.has(destination)) continue;
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `Cannot compose: the TimescaleDB half renames a table onto "${destination}", which TypeORM ` +
        `creates in the same migration — the rename would fail with "relation already exists". ` +
        `This is what a renamed @Hypertable entity looks like to the two engines: TypeORM sees a ` +
        `table it has never seen and creates it; this engine sees the old one and renames it. ` +
        `Resolve by hand — dropping the rename would strand the original hypertable's data under ` +
        `its old name behind a new empty table.\n  TimescaleDB: ${sql}`,
      { side: 'up', destination, timescale: sql },
    );
  }
}

/**
 * Statements in `migration` that cannot run inside a transaction block.
 *
 * Exported because the `.ts` target cannot simply refuse them the way the `.sql` target does.
 * `CREATE INDEX CONCURRENTLY` is a legitimate thing to want, and TypeORM supports running
 * migrations untransacted — so refusing would block a valid setup. But TypeORM's `MigrationExecutor`
 * defaults to `migrationsTransactionMode: 'all'`, which means the emitted class fails by default
 * unless the DataSource is configured for it. Silence is the one option that is definitely wrong,
 * so the renderer annotates the artifact and callers (the CLI, in slice 4) can warn.
 */
export function nonTransactionalStatements(
  migration: ComposedMigration,
): readonly ComposedStatement[] {
  return [...migration.up, ...migration.down].filter((s) => NON_TRANSACTIONAL.test(s.sql));
}

/**
 * Render a {@link ComposedMigration} as TypeORM migration TypeScript source.
 *
 * Parameters are written as `queryRunner.query()`'s SECOND argument, exactly as
 * `MigrationGenerateCommand.queryParams()` does. They stay bound rather than being inlined, so this
 * introduces no injection surface — and it is why the reader carries parameters instead of
 * refusing them (a single `@ViewEntity` emits two parameterised statements).
 */
export function renderComposedMigration(migration: ComposedMigration): string {
  const body = (statements: readonly ComposedStatement[]): string =>
    statements.length === 0
      ? '    // no-op'
      : statements
          .map(({ sql, parameters }) => {
            // Match queryParams()'s own `!parameters?.length` test: an empty array emits nothing.
            const bound =
              parameters !== undefined && parameters.length > 0
                ? `, ${JSON.stringify(parameters)}`
                : '';
            return `    await queryRunner.query(${JSON.stringify(sql)}${bound});`;
          })
          .join('\n');

  const untransacted = nonTransactionalStatements(migration);
  const transactionWarning =
    untransacted.length === 0
      ? ''
      : `\n// ⚠ REQUIRES migrationsTransactionMode: 'none' (or running these outside the migration).\n` +
        `// TypeORM's MigrationExecutor defaults to 'all', which wraps this class in a transaction,\n` +
        `// and the following cannot run inside one:\n${untransacted
          .map((s) => commentEveryLine(s.sql, '//   '))
          .join('\n')}\n`;

  const note =
    migration.filtered.length === 0
      ? ''
      : `\n// Statements removed because TimescaleDB owns their target (not lost — listed for review):\n${migration.filtered
          .map((f) =>
            commentEveryLine(
              `[${f.side}] ${f.object} — ${f.reason}\n  ${f.statement.sql}`,
              '//   ',
            ),
          )
          .join('\n')}\n`;

  return `// Generated by typeorm-timescaledb — regenerate rather than editing by hand.
// Base relational DDL comes from TypeORM's own schema diff; the TimescaleDB layer is
// appended after it, because create_hypertable converts a table that must already exist.
// down() reverses that: the TimescaleDB layer is undone first. The TimescaleDB half is
// intentionally non-destructive — hypertable and columnstore conversions are NOT reverted.${transactionWarning}${note}
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
 * Prefix EVERY line of a statement, not just the first.
 *
 * Filtered SQL is echoed into both artifacts so a removed statement stays reviewable. A statement
 * containing newlines — a multi-line `@ViewEntity` expression, say — then leaks: in the `.sql`
 * artifact its continuation lines become executable SQL sitting ABOVE the `-- Up` section and
 * outside its transaction, and in the `.ts` artifact they become invalid TypeScript.
 */
function commentEveryLine(sql: string, prefix: string): string {
  return sql
    .split(LINE_TERMINATORS)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/**
 * Every character that ends a line for the consumers of these artifacts.
 *
 * `\n` alone is not enough. A quoted identifier may contain a bare `\r`, which ends a Postgres
 * `--` comment, or `\u2028`/`\u2029`, which JavaScript treats as line terminators — so a `//`
 * annotation would end early and the text after it would become source code sitting above the
 * import. Splitting on all of them and rejoining with `\n` also NORMALISES the output, so no exotic
 * terminator survives into the artifact at all.
 */
const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/;

/**
 * Statements that cannot run inside a transaction block, so cannot be wrapped in BEGIN/COMMIT.
 *
 * Anchored to the actual command syntax rather than searching the whole statement for the token.
 * A bare `\bCONCURRENTLY\b` also matches the word inside a string literal, quoted identifier or
 * comment — `CREATE TABLE t (c text DEFAULT 'concurrently')` is perfectly transaction-safe and was
 * being refused. CONCURRENTLY is only meaningful directly after the index command.
 *
 * Two assumptions are recorded here rather than coded around, because coding around them would
 * reintroduce exactly the comment-scanning the round-6 cleanup deleted:
 *
 * 1. `^\s*` skips whitespace, not comments, so a statement PREFIXED with `--` or a block comment
 *    would not match and would be wrapped in BEGIN/COMMIT. Neither half prefixes comments onto
 *    generated SQL — TypeORM builds bare DDL strings and the TimescaleDB half comes from the core
 *    SQL choke point — so no reachable input defeats it.
 * 2. The list covers what these two halves can emit, not every transaction-gated Postgres command.
 *    `ALTER SYSTEM`, `CLUSTER`, `CREATE`/`DROP TABLESPACE` and `CREATE SUBSCRIPTION` are also
 *    gated and deliberately absent, being unreachable from either producer.
 */
const NON_TRANSACTIONAL =
  /^\s*(?:(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX(?:\s+\w+)?)\s+CONCURRENTLY\b|(?:VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE)\b)/i;

/** Options for {@link renderComposedMigrationSql}. */
export interface RenderSqlOptions {
  /**
   * Which direction to emit. Default `'up'`.
   *
   * Deliberately one per artifact rather than both in one file — see the note on
   * {@link renderComposedMigrationSql}.
   */
  readonly section?: 'up' | 'down';
}

/**
 * Render a {@link ComposedMigration} as a raw `.sql` artifact.
 *
 * This is the one target that REFUSES rather than degrades, on two counts.
 *
 * **Bound parameters.** A `.sql` file has nothing to bind them to. The alternative — inlining the
 * values into the SQL text — would re-create exactly the injection surface every builder in this
 * repo avoids, so the refusal happens here, with the whole statement in hand, rather than in the
 * reader (which cannot know which target it is feeding).
 *
 * **Non-transactional statements.** Each section is wrapped in `BEGIN`/`COMMIT` so a failure
 * part-way through rolls back instead of leaving a half-applied schema. That was safe when this
 * emitter only ever saw the Operation union, which is entirely DDL and policy calls. It is NOT
 * safe now that TypeORM's half joins: `CREATE INDEX CONCURRENTLY` — which TypeORM emits whenever
 * an index is declared concurrent — cannot run inside a transaction block and would fail at apply
 * time, inside a wrapper this emitter added. Refusing is the honest outcome; the `.ts` target has
 * no such constraint and takes these fine.
 *
 * **One direction per artifact.** `-- Down` used to sit below `-- Up` in the same file, but a raw
 * `.sql` artifact is run by psql or a plain SQL runner, where a `--` heading delimits nothing: the
 * runner commits the up section and then immediately executes the down one. For the TimescaleDB-only
 * emitter that was survivable, because its `down` only removes policies. It is NOT survivable now
 * that TypeORM's half is composed in — the down section drops the very table the up section just
 * created, so running the file end to end would build the schema and then destroy it. Each call
 * therefore emits exactly one direction, and the whole file is safe to run.
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` on a parameterised or non-transactional statement in
 *   the section being emitted.
 */
export function renderComposedMigrationSql(
  migration: ComposedMigration,
  options: RenderSqlOptions = {},
): string {
  const side = options.section ?? 'up';
  const statements = side === 'up' ? migration.up : migration.down;

  const check = (statements: readonly ComposedStatement[], side: 'up' | 'down'): void => {
    for (const { sql, parameters } of statements) {
      if (parameters !== undefined && parameters.length > 0) {
        throw new TimescaleError(
          TimescaleErrorCode.INVALID_ARGUMENT,
          `Cannot emit .sql: a statement in the ${side} section carries bound parameters, which a ` +
            `raw SQL artifact cannot supply. Inlining them would create an injection surface. Emit ` +
            `.ts instead, which binds them as queryRunner.query()'s second argument: ${sql}`,
          { side, sql, parameters: parameters.length },
        );
      }
      if (NON_TRANSACTIONAL.test(sql)) {
        throw new TimescaleError(
          TimescaleErrorCode.INVALID_ARGUMENT,
          `Cannot emit .sql: a statement in the ${side} section cannot run inside a transaction ` +
            `block, and every section here is wrapped in BEGIN/COMMIT so a partial failure rolls ` +
            `back. Emitting .ts is NOT on its own a fix: TypeORM's MigrationExecutor defaults to ` +
            `migrationsTransactionMode: 'all', so it would wrap the migration in a transaction too. ` +
            `Run this statement outside the migration, or set migrationsTransactionMode: 'none' on ` +
            `the DataSource: ${sql}`,
          { side, sql },
        );
      }
    }
  };
  // Only the section being emitted is checked: a `CREATE INDEX CONCURRENTLY` in `down` must not
  // block emitting a perfectly valid `up` artifact.
  check(statements, side);

  // Deciding whether a statement is ALREADY terminated turned out to need a Postgres lexer, and a
  // hand-rolled one was wrong seven times across six review rounds: last-character vs last token,
  // line comments, quoted identifiers, CR and Unicode line separators, block comments, NESTED block
  // comments, dollar-quoted strings. Each miss produced an artifact that fails to apply.
  //
  // So it no longer tries. Verified on a live container: Postgres accepts a redundant empty
  // statement (`SELECT 1;` followed by a bare `;`), which makes the failure directions wildly
  // asymmetric — a spare `;` is inert, a missing one is fatal. A trailing `;` is therefore trusted
  // only when the last line carries no `--` that could be hiding it; everything else gets a
  // terminator on its own line, which is valid whatever the statement contains. That is correct for
  // dollar quotes and nested comments for free, without knowing they exist.
  const terminate = (sql: string): string => {
    const trimmed = sql.trimEnd();
    // `!includes('--')` over the WHOLE statement, not just its last line. Restricting it to the last
    // line saves a redundant `;` on a multi-line statement whose comment is early — an optimisation,
    // not a safety property, and one more piece of cleverness to keep tested. Both are safe; this
    // one is simpler.
    if (trimmed.endsWith(';') && !trimmed.includes('--')) return trimmed;
    // Only the constructs that can HIDE a terminator matter. A newline cannot: a multi-line
    // statement with no comment and no dollar quote takes an inline `;` perfectly well.
    return /--|\/\*|\$/.test(trimmed) ? `${trimmed}\n;` : `${trimmed};`;
  };
  const sqlSection = (statements: readonly ComposedStatement[]): string =>
    statements.length === 0
      ? '-- no-op'
      : ['BEGIN;', ...statements.map((s) => terminate(s.sql)), 'COMMIT;'].join('\n');

  // Scoped to the direction being emitted. Listing the other half's removals in a single-direction
  // artifact is the same inconsistency the one-artifact-per-direction change fixed for statements —
  // a reader of the up file should not have to work out which notes apply to it.
  const removedHere = migration.filtered.filter((f) => f.side === side);
  const note =
    removedHere.length === 0
      ? ''
      : `${removedHere
          .map((f) =>
            commentEveryLine(
              `removed [${f.side}] ${f.object} — ${f.reason}\n  ${f.statement.sql}`,
              '-- ',
            ),
          )
          .join('\n')}\n\n`;

  const counterpart = side === 'up' ? 'down' : 'up';
  const intent =
    side === 'up'
      ? `-- Base relational DDL comes from TypeORM's own schema diff; the TimescaleDB layer is
-- appended after it, because create_hypertable converts a table that must already exist.`
      : `-- The TimescaleDB layer is undone first, then TypeORM's base DDL in reverse.
-- The TimescaleDB half is non-destructive: hypertable and columnstore conversions are
-- NOT reverted. TypeORM's half CAN be destructive — it may drop tables it created.`;

  return `-- Generated by typeorm-timescaledb — regenerate rather than editing by hand.
-- Migration: ${migration.name}  (${side.toUpperCase()})
${intent}
-- Wrapped in a transaction: a failure part-way through rolls the whole thing back
-- rather than leaving a half-applied schema.
--
-- This artifact contains the ${side.toUpperCase()} direction ONLY, and is safe to run end to end.
-- Render the ${counterpart} separately: renderComposedMigrationSql(m, { section: '${counterpart}' }).

${note}${sqlSection(statements)}
`;
}

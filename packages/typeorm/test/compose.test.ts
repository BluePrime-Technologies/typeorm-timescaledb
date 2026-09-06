import { describe, expect, it } from 'vitest';
import {
  TimescaleError,
  TimescaleErrorCode,
  type SchemaStateIR,
} from '@blueprime/timescaledb-core';
import {
  composeMigration,
  nonTransactionalStatements,
  renderComposedMigration,
  renderComposedMigrationSql,
} from '../src/migrations/compose.js';
import { timescaleOwnedObjects } from '../src/migrations/typeorm-filter.js';
import type { TypeormDiff } from '../src/migrations/typeorm-diff.js';
import type { GeneratedMigration } from '../src/migrations/generate.js';

/**
 * Slice 3 of M4.5 (#235) — the composer.
 *
 * The thing worth testing hardest is ORDERING, because getting it wrong produces a migration that
 * looks plausible and fails at apply time: `create_hypertable` against a table that does not exist
 * yet, or a `down` that drops the table before removing the policies attached to it.
 */
const state: SchemaStateIR = {
  hypertables: [
    {
      table: 'public.readings',
      dimensions: [{ column: 'time', kind: 'time', chunkInterval: '1 day' }],
    },
  ],
};
const owned = timescaleOwnedObjects(state);

/** Same, plus a continuous aggregate — used where a filtered VIEW statement is needed. */
const ownedWithCagg = timescaleOwnedObjects({
  ...state,
  continuousAggregates: [
    {
      viewName: 'public.readings_hourly',
      source: 'public.readings',
      hierarchical: false,
      materializedOnly: false,
      definition: 'SELECT 1',
    },
  ],
});

/** TypeORM's half: creates the table, plus the auto-index drop the filter must remove. */
const typeorm: TypeormDiff = {
  up: [
    { sql: 'CREATE TABLE "readings" ("time" TIMESTAMPTZ NOT NULL, "value" double precision)' },
    { sql: 'CREATE INDEX "readings_value_idx" ON "readings" ("value")' },
    { sql: 'DROP INDEX "public"."readings_time_idx"' },
  ],
  down: [
    // TypeORM's OWN order — the inverse of each up statement, NOT yet reversed.
    { sql: 'DROP TABLE "readings"' },
    { sql: 'DROP INDEX "public"."readings_value_idx"' },
    { sql: 'CREATE INDEX "readings_time_idx" ON "readings" USING btree ("time")' },
  ],
};

/** The TimescaleDB half, as generateTimescaleMigration produces it. */
const timescale: GeneratedMigration = {
  name: 'Timescale1700000000000',
  timestamp: 1_700_000_000_000,
  up: [
    "SELECT create_hypertable('public.readings', by_range('time'));",
    "SELECT add_retention_policy('public.readings', INTERVAL '90 days');",
  ],
  down: ["SELECT remove_retention_policy('public.readings');"],
};

describe('composeMigration — ordering', () => {
  const composed = composeMigration(typeorm, timescale, owned);

  it('puts TypeORM base DDL BEFORE the TimescaleDB layer', () => {
    // create_hypertable converts a table that must already exist. This is the whole reason the
    // milestone exists, so it is the first thing asserted.
    const sqls = composed.up.map((s) => s.sql);
    const createTable = sqls.findIndex((s) => s.startsWith('CREATE TABLE'));
    const createHypertable = sqls.findIndex((s) => s.includes('create_hypertable'));
    expect(createTable).toBeGreaterThanOrEqual(0);
    expect(createHypertable).toBeGreaterThan(createTable);
  });

  it('undoes the TimescaleDB layer FIRST in down', () => {
    const sqls = composed.down.map((s) => s.sql);
    const removePolicy = sqls.findIndex((s) => s.includes('remove_retention_policy'));
    const dropTable = sqls.findIndex((s) => s.startsWith('DROP TABLE'));
    expect(removePolicy).toBe(0);
    expect(dropTable).toBeGreaterThan(removePolicy);
  });

  it("REVERSES TypeORM's down, because TypeORM stores it unreversed", () => {
    // Verified against typeorm@1.1.0: BaseQueryRunner pushes to upQueries and downQueries in the
    // same order, and the reversal happens at the point of use — MigrationGenerateCommand emits
    // `downSqls.reverse()`, executeMemoryDownSql iterates `downQueries.reverse()`. Slice 1 kept
    // the raw order on purpose, so the reversal has to happen HERE.
    const sqls = composed.down.map((s) => s.sql);
    const typeormPart = sqls.filter((s) => !s.includes('retention_policy'));
    expect(typeormPart).toEqual([
      // `CREATE INDEX readings_time_idx` was filtered (Timescale owns it), leaving these two
      // in reverse of TypeORM's stored order.
      'DROP INDEX "public"."readings_value_idx"',
      'DROP TABLE "readings"',
    ]);
  });

  it('produces exactly this sequence — the whole point of the slice', () => {
    // Asserted literally rather than derived. An earlier version of this test tried to extract
    // object names with a regex and compare up/down as sets; it failed twice for reasons that were
    // about the regex (schema-qualified names, then quoted COLUMN names in a CREATE TABLE body)
    // rather than about the composer. A clever assertion that needs debugging is worse than an
    // explicit one that can be read.
    expect(composed.up.map((s) => s.sql)).toEqual([
      // 1. TypeORM's base DDL...
      'CREATE TABLE "readings" ("time" TIMESTAMPTZ NOT NULL, "value" double precision)',
      'CREATE INDEX "readings_value_idx" ON "readings" ("value")',
      // (DROP INDEX readings_time_idx filtered out — TimescaleDB owns it)
      // 2. ...then the TimescaleDB layer, which needs that table to exist.
      "SELECT create_hypertable('public.readings', by_range('time'));",
      "SELECT add_retention_policy('public.readings', INTERVAL '90 days');",
    ]);
    expect(composed.down.map((s) => s.sql)).toEqual([
      // 1. TimescaleDB undone first...
      "SELECT remove_retention_policy('public.readings');",
      // 2. ...then TypeORM's down, REVERSED from how TypeORM stores it.
      'DROP INDEX "public"."readings_value_idx"',
      'DROP TABLE "readings"',
    ]);
  });
});

describe('composeMigration — filtering and identity', () => {
  const composed = composeMigration(typeorm, timescale, owned);

  it('removes the Timescale-owned index from BOTH sides and reports it', () => {
    const all = [...composed.up, ...composed.down].map((s) => s.sql);
    expect(all.some((s) => s.includes('readings_time_idx'))).toBe(false);
    expect(composed.filtered).toHaveLength(2);
    expect(composed.filtered.map((f) => f.side).sort()).toEqual(['down', 'up']);
  });

  it("keeps the user's own index, which is TypeORM's to manage", () => {
    expect(composed.up.map((s) => s.sql)).toContain(
      'CREATE INDEX "readings_value_idx" ON "readings" ("value")',
    );
  });

  it("inherits TypeORM's 13-digit ordering key", () => {
    expect(composed.name).toBe('Timescale1700000000000');
    expect(composed.timestamp).toBe(1_700_000_000_000);
    expect(String(composed.timestamp)).toHaveLength(13);
  });

  it('accepts a name/timestamp override without losing the key', () => {
    const renamed = composeMigration(typeorm, timescale, owned, {
      name: 'AddReadings1800000000000',
      timestamp: 1_800_000_000_000,
    });
    expect(renamed.name).toBe('AddReadings1800000000000');
    expect(renamed.timestamp).toBe(1_800_000_000_000);
  });

  it('propagates strict mode to the filter', () => {
    expect(() => composeMigration(typeorm, timescale, owned, { mode: 'strict' })).toThrow(
      TimescaleError,
    );
  });

  it('composes cleanly when TypeORM sees no drift', () => {
    const composedEmpty = composeMigration({ up: [], down: [] }, timescale, owned);
    expect(composedEmpty.up.map((s) => s.sql)).toEqual(timescale.up);
    expect(composedEmpty.down.map((s) => s.sql)).toEqual(timescale.down);
    expect(composedEmpty.filtered).toEqual([]);
  });
});

/**
 * The five findings from the Codex review of #242. Each was verified against the code (and, for the
 * transaction one, against TypeORM's own MigrationExecutor) before being accepted; all five were real.
 */
describe('review findings (#242)', () => {
  it('R1 P1 — EVERY line of a multi-line filtered statement is commented', () => {
    // A statement with newlines previously had only its first line prefixed. In the .sql artifact
    // the continuation lines became executable SQL sitting ABOVE `-- Up`, outside the transaction;
    // in the .ts artifact they became invalid TypeScript.
    const multiline: TypeormDiff = {
      up: [{ sql: 'DROP VIEW "readings_hourly"\n  -- trailing note\n  CASCADE' }],
      down: [],
    };
    const composed = composeMigration(multiline, timescale, ownedWithCagg);
    expect(composed.filtered).toHaveLength(1);

    const sql = renderComposedMigrationSql(composed);
    // Everything before the first executable line must be commented. `-- Up` is no longer a
    // marker (each artifact is one direction now), so the body starts at BEGIN;.
    const header = sql.slice(0, sql.indexOf('BEGIN;'));
    for (const line of header.split('\n').filter((l) => l.trim() !== '')) {
      expect(line.trimStart().startsWith('--'), `uncommented in .sql: ${line}`).toBe(true);
    }

    const ts = renderComposedMigration(composed);
    const tsHeader = ts.slice(0, ts.indexOf('import type'));
    for (const line of tsHeader.split('\n').filter((l) => l.trim() !== '')) {
      expect(line.trimStart().startsWith('//'), `uncommented in .ts: ${line}`).toBe(true);
    }
  });

  it('R2 P2 — a timestamp override reaches the NAME, which is what orders migrations', () => {
    // TypeORM derives ordering from the 13-digit suffix of the class name, and the renderer emits
    // only the name — so a timestamp that updated the field but not the name did nothing at all.
    const shifted = composeMigration(typeorm, timescale, owned, { timestamp: 1_800_000_000_000 });
    expect(shifted.timestamp).toBe(1_800_000_000_000);
    expect(shifted.name).toBe('Timescale1800000000000');
    expect(renderComposedMigration(shifted)).toContain('export class Timescale1800000000000');
  });

  it('R2 P2 — `name` is a PREFIX, as documented and as every other generator treats it', () => {
    const renamed = composeMigration(typeorm, timescale, owned, { name: 'AddReadings' });
    expect(renamed.name).toBe('AddReadings1700000000000');
    // A full name including the key is idempotent rather than doubled.
    const full = composeMigration(typeorm, timescale, owned, { name: 'AddReadings1700000000000' });
    expect(full.name).toBe('AddReadings1700000000000');
  });

  it('R3 P2 — CONCURRENTLY inside a string literal is not mistaken for the command', () => {
    // `\bCONCURRENTLY\b` matched the word anywhere, so a transaction-safe statement was refused.
    const literal: TypeormDiff = {
      up: [{ sql: 'CREATE TABLE "t" ("c" text DEFAULT \'concurrently\')' }],
      down: [],
    };
    expect(() =>
      renderComposedMigrationSql(composeMigration(literal, timescale, owned)),
    ).not.toThrow();

    // ...while the real command is still refused.
    const real: TypeormDiff = {
      up: [{ sql: 'CREATE INDEX CONCURRENTLY "t_c_idx" ON "t" ("c")' }],
      down: [],
    };
    expect(() => renderComposedMigrationSql(composeMigration(real, timescale, owned))).toThrow(
      /cannot run inside a transaction/,
    );
  });

  it('R4 P2 — a statement ending in a line comment is terminated on its own line', () => {
    // Appending `;` inline would put the terminator INSIDE the comment, leaving the statement
    // unterminated and the following COMMIT parsed as part of it.
    const trailingComment: TypeormDiff = {
      up: [{ sql: 'CREATE VIEW "v" AS SELECT 1 -- why' }],
      down: [],
    };
    const out = renderComposedMigrationSql(composeMigration(trailingComment, timescale, owned));
    expect(out).toContain('CREATE VIEW "v" AS SELECT 1 -- why\n;');
    expect(out).not.toContain('-- why;');
    // The COMMIT must still be its own statement.
    expect(out).toMatch(/\n;\n(?:.*\n)*?COMMIT;/);
  });

  it('R5 P2 — the refusal does not claim .ts alone fixes it', () => {
    // Verified in typeorm@1.1.1: MigrationExecutor sets `this.transaction = "all"` by default, so a
    // .ts migration is wrapped in a transaction too. The old message told users to emit .ts, which
    // would have failed the same way.
    const real: TypeormDiff = {
      up: [{ sql: 'CREATE INDEX CONCURRENTLY "t_c_idx" ON "t" ("c")' }],
      down: [],
    };
    try {
      renderComposedMigrationSql(composeMigration(real, timescale, owned));
      throw new Error('expected a throw');
    } catch (e) {
      const err = e as TimescaleError;
      expect(err.message).toMatch(/migrationsTransactionMode/);
      expect(err.message).toMatch(/NOT on its own a fix/);
    }
  });
});

/** Round 4 of the #242 review. Both verified against the code; both real. */
describe('review findings (#242, round 4)', () => {
  it('R4 P2 — CR and Unicode line separators are prefixed too, not just LF', () => {
    // `\r` ends a Postgres `--` comment; `\u2028`/`\u2029` are line terminators to JavaScript.
    // Splitting on `\n` alone let the text after one of those escape the annotation.
    for (const terminator of ['\r', '\u2028', '\u2029']) {
      const hostile: TypeormDiff = {
        up: [
          {
            sql: `DROP TABLE "_timescaledb_internal"."bad${terminator}DROP TABLE \\"victim\\"; --"`,
          },
        ],
        down: [],
      };
      const composed = composeMigration(hostile, timescale, owned);
      expect(composed.filtered[0]?.object, terminator).toContain(terminator);

      const sql = renderComposedMigrationSql(composed);
      const header = sql.slice(0, sql.indexOf('BEGIN;'));
      for (const line of header.split(/\r\n|[\n\r\u2028\u2029]/).filter((l) => l.trim() !== '')) {
        expect(line.trimStart().startsWith('--'), `uncommented (${terminator}): ${line}`).toBe(
          true,
        );
      }

      const ts = renderComposedMigration(composed);
      const tsHeader = ts.slice(0, ts.indexOf('import type'));
      for (const line of tsHeader.split(/\r\n|[\n\r\u2028\u2029]/).filter((l) => l.trim() !== '')) {
        expect(line.trimStart().startsWith('//'), `uncommented (${terminator}): ${line}`).toBe(
          true,
        );
      }
    }
  });

  it('R4 P2 — a rename BOTH halves want is refused, not executed twice', () => {
    // planToMigration() can emit a `renameHypertable` step, whose SQL is an ordinary
    // ALTER TABLE ... RENAME TO. TypeORM detects the same rename because base DDL is its job, so
    // concatenating executes it twice — the second fails, the old relation being gone.
    const renaming: TypeormDiff = {
      up: [{ sql: 'ALTER TABLE "readings" RENAME TO "measurements"' }],
      down: [{ sql: 'ALTER TABLE "measurements" RENAME TO "readings"' }],
    };
    const planWithRename: GeneratedMigration = {
      ...timescale,
      up: ['ALTER TABLE "public"."readings" RENAME TO "measurements";'],
      down: ['ALTER TABLE "public"."measurements" RENAME TO "readings";'],
    };

    try {
      composeMigration(renaming, planWithRename, owned);
      throw new Error('expected a throw');
    } catch (e) {
      const err = e as TimescaleError;
      expect(err).toBeInstanceOf(TimescaleError);
      expect(err.code).toBe(TimescaleErrorCode.INVALID_ARGUMENT);
      expect(err.message).toMatch(/both halves rename the same table/);
      expect(err.context).toMatchObject({ side: 'up' });
    }
  });

  it('R4 P2 — the down side is checked too', () => {
    const downOnly: TypeormDiff = {
      up: [],
      down: [{ sql: 'ALTER TABLE "measurements" RENAME TO "readings"' }],
    };
    const planDownOnly: GeneratedMigration = {
      ...timescale,
      up: [],
      down: ['ALTER TABLE "public"."measurements" RENAME TO "readings";'],
    };
    try {
      composeMigration(downOnly, planDownOnly, owned);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as TimescaleError).context).toMatchObject({ side: 'down' });
    }
  });

  it('R4 P2 — a rename by only ONE half composes normally', () => {
    // The check must not fire on the ordinary case, or it would block every rename.
    const typeormOnly: TypeormDiff = {
      up: [{ sql: 'ALTER TABLE "readings" RENAME TO "measurements"' }],
      down: [{ sql: 'ALTER TABLE "measurements" RENAME TO "readings"' }],
    };
    const composed = composeMigration(typeormOnly, timescale, owned);
    expect(composed.up.map((s) => s.sql)).toContain(
      'ALTER TABLE "readings" RENAME TO "measurements"',
    );

    // ...and two DIFFERENT renames are not a clash either.
    const otherRename: GeneratedMigration = {
      ...timescale,
      up: ['ALTER TABLE "public"."other" RENAME TO "elsewhere";'],
      down: [],
    };
    expect(() => composeMigration(typeormOnly, otherRename, owned)).not.toThrow();
  });
});

/** Round 3 of the #242 review. Both verified against the code; both real. */
describe('review findings (#242, round 3)', () => {
  it('R3 P1 — a newline in the OBJECT NAME cannot escape the comment block', () => {
    // Postgres permits a newline inside a quoted identifier, and the filter's OBJ pattern uses
    // `[^"]`, which matches one. Round 1 routed `statement.sql` through the line-commenter but left
    // the object/reason annotation interpolated raw, so the second line of a crafted identifier
    // landed as executable SQL above the body.
    // The newline must be in the OBJECT NAME, not merely in the statement — an earlier version of
    // this test put it in the statement, so the captured object stayed single-line and the bug went
    // undetected (both annotation mutants survived). An internal-schema target is filtered on its
    // schema alone, so the identifier is free to be hostile.
    const newlineIdentifier: TypeormDiff = {
      up: [{ sql: 'DROP TABLE "_timescaledb_internal"."bad\nDROP TABLE \\"victim\\"; --"' }],
      down: [],
    };
    const composed = composeMigration(newlineIdentifier, timescale, owned);
    expect(composed.filtered).toHaveLength(1);
    expect(composed.filtered[0]?.object).toContain('\n');

    const sql = renderComposedMigrationSql(composed);
    const header = sql.slice(0, sql.indexOf('BEGIN;'));
    for (const line of header.split('\n').filter((l) => l.trim() !== '')) {
      expect(line.trimStart().startsWith('--'), `uncommented in .sql: ${line}`).toBe(true);
    }
    const ts = renderComposedMigration(composed);
    const tsHeader = ts.slice(0, ts.indexOf('import type'));
    for (const line of tsHeader.split('\n').filter((l) => l.trim() !== '')) {
      expect(line.trimStart().startsWith('//'), `uncommented in .ts: ${line}`).toBe(true);
    }
  });

  it('R3 P1 — the up artifact never contains the destructive down statements', () => {
    // The core of the finding: psql does not treat `-- Down` as a delimiter, so a single-file
    // artifact would create the table and then drop it.
    const up = renderComposedMigrationSql(composeMigration(typeorm, timescale, owned));
    expect(up).not.toContain('DROP TABLE');
    expect(up).not.toMatch(/^-- Down$/m);
  });
});

/** Round 2 of the #242 review. Both verified against the code; both real. */
describe('review findings (#242, round 2)', () => {
  it('R2 P2 — a `;` INSIDE a trailing comment does not count as terminated', () => {
    // `endsWith(";")` said terminated; Postgres says the semicolon is part of the comment, so the
    // statement is unterminated and the COMMIT that follows is parsed as a continuation of it.
    const commentedSemicolon: TypeormDiff = {
      up: [{ sql: 'CREATE VIEW "v" AS SELECT 1 -- why;' }],
      down: [],
    };
    const out = renderComposedMigrationSql(composeMigration(commentedSemicolon, timescale, owned));
    expect(out).toContain('CREATE VIEW "v" AS SELECT 1 -- why;\n;');
    // COMMIT must be a statement of its own, not swallowed by the comment.
    expect(out).toMatch(/\n;\n(?:.*\n)*?COMMIT;/);
  });

  it('R2 P2 — a genuinely terminated statement is not double-terminated', () => {
    const terminated: TypeormDiff = { up: [{ sql: 'CREATE VIEW "v" AS SELECT 1;' }], down: [] };
    const out = renderComposedMigrationSql(composeMigration(terminated, timescale, owned));
    expect(out).toContain('CREATE VIEW "v" AS SELECT 1;');
    expect(out).not.toContain(';;');
    expect(out).not.toContain(';\n;');
  });

  it('R2 P2 — quote tracking: a comment marker INSIDE a string is not a comment', () => {
    // The discriminating case for single-quote tracking, found by mutation testing. Without it the
    // `--` inside the literal starts a "comment" that swallows the real trailing `;`, and the
    // statement gets a second, redundant terminator.
    const markerInString: TypeormDiff = {
      // Must be a form the slice-2 filter recognises — a bare SELECT is (correctly) refused.
      up: [{ sql: `CREATE VIEW "v" AS SELECT '--' ;` }],
      down: [],
    };
    const out = renderComposedMigrationSql(composeMigration(markerInString, timescale, owned));
    expect(out).toContain(`CREATE VIEW "v" AS SELECT '--' ;`);
    expect(out).not.toContain(';\n;');
    expect(out).not.toContain(';;');
  });

  it('R2 P2 — a real terminator followed by a trailing comment still counts', () => {
    // The scanner must ignore the whitespace between `;` and the comment; otherwise the last
    // recorded character is a space and the statement gains a spurious second terminator.
    const terminatedThenComment: TypeormDiff = {
      up: [{ sql: 'CREATE VIEW "v" AS SELECT 1; -- note' }],
      down: [],
    };
    const out = renderComposedMigrationSql(
      composeMigration(terminatedThenComment, timescale, owned),
    );
    expect(out).toContain('CREATE VIEW "v" AS SELECT 1; -- note');
    expect(out).not.toContain('-- note\n;');
  });

  it('R2 P2 — quote tracking covers quoted IDENTIFIERS, not just string literals', () => {
    // `"v--x"` is a legal quoted identifier. Without double-quote tracking the `--` inside it
    // starts a phantom comment that swallows the real trailing `;`.
    const dashedIdentifier: TypeormDiff = {
      up: [{ sql: 'CREATE VIEW "v--x" AS SELECT 1;' }],
      down: [],
    };
    const out = renderComposedMigrationSql(composeMigration(dashedIdentifier, timescale, owned));
    expect(out).toContain('CREATE VIEW "v--x" AS SELECT 1;');
    expect(out).not.toContain(';\n;');
  });

  it('R2 P2 — a `;` inside a string literal or block comment is not a terminator either', () => {
    const tricky: TypeormDiff = {
      up: [
        { sql: `CREATE TABLE "t" ("c" text DEFAULT ';')` },
        { sql: 'CREATE VIEW "w" AS SELECT 1 /* ; */' },
      ],
      down: [],
    };
    const out = renderComposedMigrationSql(composeMigration(tricky, timescale, owned));
    expect(out).toContain(`CREATE TABLE "t" ("c" text DEFAULT ';');`);
    expect(out).toContain('CREATE VIEW "w" AS SELECT 1 /* ; */\n;');
  });

  it('R2 P2 — the .ts artifact WARNS about statements needing a non-transactional DataSource', () => {
    // The .ts target cannot just refuse — CREATE INDEX CONCURRENTLY is legitimate and TypeORM
    // supports untransacted migrations. But MigrationExecutor defaults to 'all', so an unannotated
    // class fails by default. Silence is the one option that is definitely wrong.
    const concurrent: TypeormDiff = {
      up: [{ sql: 'CREATE INDEX CONCURRENTLY "t_c_idx" ON "t" ("c")' }],
      down: [],
    };
    const composed = composeMigration(concurrent, timescale, owned);

    expect(nonTransactionalStatements(composed).map((s) => s.sql)).toEqual([
      'CREATE INDEX CONCURRENTLY "t_c_idx" ON "t" ("c")',
    ]);

    const ts = renderComposedMigration(composed);
    expect(ts).toMatch(/migrationsTransactionMode: 'none'/);
    expect(ts).toContain('CREATE INDEX CONCURRENTLY "t_c_idx" ON "t" ("c")');
    // The warning is a comment, not stray code.
    const header = ts.slice(0, ts.indexOf('import type'));
    for (const line of header.split('\n').filter((l) => l.trim() !== '')) {
      expect(line.trimStart().startsWith('//'), `uncommented: ${line}`).toBe(true);
    }
  });

  it('R2 P2 — an ordinary migration carries no such warning', () => {
    const ts = renderComposedMigration(composeMigration(typeorm, timescale, owned));
    expect(ts).not.toMatch(/migrationsTransactionMode/);
    expect(nonTransactionalStatements(composeMigration(typeorm, timescale, owned))).toEqual([]);
  });
});

describe('renderComposedMigration (.ts)', () => {
  it('binds parameters as the SECOND argument, never inlined', () => {
    // Matches MigrationGenerateCommand.queryParams(). Inlining would create an injection surface.
    const withParams: TypeormDiff = {
      up: [
        {
          sql: 'INSERT INTO "typeorm_metadata"("schema", "name") VALUES ($1, $2)',
          parameters: ['public', 'reading_view'],
        },
      ],
      down: [],
    };
    const out = renderComposedMigration(composeMigration(withParams, timescale, owned));
    expect(out).toContain(
      'await queryRunner.query("INSERT INTO \\"typeorm_metadata\\"(\\"schema\\", \\"name\\") VALUES ($1, $2)", ["public","reading_view"]);',
    );
    // The values must not appear as literals inside the SQL string itself.
    expect(out).not.toContain("VALUES ('public'");
  });

  it('omits the second argument when there are no parameters', () => {
    const out = renderComposedMigration(composeMigration(typeorm, timescale, owned));
    expect(out).toContain('await queryRunner.query("DROP TABLE \\"readings\\"");');
    expect(out).not.toMatch(/query\("DROP TABLE[^)]*, \[\]\)/);
  });

  it('omits the second argument for an EMPTY parameters array too', () => {
    // Mirrors queryParams()'s own `!parameters?.length` test. The reader omits `parameters`
    // rather than emitting `[]`, but composeMigration is public and accepts any TypeormDiff, so
    // the length check is reachable — and mutation testing showed the `!== undefined` half alone
    // was carrying the earlier test.
    const emptyParams: TypeormDiff = {
      up: [{ sql: 'CREATE TABLE "a" ()', parameters: [] }],
      down: [],
    };
    const out = renderComposedMigration(composeMigration(emptyParams, timescale, owned));
    expect(out).toContain('await queryRunner.query("CREATE TABLE \\"a\\" ()");');
    expect(out).not.toContain(', []);');
  });

  it('is a valid TypeORM migration class carrying the ordering key', () => {
    const out = renderComposedMigration(composeMigration(typeorm, timescale, owned));
    expect(out).toContain('export class Timescale1700000000000 implements MigrationInterface');
    expect(out).toContain("name = 'Timescale1700000000000'");
    expect(out).toContain('public async up(queryRunner: QueryRunner)');
    expect(out).toContain('public async down(queryRunner: QueryRunner)');
  });

  it('records what the filter removed, so it is reviewable rather than lost', () => {
    const out = renderComposedMigration(composeMigration(typeorm, timescale, owned));
    expect(out).toContain('readings_time_idx');
    expect(out).toMatch(/removed because TimescaleDB owns their target/);
  });

  it('emits a no-op body rather than an empty block', () => {
    const empty = composeMigration({ up: [], down: [] }, { ...timescale, up: [], down: [] }, owned);
    expect(renderComposedMigration(empty)).toContain('// no-op');
  });
});

describe('renderComposedMigrationSql (.sql) — refuses rather than degrades', () => {
  it('emits ONE direction per artifact, each safe to run end to end', () => {
    // `-- Down` below `-- Up` in one file is not a delimiter to psql: the runner would commit the
    // up section and then execute the down one, dropping the table it just created. Composition is
    // what made that fatal — the TimescaleDB-only down merely removed policies.
    const composed = composeMigration(typeorm, timescale, owned);

    const up = renderComposedMigrationSql(composed);
    expect(up).toContain('BEGIN;');
    expect(up).toContain('COMMIT;');
    expect(up).toContain('CREATE TABLE "readings"');
    expect(up).toContain("SELECT create_hypertable('public.readings', by_range('time'));");
    // The destructive inverse must NOT be in the up artifact at all.
    expect(up).not.toContain('DROP TABLE');
    expect(up).not.toContain('remove_retention_policy');

    const down = renderComposedMigrationSql(composed, { section: 'down' });
    expect(down).toContain('DROP TABLE "readings"');
    expect(down).toContain("SELECT remove_retention_policy('public.readings');");
    expect(down).not.toContain('CREATE TABLE');

    // Ordering still holds within the emitted direction.
    expect(up.indexOf('CREATE TABLE')).toBeLessThan(up.indexOf('SELECT create_hypertable'));
    expect(down.indexOf('remove_retention_policy')).toBeLessThan(down.indexOf('DROP TABLE'));
  });

  it('REFUSES bound parameters instead of inlining them', () => {
    const withParams: TypeormDiff = {
      up: [{ sql: 'INSERT INTO "typeorm_metadata"("schema") VALUES ($1)', parameters: ['public'] }],
      down: [],
    };
    const composed = composeMigration(withParams, timescale, owned);
    try {
      renderComposedMigrationSql(composed);
      throw new Error('expected a throw');
    } catch (e) {
      const err = e as TimescaleError;
      expect(err).toBeInstanceOf(TimescaleError);
      expect(err.code).toBe(TimescaleErrorCode.INVALID_ARGUMENT);
      expect(err.message).toMatch(/injection surface/);
      expect(err.message).toMatch(/Emit \.ts instead/);
      expect(err.context).toMatchObject({ side: 'up' });
    }
    // ...while the .ts target handles the very same migration.
    expect(renderComposedMigration(composed)).toContain('["public"]');
  });

  it('REFUSES statements that cannot run inside a transaction block', () => {
    // The sections are wrapped in BEGIN/COMMIT, which was safe when this emitter only saw the
    // Operation union. TypeORM emits CONCURRENTLY whenever an index is declared concurrent, and
    // that cannot run in a transaction — it would fail at apply time inside a wrapper we added.
    const concurrent: TypeormDiff = {
      up: [{ sql: 'CREATE INDEX CONCURRENTLY "readings_value_idx" ON "readings" ("value")' }],
      down: [],
    };
    const composed = composeMigration(concurrent, timescale, owned);
    expect(() => renderComposedMigrationSql(composed)).toThrow(/cannot run inside a transaction/);
    // The .ts target is not wrapped, so it takes it.
    expect(renderComposedMigration(composed)).toContain('CONCURRENTLY');
  });

  it('checks the down section too, not just up', () => {
    const concurrentDown: TypeormDiff = {
      up: [],
      down: [{ sql: 'DROP INDEX CONCURRENTLY "readings_value_idx"' }],
    };
    const composed = composeMigration(concurrentDown, timescale, owned);
    try {
      renderComposedMigrationSql(composed, { section: 'down' });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as TimescaleError).context).toMatchObject({ side: 'down' });
    }
  });

  it('does not double-terminate statements that already end in a semicolon', () => {
    const out = renderComposedMigrationSql(composeMigration(typeorm, timescale, owned));
    expect(out).not.toContain(';;');
  });
});

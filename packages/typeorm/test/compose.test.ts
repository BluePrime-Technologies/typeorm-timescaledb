import { describe, expect, it } from 'vitest';
import {
  TimescaleError,
  TimescaleErrorCode,
  type SchemaStateIR,
} from '@blueprime/timescaledb-core';
import {
  composeMigration,
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
  it('wraps each section in a transaction', () => {
    const out = renderComposedMigrationSql(composeMigration(typeorm, timescale, owned));
    expect(out).toContain('-- Up\nBEGIN;');
    expect(out).toContain('COMMIT;');
    // Compare positions WITHIN the Up section: the filtered-note header also mentions
    // create_hypertable (it is part of the reason string), which a whole-document indexOf finds first.
    const upSection = out.slice(out.indexOf('-- Up'), out.indexOf('-- Down'));
    expect(upSection.indexOf('CREATE TABLE')).toBeLessThan(
      upSection.indexOf('SELECT create_hypertable'),
    );
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
      renderComposedMigrationSql(composed);
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

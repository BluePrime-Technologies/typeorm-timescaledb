import { describe, expect, it } from 'vitest';
import {
  TimescaleError,
  TimescaleErrorCode,
  type SchemaStateIR,
} from '@blueprime/timescaledb-core';
import {
  classifyTypeormStatement,
  filterTypeormDiff,
  timescaleOwnedObjects,
} from '../src/migrations/typeorm-filter.js';
import type { TypeormDiff } from '../src/migrations/typeorm-diff.js';

/**
 * Slice 2 of M4.5 (#235) — the protective filter.
 *
 * Being wrong here is destructive rather than merely noisy, so these cover BOTH directions:
 * statements that must be filtered, and statements that must survive untouched. The second half is
 * the one that matters most — over-filtering silently removes the user's own DDL from a migration
 * they believe is complete, which is harder to notice than an outright refusal.
 *
 * The fixtures are real statement text observed from TypeORM against a live database while
 * planning this milestone, not invented shapes.
 */
const state: SchemaStateIR = {
  hypertables: [
    {
      table: 'public.readings',
      dimensions: [
        { column: 'time', kind: 'time', chunkInterval: '1 day' },
        { column: 'sensor_id', kind: 'space', numPartitions: 4 },
      ],
    },
  ],
  continuousAggregates: [
    {
      viewName: 'public.readings_hourly',
      source: 'public.readings',
      hierarchical: false,
      materializedOnly: false,
      definition: 'SELECT 1',
    },
  ],
};
const owned = timescaleOwnedObjects(state);

const keep = (sql: string): void => {
  expect(classifyTypeormStatement(sql, owned).verdict, sql).toBe('keep');
};
const filtered = (sql: string): void => {
  expect(classifyTypeormStatement(sql, owned).verdict, sql).toBe('filtered');
};
const refuses = (sql: string): void => {
  expect(classifyTypeormStatement(sql, owned).verdict, sql).toBe('unclassified');
};

describe('timescaleOwnedObjects', () => {
  it('derives the auto index name from the TIME dimension only', () => {
    // `create_hypertable` indexes the time column. A space dimension gets no such index, and
    // inventing `readings_sensor_id_idx` would filter a user's own index of that name.
    expect([...owned.autoIndexes]).toEqual(['public.readings_time_idx']);
  });

  it('keys every owned object by SCHEMA and name, never by bare name', () => {
    // Bare-name keying was the P1 in the #240 review: an `analytics.readings` hypertable made a
    // legitimate `public.readings_time_idx` look owned. See the review-findings block below.
    expect(owned.hypertables.has('public.readings')).toBe(true);
    expect(owned.continuousAggregates.has('public.readings_hourly')).toBe(true);
    expect(owned.hypertables.has('readings')).toBe(false);
    expect(owned.defaultSchema).toBe('public');
  });
});

describe('name resolution', () => {
  it('reads the schema as the part before the name, not the first part', () => {
    // A three-part `"db"."_timescaledb_internal"."x"` must resolve the SCHEMA, not the catalog —
    // otherwise the internal-schema check silently stops firing on qualified names.
    filtered('DROP TABLE "db"."_timescaledb_internal"."x"');
    keep('DROP TABLE "_timescaledb_internal"."public"."x"');
  });

  it('reads the target when no space separates it from the column list', () => {
    keep('CREATE TABLE "users"("id" SERIAL)');
    filtered('CREATE INDEX "readings_time_idx"ON "readings" ("time")');
  });

  it('tolerates a trailing semicolon', () => {
    filtered('DROP INDEX "public"."readings_time_idx";');
    keep('DROP TABLE "users";');
  });
});

describe('classify — must FILTER (TimescaleDB owns these)', () => {
  it('the auto time index, the statement that motivated this whole slice', () => {
    // Verbatim from a live diff. Qualified on DROP, bare on CREATE — both must match.
    filtered('DROP INDEX "public"."readings_time_idx"');
    filtered('CREATE INDEX "readings_time_idx" ON "readings" USING btree ("time")');
  });

  it('chunks, compressed chunks and materialization internals — in their own schema', () => {
    // TimescaleDB places all of these in `_timescaledb_internal`, never in a user schema.
    filtered('DROP TABLE "_timescaledb_internal"."_hyper_1_1_chunk"');
    filtered('DROP TABLE "_timescaledb_internal"."_hyper_12_34_chunk"');
    filtered('DROP TABLE "_timescaledb_internal"."compress_hyper_2_3_chunk"');
    filtered('DROP TABLE "_timescaledb_internal"."_materialized_hypertable_2"');
    filtered('DROP VIEW "_timescaledb_internal"."_partial_view_2"');
    filtered('DROP VIEW "_timescaledb_internal"."_direct_view_2"');
  });

  it('names the specific internal object in its reason, not just the schema', () => {
    const d = classifyTypeormStatement(
      'DROP TABLE "_timescaledb_internal"."_hyper_1_1_chunk"',
      owned,
    );
    expect(d.verdict).toBe('filtered');
    if (d.verdict !== 'filtered') return;
    expect(d.reason).toMatch(/hypertable chunk/);
  });

  it('anything in a TimescaleDB schema', () => {
    filtered('ALTER TABLE "_timescaledb_catalog"."hypertable" ADD "x" text');
    filtered('DROP TABLE "_timescaledb_config"."bgw_job"');
  });

  it('a continuous aggregate — this engine diffs those structurally', () => {
    filtered('DROP VIEW "readings_hourly"');
    filtered('DROP MATERIALIZED VIEW "public"."readings_hourly"');
  });

  it('an ALTER that RENAMES an owned object, not just a DROP', () => {
    // Renaming the time index breaks it as surely as dropping it, so the ALTER forms are classified
    // by object kind rather than waved through as "not destructive".
    filtered('ALTER INDEX "public"."readings_time_idx" RENAME TO "IDX_abc"');
    filtered('ALTER MATERIALIZED VIEW "readings_hourly" RENAME TO "old_rollup"');
  });
});

describe('classify — must KEEP (over-filtering is the silent failure)', () => {
  it("the hypertable's BASE TABLE, which is TypeORM's to manage", () => {
    // The entire point of composing. Filtering these would break the milestone.
    keep('ALTER TABLE "readings" ADD "note" text');
    keep('ALTER TABLE "public"."readings" ALTER COLUMN "value" SET NOT NULL');
    keep('CREATE TABLE "readings" ("time" TIMESTAMPTZ NOT NULL)');
  });

  it("a user's own index on a hypertable — only the auto time index is Timescale's", () => {
    keep('CREATE INDEX "readings_sensor_id_idx" ON "readings" ("sensor_id")');
    keep('DROP INDEX "public"."readings_value_idx"');
  });

  it('a TABLE that merely SHARES a name with an owned index or aggregate', () => {
    // The owned-name checks are scoped to the matching object kind on purpose. An index name and a
    // table name live in the same namespace in Postgres but a user can still own `readings_hourly`
    // as a plain table, and `DROP TABLE` of it is TypeORM's business. Without the kind guard these
    // would be filtered — the user's DDL silently vanishing from a migration they think is whole.
    // (Caught by mutation testing: removing `match.target === 'index'` left every test green.)
    keep('DROP TABLE "readings_time_idx"');
    keep('CREATE TABLE "readings_hourly" ("id" SERIAL)');
    keep('ALTER TABLE "readings_hourly" ADD "x" text');
  });

  it('an unrelated table, view, and its indexes', () => {
    keep('CREATE TABLE "users" ("id" SERIAL PRIMARY KEY)');
    keep('DROP TABLE "users"');
    keep('CREATE VIEW "user_summary" AS SELECT 1');
  });

  it("TypeORM's own bookkeeping", () => {
    keep('INSERT INTO "typeorm_metadata"("database", "schema") VALUES (DEFAULT, $1)');
    keep('DELETE FROM "typeorm_metadata" WHERE "type" = $1');
    // Appears whenever the database query-result cache is enabled — identical to
    // `migration:generate`, so it must be classified rather than refused. (#236 review.)
    keep('CREATE TABLE "query-result-cache" ("id" SERIAL NOT NULL)');
  });

  it('object kinds with no single target', () => {
    keep('CREATE TYPE "public"."mood" AS ENUM (\'a\')');
    keep('DROP SEQUENCE "users_id_seq"');
    keep('COMMENT ON COLUMN "readings"."value" IS $1');
  });

  it('the ALTER forms TypeORM really emits — enum changes above all', () => {
    // Checked against every DDL verb PostgresQueryRunner emits: ALTER TYPE (8 call sites),
    // ALTER INDEX (8), ALTER SEQUENCE (4). An earlier draft omitted all three, which would have
    // REFUSED composition for any entity with an enum column, since `ALTER TYPE ... RENAME TO` is
    // how TypeORM performs every enum change.
    keep('ALTER TYPE "public"."users_role_enum" RENAME TO "users_role_enum_old"');
    keep('ALTER SEQUENCE "users_id_seq" OWNED BY "users"."id"');
    keep('ALTER INDEX "users_email_idx" RENAME TO "IDX_abc123"');
    keep('ALTER VIEW "user_summary" RENAME TO "user_overview"');
  });
});

describe('classify — must REFUSE rather than guess', () => {
  it('an unrecognised statement form', () => {
    // Neither provably safe to keep nor safe to drop. The allow-list is deliberate: this repo has
    // twice shipped a bug from an allow-list quietly missing an entry.
    refuses('GRANT SELECT ON "readings" TO "app_reader"');
    refuses('CLUSTER "readings" USING "readings_time_idx"');
    refuses('VACUUM FULL "readings"');
  });

  it('destructive verbs the schema builder never emits stay OUT of the allow-list', () => {
    // `TRUNCATE TABLE` comes only from queryRunner.clearTable(), and CREATE/DROP DATABASE never
    // appear in a schema diff. Leaving them unrecognised is deliberate, not an oversight — they
    // have no business in a generated migration, so meeting one means something is badly wrong.
    refuses('TRUNCATE TABLE "readings"');
    refuses('DROP DATABASE "app"');
  });

  it('DROP TABLE of a hypertable — both engines claim it, so neither decides', () => {
    const d = classifyTypeormStatement('DROP TABLE "readings"', owned);
    expect(d.verdict).toBe('unclassified');
    if (d.verdict !== 'unclassified') return;
    expect(d.reason).toMatch(/never drops a hypertable/);
  });
});

/**
 * The five findings from the Codex review of #240. Every one was verified against the code before
 * being accepted, and every one was real — so each gets a test that fails without its fix.
 */
describe('review findings (#240)', () => {
  it('P1 — ownership is schema-qualified, so a same-named object elsewhere is untouched', () => {
    // With bare-name matching, an `analytics.readings` hypertable made a perfectly legitimate
    // `DROP INDEX "public"."readings_time_idx"` look Timescale-owned and vanish from the user's
    // migration. Over-filtering is the silent direction, which makes this the worst of the five.
    const elsewhere = timescaleOwnedObjects({
      hypertables: [
        {
          table: 'analytics.readings',
          dimensions: [{ column: 'time', kind: 'time', chunkInterval: '1 day' }],
        },
      ],
      continuousAggregates: [
        {
          viewName: 'analytics.readings_hourly',
          source: 'analytics.readings',
          hierarchical: false,
          materializedOnly: false,
          definition: 'SELECT 1',
        },
      ],
    });

    expect(
      classifyTypeormStatement('DROP INDEX "public"."readings_time_idx"', elsewhere).verdict,
    ).toBe('keep');
    expect(classifyTypeormStatement('DROP TABLE "public"."readings"', elsewhere).verdict).toBe(
      'keep',
    );
    expect(
      classifyTypeormStatement('DROP VIEW "public"."readings_hourly"', elsewhere).verdict,
    ).toBe('keep');

    // ...while the genuinely owned ones in `analytics` still are.
    expect(
      classifyTypeormStatement('DROP INDEX "analytics"."readings_time_idx"', elsewhere).verdict,
    ).toBe('filtered');
    expect(classifyTypeormStatement('DROP TABLE "analytics"."readings"', elsewhere).verdict).toBe(
      'unclassified',
    );
  });

  it('P1 — an unqualified name resolves against the configured default schema', () => {
    const inApp = timescaleOwnedObjects(
      {
        hypertables: [
          {
            table: 'app.readings',
            dimensions: [{ column: 'time', kind: 'time', chunkInterval: '1 day' }],
          },
        ],
      },
      { defaultSchema: 'app' },
    );
    expect(classifyTypeormStatement('DROP INDEX "readings_time_idx"', inApp).verdict).toBe(
      'filtered',
    );
    expect(classifyTypeormStatement('DROP INDEX "public"."readings_time_idx"', inApp).verdict).toBe(
      'keep',
    );
  });

  it('P1 — the auto index name is TRUNCATED to 63 bytes, as Postgres stores it', () => {
    // Postgres clips every identifier to NAMEDATALEN-1. Keeping the full string meant the owned set
    // never matched the name TypeORM reports, so the destructive DROP INDEX survived — the exact
    // failure this module exists to prevent, reappearing on long names.
    const table = 'sensor_readings_from_the_northern_field_station_array'; // 52 chars
    const column = 'observed_at_utc';
    const full = `${table}_${column}_idx`; // 72 chars — over the limit
    const stored = full.slice(0, 63);
    expect(full.length).toBeGreaterThan(63);

    const long = timescaleOwnedObjects({
      hypertables: [
        {
          table: `public.${table}`,
          dimensions: [{ column, kind: 'time', chunkInterval: '1 day' }],
        },
      ],
    });

    expect([...long.autoIndexes]).toEqual([`public.${stored}`]);
    expect(classifyTypeormStatement(`DROP INDEX "public"."${stored}"`, long).verdict).toBe(
      'filtered',
    );
  });

  it('P1 — truncation clips on a character boundary, never mid-codepoint', () => {
    const column = 'é'.repeat(40); // 80 bytes, 40 chars
    const long = timescaleOwnedObjects({
      hypertables: [
        { table: 'public.t', dimensions: [{ column, kind: 'time', chunkInterval: '1 day' }] },
      ],
    });
    const [only] = [...long.autoIndexes];
    const bare = only!.slice('public.'.length);
    expect(new TextEncoder().encode(bare).length).toBeLessThanOrEqual(63);
    expect(bare).not.toContain('�'); // no split codepoint
  });

  it('P1 — a caller with real catalog names can supply them, sidestepping collision suffixes', () => {
    const withKnown = timescaleOwnedObjects(
      {
        hypertables: [
          {
            table: 'public.readings',
            dimensions: [{ column: 'time', kind: 'time', chunkInterval: '1 day' }],
          },
        ],
      },
      { knownAutoIndexes: ['public.readings_time_idx1'] },
    );
    // Postgres appends a suffix when the truncated name is taken; reconstruction cannot guess it,
    // so the caller supplies it rather than this module inventing one and over-filtering.
    expect(
      classifyTypeormStatement('DROP INDEX "public"."readings_time_idx1"', withKnown).verdict,
    ).toBe('filtered');
  });

  it('P1 — allow-listed schema/extension verbs have their TARGET inspected, not waved through', () => {
    // The earlier draft short-circuited these to `keep` without reading the target, so a composed
    // migration could destroy the very schema this module declares entirely Timescale-owned.
    filtered('DROP SCHEMA "_timescaledb_internal" CASCADE');
    filtered('DROP SCHEMA IF EXISTS "_timescaledb_catalog"');
    filtered('DROP EXTENSION "timescaledb"');
    filtered('DROP EXTENSION IF EXISTS timescaledb CASCADE');
    filtered('CREATE EXTENSION IF NOT EXISTS "timescaledb_toolkit"');

    // A user's own schema and any other extension remain TypeORM's business.
    keep('CREATE SCHEMA "analytics"');
    keep('DROP SCHEMA "reporting" CASCADE');
    keep('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  });

  it('P1 — both ends of a rename get the SAME disposition', () => {
    // TypeORM's down statement inverts the rename, naming the owned object as the DESTINATION.
    // Filtering only the up statement left a down migration referencing an index never created.
    filtered('ALTER INDEX "readings_time_idx" RENAME TO "IDX_abc"');
    filtered('ALTER INDEX "IDX_abc" RENAME TO "readings_time_idx"');
    filtered('ALTER MATERIALIZED VIEW "old_rollup" RENAME TO "readings_hourly"');

    // A rename between two names this engine does not own stays TypeORM's.
    keep('ALTER INDEX "users_email_idx" RENAME TO "IDX_xyz"');

    // The destination inherits the source's schema, so a rename in another schema is untouched.
    keep('ALTER INDEX "other"."IDX_abc" RENAME TO "readings_time_idx"');
  });

  it('R2 P1 — catalog names REPLACE reconstruction, they do not union with it', () => {
    // Postgres only appends a collision suffix because the reconstructed name was already taken —
    // by a USER's index. Unioning would filter both the real auto index (`..._time_idx1`) AND the
    // user's own `..._time_idx`, silently deleting their DDL. The contract is replacement.
    const withCatalog = timescaleOwnedObjects(
      {
        hypertables: [
          {
            table: 'public.readings',
            dimensions: [{ column: 'time', kind: 'time', chunkInterval: '1 day' }],
          },
        ],
      },
      { knownAutoIndexes: ['public.readings_time_idx1'] },
    );

    expect([...withCatalog.autoIndexes]).toEqual(['public.readings_time_idx1']);
    expect(
      classifyTypeormStatement('DROP INDEX "public"."readings_time_idx1"', withCatalog).verdict,
    ).toBe('filtered');
    // The user's index of the reconstructed name must SURVIVE.
    expect(
      classifyTypeormStatement('DROP INDEX "public"."readings_time_idx"', withCatalog).verdict,
    ).toBe('keep');
  });

  it('R2 P2 — internal NAMES only confer ownership inside an internal SCHEMA', () => {
    // TimescaleDB puts chunks and materialization internals exclusively in its own schemas, so a
    // user entity that happens to match the convention is theirs, and filtering it would silently
    // remove legitimate TypeORM DDL.
    keep('DROP TABLE "app"."_hyper_1_1_chunk"');
    keep('DROP TABLE "_hyper_12_34_chunk"'); // unqualified → resolves to public
    keep('DROP TABLE "public"."_materialized_hypertable_2"');
    keep('DROP VIEW "app"."_partial_view_2"');

    filtered('DROP TABLE "_timescaledb_internal"."_hyper_1_1_chunk"');
  });

  it('P2 — doubled quotes inside an identifier are one escaped quote, not a terminator', () => {
    // `"a""b"` is the single identifier `a"b`. Stopping at the inner quote parsed
    // `"readings_time_idx""backup"` as the owned index and filtered a distinct user index.
    keep('DROP INDEX "readings_time_idx""backup"');
    filtered('DROP INDEX "readings_time_idx"');
  });

  it('P2 — a quoted identifier may contain a dot without becoming qualified', () => {
    keep('DROP TABLE "public.readings"'); // one identifier literally named `public.readings`
    refuses('DROP TABLE "public"."readings"'); // genuinely qualified — the owned hypertable
  });

  it('folds unquoted identifiers to lower case, as Postgres does', () => {
    filtered('DROP INDEX public.READINGS_TIME_IDX');
    refuses('DROP TABLE READINGS');
  });
});

describe('filterTypeormDiff', () => {
  const diff: TypeormDiff = {
    up: [
      { sql: 'DROP INDEX "public"."readings_time_idx"' },
      { sql: 'ALTER TABLE "readings" ADD "note" text' },
    ],
    down: [
      { sql: 'ALTER TABLE "readings" DROP COLUMN "note"' },
      { sql: 'CREATE INDEX "readings_time_idx" ON "readings" USING btree ("time")' },
    ],
  };

  it('removes Timescale-owned statements and keeps the rest, on BOTH sides', () => {
    const out = filterTypeormDiff(diff, owned);
    expect(out.diff.up.map((s) => s.sql)).toEqual(['ALTER TABLE "readings" ADD "note" text']);
    expect(out.diff.down.map((s) => s.sql)).toEqual(['ALTER TABLE "readings" DROP COLUMN "note"']);
  });

  it('REPORTS what it removed — never a silent drop', () => {
    const out = filterTypeormDiff(diff, owned);
    expect(out.filtered).toHaveLength(2);
    expect(out.filtered.map((f) => f.side)).toEqual(['up', 'down']);
    expect(out.filtered[0]?.object).toBe('"public"."readings_time_idx"');
    expect(out.filtered[0]?.reason).toMatch(/create_hypertable/);
  });

  it('leaves a clean diff untouched and reports nothing', () => {
    const clean: TypeormDiff = { up: [{ sql: 'CREATE TABLE "users" ()' }], down: [] };
    const out = filterTypeormDiff(clean, owned);
    expect(out.diff).toEqual(clean);
    expect(out.filtered).toEqual([]);
  });

  it('preserves bound parameters through the filter', () => {
    const withParams: TypeormDiff = {
      up: [{ sql: 'INSERT INTO "typeorm_metadata"("schema") VALUES ($1)', parameters: ['public'] }],
      down: [],
    };
    expect(filterTypeormDiff(withParams, owned).diff.up[0]?.parameters).toEqual(['public']);
  });

  it('throws on an unclassified statement, naming it and the side', () => {
    const bad: TypeormDiff = { up: [], down: [{ sql: 'GRANT SELECT ON "readings" TO "r"' }] };
    try {
      filterTypeormDiff(bad, owned);
      throw new Error('expected a throw');
    } catch (e) {
      const err = e as TimescaleError;
      expect(err).toBeInstanceOf(TimescaleError);
      expect(err.code).toBe(TimescaleErrorCode.INVALID_ARGUMENT);
      expect(err.context).toMatchObject({ side: 'down' });
      expect(err.message).toMatch(/GRANT SELECT/);
    }
  });

  it("'strict' refuses what 'filter' would have dropped, and says how to proceed", () => {
    expect(() => filterTypeormDiff(diff, owned, { mode: 'strict' })).toThrow(TimescaleError);
    expect(() => filterTypeormDiff(diff, owned, { mode: 'strict' })).toThrow(
      /strict mode.*'filter' mode/s,
    );
    // ...while the default still composes.
    expect(filterTypeormDiff(diff, owned).filtered).toHaveLength(2);
  });
});

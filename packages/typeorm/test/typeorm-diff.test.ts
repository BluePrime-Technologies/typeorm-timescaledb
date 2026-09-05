import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TimescaleError } from '@blueprime/timescaledb-core';
import { readTypeormDiff } from '../src/migrations/typeorm-diff.js';

/**
 * Unit coverage for the M4.5 reader (#235, slice 1).
 *
 * The schema builder is stubbed here on purpose: what this slice owns is the CONTRACT — initialized
 * check, normalisation, and the parameterised-statement refusal. Whether TypeORM's diff is
 * *correct* is TypeORM's business, and whether it survives a real database is slice 5's
 * (integration), because a stub cannot answer that. The live probe behind this design is recorded
 * in the plan doc.
 */
type StubQuery = { query: string; parameters?: unknown[] };

function stubDs(
  up: StubQuery[],
  down: StubQuery[] = [],
  { initialized = true }: { initialized?: boolean } = {},
): DataSource {
  return {
    isInitialized: initialized,
    driver: {
      createSchemaBuilder: () => ({
        log: async () => ({ upQueries: up, downQueries: down }),
      }),
    },
  } as unknown as DataSource;
}

describe('readTypeormDiff', () => {
  it('returns TypeORM up/down statements as plain strings, in order', async () => {
    const diff = await readTypeormDiff(
      stubDs(
        [
          { query: 'CREATE TABLE "readings" ()' },
          { query: 'ALTER TABLE "readings" ADD "note" text' },
        ],
        [
          { query: 'ALTER TABLE "readings" DROP COLUMN "note"' },
          { query: 'DROP TABLE "readings"' },
        ],
      ),
    );

    expect(diff.up).toEqual([
      'CREATE TABLE "readings" ()',
      'ALTER TABLE "readings" ADD "note" text',
    ]);
    // Returned in TYPEORM's order. Reversing for composition belongs to slice 3, not here — doing
    // it in the reader would make the reader's output disagree with `migration:generate`.
    expect(diff.down).toEqual([
      'ALTER TABLE "readings" DROP COLUMN "note"',
      'DROP TABLE "readings"',
    ]);
  });

  it('is empty when TypeORM sees no drift', async () => {
    const diff = await readTypeormDiff(stubDs([], []));
    expect(diff.up).toEqual([]);
    expect(diff.down).toEqual([]);
  });

  it('tolerates an absent or empty parameters array', async () => {
    // `parameters` is optional on Query, and TypeORM sets it to [] in places. Neither is a
    // parameterised statement, and treating them as one would refuse ordinary DDL.
    const diff = await readTypeormDiff(
      stubDs([{ query: 'CREATE TABLE "a" ()' }, { query: 'CREATE TABLE "b" ()', parameters: [] }]),
    );
    expect(diff.up).toHaveLength(2);
  });

  it('REFUSES a parameterised statement rather than dropping its arguments', async () => {
    // A composed migration is written to a .ts class or a .sql file; neither can carry bound
    // parameters. Inlining them re-introduces the injection surface every builder here avoids, and
    // stripping them changes what the statement does. Refusing is the only faithful option.
    await expect(
      readTypeormDiff(
        stubDs([{ query: 'COMMENT ON COLUMN "a"."b" IS $1', parameters: ['hello'] }]),
      ),
    ).rejects.toThrow(TimescaleError);

    await expect(
      readTypeormDiff(
        stubDs([{ query: 'COMMENT ON COLUMN "a"."b" IS $1', parameters: ['hello'] }]),
      ),
    ).rejects.toThrow(/parameterised statement/);
  });

  it('names the offending statement and side, so the refusal is actionable', async () => {
    await expect(
      readTypeormDiff(stubDs([], [{ query: 'SELECT $1', parameters: [1] }])),
    ).rejects.toThrow(/down diff \(#1\).*SELECT \$1/s);
  });

  it('refuses an uninitialized DataSource instead of returning an empty diff', async () => {
    // The dangerous failure is a SILENT empty diff: composition would then emit a migration with no
    // base DDL and a create_hypertable against a table that does not exist.
    await expect(readTypeormDiff(stubDs([], [], { initialized: false }))).rejects.toThrow(
      /must be initialized/,
    );
  });
});

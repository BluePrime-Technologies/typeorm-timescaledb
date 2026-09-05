import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import { readTypeormDiff } from '../src/migrations/typeorm-diff.js';

/**
 * Unit coverage for the M4.5 reader (#235, slice 1).
 *
 * The schema builder is stubbed: what this slice owns is the CONTRACT — the initialized check, the
 * driver guard, and normalisation including parameter preservation. Whether TypeORM's diff is
 * *correct* is TypeORM's business, and whether it survives a real database is slice 5's, because a
 * stub cannot answer that.
 *
 * The parameterised fixtures below are not invented. They are the exact statements a single
 * `@ViewEntity` produced against `typeorm@1.1.0` on a live container while verifying the #236
 * review — which disproved this module's original "parameters should never appear" premise.
 */
type StubQuery = { query: string; parameters?: unknown };

function stubDs(
  up: StubQuery[],
  down: StubQuery[] = [],
  { initialized = true, driver = true }: { initialized?: boolean; driver?: boolean } = {},
): DataSource {
  return {
    isInitialized: initialized,
    options: { type: 'postgres' },
    driver: driver
      ? { createSchemaBuilder: () => ({ log: async () => ({ upQueries: up, downQueries: down }) }) }
      : {},
  } as unknown as DataSource;
}

/** The repo convention (18 test files): assert the CODE and the CONTEXT, not just the message. */
async function expectInvalidArgument(
  run: () => Promise<unknown>,
  context?: Record<string, unknown>,
): Promise<TimescaleError> {
  try {
    await run();
  } catch (e) {
    const err = e as TimescaleError;
    expect(err).toBeInstanceOf(TimescaleError);
    expect(err.code).toBe(TimescaleErrorCode.INVALID_ARGUMENT);
    if (context !== undefined) expect(err.context).toMatchObject(context);
    return err;
  }
  throw new Error('expected readTypeormDiff to throw');
}

describe('readTypeormDiff', () => {
  it('returns TypeORM up/down statements in order', async () => {
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

    expect(diff.up.map((s) => s.sql)).toEqual([
      'CREATE TABLE "readings" ()',
      'ALTER TABLE "readings" ADD "note" text',
    ]);
    // TYPEORM's order. Reversing for composition belongs to slice 3 — doing it here would make the
    // reader disagree with `migration:generate`.
    expect(diff.down.map((s) => s.sql)).toEqual([
      'ALTER TABLE "readings" DROP COLUMN "note"',
      'DROP TABLE "readings"',
    ]);
  });

  it('is empty when TypeORM sees no drift', async () => {
    const diff = await readTypeormDiff(stubDs([], []));
    expect(diff.up).toEqual([]);
    expect(diff.down).toEqual([]);
  });

  it('PRESERVES bound parameters — the @ViewEntity case that disproved the original premise', async () => {
    // Verbatim from a live run: one @ViewEntity emits these two, so refusing them would reject any
    // DataSource declaring a view — using a decorator this library itself re-exports (`orm.ts`).
    const diff = await readTypeormDiff(
      stubDs(
        [
          { query: 'CREATE VIEW "reading_view" AS SELECT 1' },
          {
            query:
              'INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (DEFAULT, $1, $2, $3, $4, $5)',
            parameters: ['public', 'VIEW', 'reading_view', 'SELECT 1'],
          },
        ],
        [
          {
            query:
              'DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "schema" = $3',
            parameters: ['VIEW', 'reading_view', 'public'],
          },
        ],
      ),
    );

    expect(diff.up[1]?.parameters).toEqual(['public', 'VIEW', 'reading_view', 'SELECT 1']);
    expect(diff.down[0]?.parameters).toEqual(['VIEW', 'reading_view', 'public']);
    // A `.ts` emitter can bind these as queryRunner.query()'s second argument, exactly as
    // MigrationGenerateCommand.queryParams() does — no inlining, so no injection surface.
  });

  it('copies the parameters array so a later mutation cannot reach into the diff', async () => {
    const params = ['public', 'VIEW'];
    const diff = await readTypeormDiff(stubDs([{ query: 'INSERT ...', parameters: params }]));
    params.push('mutated');
    expect(diff.up[0]?.parameters).toEqual(['public', 'VIEW']);
  });

  it('OMITS parameters rather than emitting an empty array', async () => {
    // Downstream emitters branch on presence, matching queryParams()'s own `!parameters?.length`.
    const diff = await readTypeormDiff(
      stubDs([{ query: 'CREATE TABLE "a" ()' }, { query: 'CREATE TABLE "b" ()', parameters: [] }]),
    );
    expect(diff.up[0]).not.toHaveProperty('parameters');
    expect(diff.up[1]).not.toHaveProperty('parameters');
  });

  it('refuses a NON-ARRAY parameters value instead of leaking a TypeError downstream', async () => {
    // `parameters` is typed `any[] | undefined`; a null would otherwise surface as
    // "Cannot read properties of null" from whichever emitter touched it, far from here.
    const err = await expectInvalidArgument(
      () => readTypeormDiff(stubDs([], [{ query: 'SELECT 1', parameters: null }])),
      { side: 'down', index: 0, query: 'SELECT 1' },
    );
    expect(err.message).toMatch(/non-array `parameters`/);
  });

  it('refuses an uninitialized DataSource instead of returning an empty diff', async () => {
    // The dangerous failure is a SILENT empty diff: composition would then emit a migration with no
    // base DDL and a create_hypertable against a table that does not exist.
    const err = await expectInvalidArgument(() =>
      readTypeormDiff(stubDs([], [], { initialized: false })),
    );
    expect(err.message).toMatch(/must be initialized/);
  });

  it('refuses a driver with no schema builder, naming the supported range', async () => {
    const err = await expectInvalidArgument(
      () => readTypeormDiff(stubDs([], [], { driver: false })),
      { driver: 'postgres' },
    );
    expect(err.message).toMatch(/\^0\.3\.20 \|\| \^1\.0\.0/);
  });
});

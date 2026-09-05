import type { DataSource } from 'typeorm';
import type { Query } from 'typeorm/driver/Query.js';
import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';

/**
 * TypeORM's own schema diff, normalised — slice 1 of M4.5 (#235).
 *
 * The library owns the TimescaleDB layer and, until M4.5, disclaimed everything beneath it
 * (`PULL_BASE_DDL_CAVEAT`): a `create_hypertable` is emitted against a table this engine never
 * creates, so a user on a fresh database had to run two generators and hand-merge them. Composing
 * needs TypeORM's half as data, which is what this module produces. It does not merge anything —
 * that is slice 3, behind slice 2's protective filter.
 *
 * `dataSource.driver.createSchemaBuilder().log()` is the same call `typeorm migration:generate`
 * uses. It is READ-ONLY: it computes the queries a sync would run and returns them, executing
 * nothing.
 */

/** TypeORM's half of a composed migration: plain SQL, already ordered by TypeORM. */
export interface TypeormDiff {
  /** Statements that bring the database up to the entity definitions. */
  readonly up: readonly string[];
  /** TypeORM's inverse, in TypeORM's own order. Reversing for composition is slice 3's job. */
  readonly down: readonly string[];
}

/**
 * Read TypeORM's pending schema diff for `dataSource`.
 *
 * Requires an INITIALIZED DataSource, and connects: unlike `generateTimescaleMigration` (which is
 * synchronous and desired-state only), this diffs against the live database, because that is what
 * TypeORM's schema builder does. The CLI already initialises before dispatching any verb
 * (`cli/main.ts` → `initializeForCli`), so this adds no new requirement there.
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` if the DataSource is not initialized, or if TypeORM
 *   emits a PARAMETERISED statement — see the note below.
 */
export async function readTypeormDiff(dataSource: DataSource): Promise<TypeormDiff> {
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before reading the TypeORM ' +
        'schema diff — the schema builder queries the live database',
    );
  }

  const sql = await dataSource.driver.createSchemaBuilder().log();

  return {
    up: normalise(sql.upQueries, 'up'),
    down: normalise(sql.downQueries, 'down'),
  };
}

/**
 * `Query[]` → `string[]`, refusing anything that cannot be represented faithfully.
 *
 * `Query` carries an optional `parameters` array. A composed migration is written out as a `.ts`
 * class or a `.sql` file, and neither can carry bound parameters — so a parameterised statement
 * would have to be inlined (re-introducing the injection surface every builder in this repo exists
 * to avoid) or silently stripped of its arguments, which changes what the statement does.
 *
 * Refusing is the only honest third option, and it matches how this engine treats every other
 * shape it cannot represent: an unparseable continuous-aggregate definition falls back to
 * `not-compared` rather than being guessed at. DDL from the schema builder is literal in practice,
 * so this should never fire — but "should never fire" is exactly the assumption worth asserting,
 * because the failure it guards against is silent and lands in a migration a user then runs.
 */
function normalise(queries: readonly Query[], side: string): string[] {
  return queries.map((q, i) => {
    if (q.parameters !== undefined && q.parameters.length > 0) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `TypeORM emitted a parameterised statement in its ${side} diff (#${i + 1}), which cannot be ` +
          `written to a migration file without inlining the values: ${q.query}`,
        { side, index: i, query: q.query },
      );
    }
    return q.query;
  });
}

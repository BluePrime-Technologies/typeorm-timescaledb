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
 * uses. It is READ-ONLY: `log()` reads the schema, calls `enableSqlMemory()` BEFORE
 * `executeSchemaSyncOperationsInProperOrder()`, and returns `getMemorySql()`. The one write path,
 * `createMetadataTableIfNecessary()`, is reachable only from `build()`.
 */

/**
 * One statement from TypeORM's diff, with its bound parameters preserved.
 *
 * **Parameters are carried, not refused.** The first draft of this module threw on any statement
 * with parameters, on the stated grounds that a migration file "cannot carry bound parameters" and
 * that schema-builder DDL is literal so it "should never fire". Both halves were wrong, and the
 * #236 review disproved them with TypeORM's own source. Measured against `typeorm@1.1.0` here, a
 * single `@ViewEntity` yields two parameterised statements:
 *
 * ```
 * [up]   params=4  INSERT INTO "typeorm_metadata"(...) VALUES (DEFAULT, $1, $2, $3, $4, $5)
 * [down] params=3  DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 ...
 * ```
 *
 * That path also fires for `STORED` generated columns. It is not exotic — this library re-exports
 * `ViewEntity` as part of its own unified DSL (`orm.ts`), so refusing would tell users to model
 * views with us and then reject their DataSource outright.
 *
 * And a `.ts` migration CAN carry them: `MigrationGenerateCommand.queryParams()` splices
 * `, ["public","VIEW",...]` in as `queryRunner.query()`'s second argument. Parameters stay bound —
 * no inlining, so no injection surface. The `.sql` emitter is the only surface with the real
 * limitation, and refusing there is the emitter's decision to make with the whole statement in
 * hand, not this reader's to make for it.
 */
export interface TypeormStatement {
  /** The SQL text, exactly as TypeORM produced it. */
  readonly sql: string;
  /** Bound parameters, when the statement has any. Absent (not `[]`) when it does not. */
  readonly parameters?: readonly unknown[];
}

/** TypeORM's half of a composed migration, already ordered by TypeORM. */
export interface TypeormDiff {
  /** Statements that bring the database up to the entity definitions. */
  readonly up: readonly TypeormStatement[];
  /** TypeORM's inverse, in TypeORM's own order. Reversing for composition is slice 3's job. */
  readonly down: readonly TypeormStatement[];
}

/**
 * Read TypeORM's pending schema diff for `dataSource`.
 *
 * Requires an INITIALIZED DataSource, and connects: unlike `generateTimescaleMigration` (which is
 * synchronous and desired-state only), this diffs against the live database, because that is what
 * TypeORM's schema builder does. The CLI already initialises before dispatching any verb
 * (`cli/main.ts` → `initializeForCli`), so this adds no new requirement there.
 *
 * @throws {TimescaleError} `INVALID_ARGUMENT` if the DataSource is not initialized, if the driver
 *   exposes no schema builder, or if a statement's `parameters` is present but not an array.
 */
export async function readTypeormDiff(dataSource: DataSource): Promise<TypeormDiff> {
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before reading the TypeORM ' +
        'schema diff — the schema builder queries the live database',
    );
  }

  // Guard the boundary rather than let a bare TypeError escape. Every driver in the supported peer
  // range (`^0.3.20 || ^1.0.0`) has this, so reaching here means an unsupported driver, and saying
  // so beats "createSchemaBuilder is not a function" from inside a library the user did not call.
  if (typeof dataSource.driver?.createSchemaBuilder !== 'function') {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `The configured driver exposes no createSchemaBuilder(), so TypeORM's schema diff cannot be ` +
        `read. This package supports typeorm ^0.3.20 || ^1.0.0 on postgres.`,
      { driver: dataSource.options?.type },
    );
  }

  const sql = await dataSource.driver.createSchemaBuilder().log();

  return {
    up: normalise(sql.upQueries, 'up'),
    down: normalise(sql.downQueries, 'down'),
  };
}

/**
 * `Query[]` → {@link TypeormStatement}`[]`, preserving parameters and normalising their absence.
 *
 * `parameters` is omitted rather than emitted as `[]` so downstream emitters can branch on presence
 * alone, matching `queryParams()`'s own `!parameters?.length` test.
 */
function normalise(queries: readonly Query[], side: 'up' | 'down'): TypeormStatement[] {
  return queries.map((q, index) => {
    // Shape check, not a policy: `parameters` is typed `any[] | undefined`, so a non-array would
    // otherwise surface later as a raw TypeError from whichever emitter touched it — far from here
    // and outside this function's declared @throws.
    if (q.parameters !== undefined && !Array.isArray(q.parameters)) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `TypeORM returned a non-array \`parameters\` on its ${side} diff (#${index + 1}), which ` +
          `cannot be carried into a migration: ${q.query}`,
        { side, index, query: q.query },
      );
    }

    return q.parameters !== undefined && q.parameters.length > 0
      ? { sql: q.query, parameters: [...q.parameters] }
      : { sql: q.query };
  });
}

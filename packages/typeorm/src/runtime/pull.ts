import type { DataSource } from 'typeorm';
import {
  classifyOperation,
  stateToOperations,
  type Plan,
  type PlanStep,
  type SchemaStateIR,
  type SkippedObject,
} from '@blueprime/timescaledb-core';
import { introspect } from './introspect.js';
import { planToMigration, type GeneratedMigration } from '../migrations/index.js';

/**
 * The `pull` verb's programmatic form (M4.4b): read a live TimescaleDB and produce the migration
 * that would recreate its Timescale layer, plus an honest account of what could not be reproduced.
 *
 * `pull` is **read-only**. It introspects and builds a migration in memory; it never executes DDL.
 * There is deliberately no `apply` option — converging a database is `push`'s job, and a verb whose
 * name means "read" must not be able to write.
 */

/**
 * The unconditional limit of what `pull` can reproduce, surfaced to the operator every time rather
 * than buried in docs. This is the library's boundary, not a defect: `SchemaStateIR` models the
 * TimescaleDB layer, so base relational DDL is simply not visible to it.
 */
export const PULL_BASE_DDL_CAVEAT =
  'Base relational DDL is NOT included: tables, columns, types, indexes, constraints, triggers, ' +
  "functions and extensions are outside this library and must come from TypeORM's own " +
  'migration:generate or stay hand-written. The reproduced migration assumes those objects ' +
  'already exist — a create_hypertable runs against a table it does not create.';

/** What `pull` managed to reproduce, and what it did not. */
export interface PullCoverage {
  /** Hypertables seen in the live database. */
  readonly hypertablesFound: number;
  /** Continuous aggregates seen in the live database. */
  readonly continuousAggregatesFound: number;
  /** Operations emitted into the migration. */
  readonly operationsEmitted: number;
  /**
   * Objects (or facets of objects) that could not be reproduced, each with a machine-readable
   * reason. Empty means everything in scope was reproduced.
   */
  readonly skipped: readonly SkippedObject[];
  /** `true` when nothing was skipped. Note this is scoped by {@link PULL_BASE_DDL_CAVEAT}. */
  readonly complete: boolean;
}

export interface PullResult {
  /** The live schema as introspected — the input the migration was derived from. */
  readonly ir: SchemaStateIR;
  /** The reproduce operations, safety-classified, in execution order. */
  readonly plan: Plan;
  /** The renderable migration. `up` is empty when the database has no Timescale objects. */
  readonly migration: GeneratedMigration;
  readonly coverage: PullCoverage;
}

export interface PullOptions {
  /** Migration class-name prefix. Default `'Timescale'` (via `planToMigration`). */
  readonly name?: string;
  /** Override the timestamp, for reproducible output in tests. */
  readonly timestamp?: number;
}

/**
 * Introspect `dataSource`'s database and reproduce its TimescaleDB layer as a migration.
 *
 * Unlike `check`/`push`, this does not consult the entity decorators at all — the database is the
 * only input, which is the whole point of adopting a schema nobody modelled in code.
 */
export async function pullSchema(
  dataSource: DataSource,
  options: PullOptions = {},
): Promise<PullResult> {
  const ir = await introspect(dataSource);
  const { operations, skipped } = stateToOperations(ir);

  // Classify authoritatively from the operation itself, exactly as `applyDirect` does — never from
  // caller-supplied metadata, so a safety class can't be misreported by construction.
  const steps: PlanStep[] = operations.map((operation) => ({
    operation,
    ...classifyOperation(operation),
  }));
  const plan: Plan = { steps };

  const migration = planToMigration(plan, {
    ...(options.name !== undefined && { name: options.name }),
    ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
  });

  return {
    ir,
    plan,
    migration,
    coverage: {
      hypertablesFound: ir.hypertables.length,
      continuousAggregatesFound: ir.continuousAggregates.length,
      operationsEmitted: operations.length,
      skipped,
      complete: skipped.length === 0,
    },
  };
}

/**
 * Render {@link PullCoverage} for a human. Always ends with {@link PULL_BASE_DDL_CAVEAT} — a
 * coverage report that only listed *detected* omissions would imply the rest is a complete copy.
 */
export function formatPullCoverage(coverage: PullCoverage): string {
  const lines = [
    'Coverage:',
    `  hypertables found:          ${coverage.hypertablesFound}`,
    `  continuous aggregates found: ${coverage.continuousAggregatesFound}`,
    `  operations emitted:         ${coverage.operationsEmitted}`,
  ];

  if (coverage.skipped.length === 0) {
    lines.push('  not reproduced:             none');
  } else {
    lines.push(`  NOT REPRODUCED (${coverage.skipped.length}):`);
    for (const s of coverage.skipped) {
      lines.push(`    - ${s.object} [${s.facet}] (${s.reason})`);
      lines.push(`      ${s.detail}`);
    }
  }

  lines.push('', `NOTE: ${PULL_BASE_DDL_CAVEAT}`);
  return lines.join('\n');
}

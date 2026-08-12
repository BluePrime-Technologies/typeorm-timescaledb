import type { DataSource } from 'typeorm';
import {
  classifyOperation,
  compileOperation,
  stateToOperations,
  type Operation,
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
  'already exist — a create_hypertable runs against a table it does not create. ' +
  'Also NOT reproduced, and NOT counted above: compression/retention policies attached to a ' +
  "continuous aggregate (rather than to a hypertable), the chunk interval of a CAGG's own " +
  'materialization hypertable, and NULLS FIRST/LAST placement on a columnstore ORDER BY. Those ' +
  'are invisible to introspection today, so "not reproduced: none" above cannot speak for them — ' +
  'check them by hand before treating a pulled migration as a complete copy. ' +
  'Finally, this migration targets an EMPTY database. It is not idempotent against the database ' +
  'it came from: CREATE MATERIALIZED VIEW has no IF NOT EXISTS, so running it back on the source ' +
  'fails partway. On the source, record it as already applied instead of running it.';

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
  const { operations, skipped: irSkipped } = stateToOperations(ir);

  // Compression/retention policies attached to a CONTINUOUS AGGREGATE are invisible to the IR:
  // `introspect()` keys them by the hypertable a job names and reads those maps only while mapping
  // USER hypertables, so a CAGG's own policies never arrive. `skipped` can therefore never contain
  // them, and `complete` — defined as `skipped.length === 0` — reported a faithful copy of a
  // database this reproduction demonstrably did not copy.
  //
  // Detecting them needs no internal catalog: the public jobs and continuous_aggregates views are
  // enough, matched on BOTH identities because `jobs.hypertable_*` is the materialization
  // hypertable on 2.18 and the user view on 2.28+.
  // The probe is guarded. If it cannot run — an old server, restricted permissions, a caller that
  // supplied a narrower DataSource — losing the whole `pull` would be a poor trade for a coverage
  // detail. But "could not check" is not "nothing found", so the failure is recorded as a skip
  // rather than swallowed, which keeps `complete` honest in both directions.
  let caggPolicyRows: Array<{ proc_name: string; view_schema: string; view_name: string }> = [];
  let caggProbeFailed: string | undefined;
  try {
    caggPolicyRows = await dataSource.query(
      `SELECT j.proc_name, c.view_schema, c.view_name
         FROM timescaledb_information.jobs j
         JOIN timescaledb_information.continuous_aggregates c
           ON (j.hypertable_schema = c.materialization_hypertable_schema
               AND j.hypertable_name = c.materialization_hypertable_name)
            OR (j.hypertable_schema = c.view_schema AND j.hypertable_name = c.view_name)
        WHERE j.proc_name IN ('policy_compression', 'policy_retention')`,
    );
  } catch (error) {
    caggProbeFailed = error instanceof Error ? error.message : String(error);
  }

  const caggSkips: SkippedObject[] = caggPolicyRows.map((r) => ({
    object: `${r.view_schema}.${r.view_name}`,
    facet: r.proc_name === 'policy_compression' ? 'compressionPolicy' : 'retentionPolicy',
    reason: 'cagg-attached-policy',
    detail:
      `a ${r.proc_name === 'policy_compression' ? 'compression' : 'retention'} policy is attached ` +
      `to this continuous aggregate. It is NOT reproduced by this migration — reproduce it by hand ` +
      `with add_columnstore_policy/add_retention_policy on the aggregate.`,
  }));

  const skipped: SkippedObject[] = [
    ...irSkipped,
    ...caggSkips,
    ...(caggProbeFailed === undefined
      ? []
      : [
          {
            object: '(continuous aggregates)',
            facet: 'compressionPolicy' as const,
            reason: 'cagg-attached-policy' as const,
            detail:
              `could not determine whether any continuous aggregate carries its own ` +
              `compression/retention policy (${caggProbeFailed}). Such policies are NOT reproduced ` +
              `by this migration; check by hand before trusting this as a complete copy.`,
          },
        ]),
  ];

  // Classify authoritatively from the operation itself, exactly as `applyDirect` does — never from
  // caller-supplied metadata, so a safety class can't be misreported by construction.
  const steps: PlanStep[] = operations.map((operation) => ({
    operation,
    ...classifyOperation(operation),
  }));
  const plan: Plan = { steps };

  // Compile operation-by-operation so ONE unreproducible object cannot abort the whole pull.
  //
  // `stateToOperations` documents itself as total — "it never throws on a shape it cannot express" —
  // and it keeps that promise. The throw happened one layer down, in planToMigration → compilePlan →
  // parseTable, whose allow-list is ASCII-only while PostgreSQL permits non-ASCII letters unquoted
  // under UTF-8 (and anything when quoted). So `pull` against a database with one such table died
  // outright, reproducing NOTHING, when the honest outcome is a migration for everything else plus a
  // report naming what was left out. Totality has to hold end to end or it is not totality.
  const compilable: PlanStep[] = [];
  const unexpressible: SkippedObject[] = [];
  for (const step of steps) {
    try {
      compileOperation(step.operation);
      compilable.push(step);
    } catch (error) {
      unexpressible.push({
        object: objectOfOperation(step.operation),
        facet: 'hypertable',
        reason: 'identifier-not-expressible',
        detail:
          `could not be reproduced: ${error instanceof Error ? error.message : String(error)}. ` +
          `PostgreSQL accepts this name; these builders deliberately do not emit it. Reproduce this ` +
          `object by hand — everything else in this migration is unaffected.`,
      });
    }
  }
  if (unexpressible.length > 0) skipped.push(...unexpressible);

  const migration = planToMigration(
    { steps: compilable },
    {
      ...(options.name !== undefined && { name: options.name }),
      ...(options.timestamp !== undefined && { timestamp: options.timestamp }),
    },
  );

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

/** Best-effort object name for a skip report — operations name a table, a view, or a rename source. */
function objectOfOperation(operation: Operation): string {
  const o = operation as { table?: unknown; view?: unknown; from?: unknown };
  if (typeof o.table === 'string') return o.table;
  if (typeof o.view === 'string') return o.view;
  if (typeof o.from === 'string') return o.from;
  return '(unknown object)';
}

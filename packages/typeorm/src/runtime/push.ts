import type { DataSource } from 'typeorm';
import {
  diffSchemaState,
  isEmptyPlan,
  type Plan,
  type PlanAdvisory,
} from '@blueprime/timescaledb-core';
import { introspect } from './introspect.js';
import { compileDesiredState } from './desired-state.js';
import { collectRenames } from './renames.js';
import { applyDirect } from './apply.js';

/** Options for {@link pushSchema}. */
export interface PushOptions {
  /**
   * Actually converge the database. Default `false` — `push` computes and returns the plan but
   * mutates NOTHING, so running it unintentionally can never change a schema.
   */
  readonly apply?: boolean;
  /** Opt in to the reversible policy removals the diff can emit (`DiffOptions.allowDrops`). */
  readonly allowDrops?: boolean;
  /**
   * Opt in to applying steps classified `refuse-by-default`. Deliberately separate from
   * {@link allowDrops}: removing a background job and performing a dangerous operation are
   * different risks, and one flag must not silently grant both.
   */
  readonly allowRefused?: boolean;
  /**
   * The `@ContinuousAggregate` classes to compare, exactly as `generateTimescaleMigration` takes
   * them. CAGG metadata lives in a module-private WeakMap and CAGG classes are not TypeORM entities,
   * so they can NEVER be discovered from a DataSource — an omitted list means CAGGs are not compared
   * at all.
   *
   * **Omitting it is not silent.** The returned plan carries a `not-compared` advisory naming the
   * gap, because "no drift detected" from a run that never looked at aggregates is precisely the
   * false-green this whole comparison was added to close. Pass `[]` to state affirmatively that the
   * project declares none; that is not advised against.
   */
  readonly continuousAggregates?: readonly (abstract new (...args: never[]) => unknown)[];
}

/**
 * The advisory raised when {@link PushOptions.continuousAggregates} is omitted entirely.
 *
 * Exported so `check`, `push`, and their tests all assert on ONE string rather than three copies
 * that can drift apart.
 */
export const CAGG_LIST_ABSENT_ADVISORY: PlanAdvisory = {
  kind: 'not-compared',
  object: '(all continuous aggregates)',
  detail:
    'No continuous aggregates were passed, so NONE were compared — a declared aggregate missing ' +
    'from this database would not be reported. Continuous aggregates cannot be discovered from a ' +
    'DataSource (they are not entities); export a `continuousAggregates` array from your DataSource ' +
    'module, or pass one explicitly. Pass an empty array to declare that there are none.',
};

/** The outcome of a {@link pushSchema} run. */
export interface PushResult {
  /** The drift plan that was computed (empty when the database already matches the entities). */
  readonly plan: Plan;
  /**
   * `true` when the plan was actually applied. `false` covers BOTH a preview and an
   * already-converged database — pair it with `isEmptyPlan(plan)` to tell those apart (the CLI
   * reports them differently: "No drift detected" vs "Preview only").
   */
  readonly applied: boolean;
  /** The SQL statements that were executed (empty for a preview or an empty plan). */
  readonly statements: readonly string[];
}

/**
 * Converge a live database toward the `@Hypertable` entities — the `push` verb, and the composition
 * of everything the engine already exposes: `introspect` → `compileDesiredState` → `diffSchemaState`
 * → `applyDirect`.
 *
 * **Preview by default.** With `apply` unset this only computes the plan; nothing is written. That
 * makes the destructive direction the one you have to ask for, not the one you get by forgetting a
 * flag.
 *
 * It constructs no SQL of its own — every statement comes from the single core compile choke point
 * via `applyDirect`, so the safety gate there still governs what may run.
 */
export async function pushSchema(
  dataSource: DataSource,
  options: PushOptions = {},
): Promise<PushResult> {
  const current = await introspect(dataSource);
  const desired = compileDesiredState(dataSource, {
    ...(options.continuousAggregates !== undefined && {
      continuousAggregates: options.continuousAggregates,
    }),
  });
  const renames = collectRenames(dataSource);
  const diffed = diffSchemaState(current, desired, {
    renames,
    allowDrops: options.allowDrops ?? false,
  });

  // An OMITTED list means no aggregate was compared — which the diff cannot detect, since an empty
  // desired list is indistinguishable from "this project declares none". Only this layer knows the
  // difference, so the advisory has to be raised here. Without it, option B (pass the list
  // explicitly) would silently reinstate the false-green for anyone who forgets the export.
  const advisories: PlanAdvisory[] = [
    ...(options.continuousAggregates === undefined ? [CAGG_LIST_ABSENT_ADVISORY] : []),
    ...(diffed.advisories ?? []),
  ];
  const plan: Plan = { ...diffed, ...(advisories.length > 0 && { advisories }) };

  if (options.apply !== true || isEmptyPlan(plan)) {
    return { plan, applied: false, statements: [] };
  }

  const result = await applyDirect(dataSource, plan, {
    ...(options.allowRefused === true && { allowRefuseByDefault: true }),
  });
  return { plan, applied: true, statements: result.statements };
}

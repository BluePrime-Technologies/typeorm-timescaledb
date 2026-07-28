import type { DataSource } from 'typeorm';
import { diffSchemaState, isEmptyPlan, type Plan } from '@blueprime/timescaledb-core';
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
}

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
  const desired = compileDesiredState(dataSource);
  const renames = collectRenames(dataSource);
  const plan = diffSchemaState(current, desired, {
    renames,
    allowDrops: options.allowDrops ?? false,
  });

  if (options.apply !== true || isEmptyPlan(plan)) {
    return { plan, applied: false, statements: [] };
  }

  const result = await applyDirect(dataSource, plan, {
    ...(options.allowRefused === true && { allowRefuseByDefault: true }),
  });
  return { plan, applied: true, statements: result.statements };
}

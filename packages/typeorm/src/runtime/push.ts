import type { DataSource } from 'typeorm';
import {
  diffSchemaState,
  isEmptyPlan,
  TimescaleError,
  TimescaleErrorCode,
  type Plan,
  type PlanAdvisory,
  type PlanStep,
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
   * What to do about a continuous aggregate whose definition has drifted — passed through to
   * {@link DiffOptions.continuousAggregateRecreate}. Default `'advise'`.
   *
   * - `'advise'` — blocking advisory, no step, nothing to apply. Unchanged 0.7.x behaviour.
   * - `'plan'` — the step appears in the plan (so `check` and `mix` show it) but `push` NEVER
   *   applies it: it is held back and reported in {@link PushResult.heldBack}, and the rest of the
   *   plan applies normally.
   * - `'apply'` — the step applies, but only with {@link allowRefused} as well.
   */
  readonly continuousAggregateRecreate?: 'advise' | 'plan' | 'apply';
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
  /**
   * Steps deliberately NOT applied, with the reason. Populated in
   * `continuousAggregateRecreate: 'plan'` mode, where the recreate step exists to be SEEN and never
   * run — the rest of the plan still applies, so a drifted aggregate does not block a user's
   * unrelated retention and columnstore changes.
   *
   * Non-empty here with `applied: true` is normal and not an error; the CLI reports it.
   */
  readonly heldBack: readonly { readonly step: PlanStep; readonly reason: string }[];
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
    continuousAggregateRecreate: options.continuousAggregateRecreate ?? 'advise',
  });

  // An OMITTED list means no aggregate was compared — which the diff cannot detect, since an empty
  // desired list is indistinguishable from "this project declares none". Only this layer knows the
  // difference, so the advisory has to be raised here. Without it, option B (pass the list
  // explicitly) would silently reinstate the false-green for anyone who forgets the export.
  const listAbsent = options.continuousAggregates === undefined;
  // When the umbrella advisory fires, drop the diff's per-view "exists but is not declared" notes:
  // they say the same thing once per aggregate, so a project with 12 of them got 13 paragraphs for
  // one fact. (The diff still emits them on its own, for callers that compose the pipeline by hand
  // and never reach this function — that is the case they exist for.)
  const fromDiff = (diffed.advisories ?? []).filter(
    (a) => !(listAbsent && a.kind === 'not-compared'),
  );
  const advisories: PlanAdvisory[] = [
    ...(listAbsent ? [CAGG_LIST_ABSENT_ADVISORY] : []),
    ...fromDiff,
  ];
  const plan: Plan = { ...diffed, ...(advisories.length > 0 && { advisories }) };

  if (options.apply !== true || isEmptyPlan(plan)) {
    return { plan, applied: false, statements: [], heldBack: [] };
  }

  // `applyDirect` refuses the WHOLE plan if any step is `refuse-by-default`. That gate is right for
  // `'apply'` mode and wrong for `'plan'` mode, whose entire point is that the recreate step is
  // visible but never run — refusing the user's unrelated steps because of it would be a bug, not
  // caution. So partition here rather than letting the all-or-nothing gate decide.
  const mode = options.continuousAggregateRecreate ?? 'advise';
  const heldBack =
    mode === 'plan'
      ? plan.steps
          .filter((s) => s.operation.kind === 'recreateContinuousAggregate')
          .map((step) => ({
            step,
            reason:
              "continuousAggregateRecreate: 'plan' shows this step but never applies it. To apply " +
              "it, use 'apply' mode together with allowRefused (--allow-refused); it DROPs and " +
              'recreates the aggregate, discarding its materialized rows.',
          }))
      : [];

  // A failure the user's own configuration caused must name the choice that caused it and what to
  // choose instead — `applyDirect`'s generic "refused N operations classified refuse-by-default"
  // cannot be connected back to a mode set in a config file weeks ago.
  if (mode === 'apply' && options.allowRefused !== true) {
    const recreates = plan.steps.filter((s) => s.operation.kind === 'recreateContinuousAggregate');
    if (recreates.length > 0) {
      const views = recreates.map((s) => (s.operation as { view: string }).view).join(', ');
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `continuousAggregateRecreate: 'apply' emitted ${recreates.length} continuous-aggregate ` +
          `recreate step(s) (${views}), which DROP and recreate the aggregate and discard its ` +
          'materialized rows. That needs a second, explicit opt-in and it is missing.\n' +
          '  • to apply it: also pass allowRefused (CLI: --allow-refused)\n' +
          "  • to apply everything ELSE and only be SHOWN this step: use 'plan' mode\n" +
          "  • to go back to an advisory with no step at all: use 'advise' mode (the default)",
        { views, mode },
      );
    }
  }

  const applicable: Plan =
    heldBack.length === 0
      ? plan
      : { ...plan, steps: plan.steps.filter((s) => !heldBack.some((h) => h.step === s)) };

  // Everything held back, nothing left to do: report it rather than opening a transaction.
  if (applicable.steps.length === 0) {
    return { plan, applied: false, statements: [], heldBack };
  }

  const result = await applyDirect(dataSource, applicable, {
    ...(options.allowRefused === true && { allowRefuseByDefault: true }),
  });
  return { plan, applied: true, statements: result.statements, heldBack };
}

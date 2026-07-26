import type { DataSource } from 'typeorm';
import {
  classifyOperation,
  compilePlan,
  TimescaleError,
  TimescaleErrorCode,
  type Plan,
} from '@blueprime/timescaledb-core';

/** Which half of a {@link Plan} to run: converge forward (`up`) or revert (`down`). */
export type ApplyDirection = 'up' | 'down';

/** Options for {@link applyDirect}. */
export interface ApplyDirectOptions {
  /** Run the plan's `up` (converge, default) or `down` (revert). */
  readonly direction?: ApplyDirection;
  /**
   * Apply operations classified `refuse-by-default` (dangerous / no data-safe path). Default `false`:
   * if the plan contains any such step, {@link applyDirect} throws BEFORE running anything. `one-way`
   * (e.g. create hypertable) and `needs-recompress` operations are NOT gated — they are non-destructive
   * (a resumable recompress planner for the latter arrives in a later milestone).
   */
  readonly allowRefuseByDefault?: boolean;
  /**
   * Wrap every statement in ONE transaction so the apply is all-or-nothing (default `true`). A failure
   * rolls the whole batch back. Set `false` only for a statement a transaction can't contain.
   */
  readonly transaction?: boolean;
}

/** The outcome of an {@link applyDirect} run. */
export interface ApplyDirectResult {
  /** The direction that was run. */
  readonly direction: ApplyDirection;
  /** The SQL statements executed, in order (empty when the plan had no steps). */
  readonly statements: readonly string[];
  /** Number of plan steps the statements came from. */
  readonly stepCount: number;
}

/**
 * Apply a typed {@link Plan} directly to a live database — the sync-engine core. The plan is produced
 * upstream (`diffSchemaState`, or `TimescaleSchemaBuilder.toPlan()`); this runs its compiled `up`
 * (default) or `down` against the DataSource, transactionally, through the single core compile choke
 * point (`compileOperation`, via `compilePlan`) — it constructs no SQL of its own.
 *
 * **Guarded by default.** If any step is classified `refuse-by-default` (dangerous / no data-safe
 * revert), it throws before executing anything unless `allowRefuseByDefault` is set — so a destructive
 * operation never reaches the database implicitly. `one-way` and `needs-recompress` operations run
 * (they are non-destructive), and `down` uses each op's own reversible inverse, so a `down` never
 * destroys data.
 *
 * **Atomic by default.** All statements run in one transaction; a failure rolls the batch back and the
 * error propagates. The connection is always released.
 */
export async function applyDirect(
  dataSource: DataSource,
  plan: Plan,
  options: ApplyDirectOptions = {},
): Promise<ApplyDirectResult> {
  const direction = options.direction ?? 'up';
  const useTransaction = options.transaction ?? true;

  // Safety gate: refuse dangerous ops unless explicitly opted in — checked BEFORE touching the DB.
  // Classification is AUTHORITATIVE from the operation itself (classifyOperation), NOT the plan's
  // caller-supplied `step.safety` — a hand-built Plan cannot mislabel a dangerous op to slip the gate.
  if (options.allowRefuseByDefault !== true) {
    const refused = plan.steps.filter(
      (s) => classifyOperation(s.operation).safety === 'refuse-by-default',
    );
    if (refused.length > 0) {
      const kinds = [...new Set(refused.map((s) => s.operation.kind))].join(', ');
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `applyDirect refused ${refused.length} operation(s) classified refuse-by-default (${kinds}); ` +
          `pass { allowRefuseByDefault: true } to apply them`,
        { refusedKinds: kinds },
      );
    }
  }

  const compiled = compilePlan(plan);
  const statements = direction === 'down' ? compiled.down : compiled.up;
  const result: ApplyDirectResult = { direction, statements, stepCount: plan.steps.length };

  // Nothing to run — don't open a transaction for a no-op plan.
  if (statements.length === 0) return result;

  const runner = dataSource.createQueryRunner();
  let succeeded = false;
  try {
    await runner.connect();
    if (useTransaction) await runner.startTransaction();
    try {
      // Sequential: one statement per query() (TimescaleDB rejects multi-command prepared queries),
      // and a single connection cannot run concurrent queries.
      for (const sql of statements) await runner.query(sql);
      if (useTransaction) await runner.commitTransaction();
    } catch (err) {
      // Roll back, but never let a rollback failure mask the original error (the real cause).
      if (useTransaction && runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
        } catch {
          /* preserve the original error below */
        }
      }
      throw err;
    }
    succeeded = true;
  } finally {
    // Always release. A release() failure is only surfaced when the work itself succeeded — otherwise
    // the primary error (query/commit/rollback) must win, not the cleanup error.
    try {
      await runner.release();
    } catch (releaseErr) {
      if (succeeded) throw releaseErr;
    }
  }

  return result;
}

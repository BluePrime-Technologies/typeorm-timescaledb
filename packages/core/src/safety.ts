import type { Operation } from './operation.js';

/**
 * The safety classification of a migration {@link Operation} (M4.2, H4 research). It tells the diff/plan
 * consumer (the `check`/`generate` verbs) how risky an operation is to apply, so a plan can be emitted,
 * gated, or refused accordingly. A single dominant class per operation:
 *
 * This classifies the **migration OPERATION** (applying/reverting the schema change) — NOT the runtime
 * behavior of a background job it may install. A retention policy is `online-safe` to add/remove even
 * though the installed policy later drops old chunks on its schedule (its declared purpose); that
 * ongoing effect is surfaced in the operation's own description, not by the safety class.
 *
 * - **`online-safe`** — the DDL operation applies without rewriting data or a notable lock and is
 *   cleanly reversible (add ⇄ remove). (Background policy add/remove/alter.)
 * - **`needs-recompress`** — not data-losing, but applying requires decompressing/recompressing existing
 *   chunks (costly). (Changing segmentby/orderby on a populated columnstore.)
 * - **`one-way`** — safe to apply but NOT cleanly reversible: the generated `down()` cannot restore the
 *   prior state (it is a non-destructive notice or discards only recomputable data). (Hypertable
 *   conversion, enabling the columnstore, creating a continuous aggregate.)
 * - **`refuse-by-default`** — destructive / data-losing; never emitted without an explicit opt-in.
 *   (Dropping a hypertable, disabling the columnstore, dropping a column.)
 *
 * NOTE: `needs-recompress` and `refuse-by-default` are forward-looking vocabulary for the alter/drop
 * slice — no current {@link Operation} variant returns them (except the unknown-kind fallback below).
 */
export type SafetyClass = 'online-safe' | 'needs-recompress' | 'refuse-by-default' | 'one-way';

/** An operation's safety class plus a human-readable reason (surfaced by the `check` verb). */
export interface OperationSafety {
  readonly safety: SafetyClass;
  readonly reason: string;
}

/**
 * Classify one {@link Operation} by its application safety. Total over the operation union (exhaustive —
 * a new variant without a case is a compile error); an unknown discriminant from an `any`/JS caller
 * degrades to the most conservative `refuse-by-default`.
 */
export function classifyOperation(operation: Operation): OperationSafety {
  switch (operation.kind) {
    case 'createHypertable':
      return {
        safety: 'one-way',
        reason:
          'converting a table to a hypertable is not cleanly reversible — down() is a non-destructive notice, not a demotion',
      };
    case 'addColumnstorePolicy':
      return {
        safety: 'one-way',
        reason:
          'enabling the columnstore is a one-way conversion — down() leaves the columnstore enabled (removing at most the compression policy)',
      };
    case 'addRetentionPolicy':
      return {
        safety: 'online-safe',
        reason:
          'adding a retention policy rewrites no data and is cleanly removed on down() (add ⇄ remove); note the installed policy drops chunks past its threshold on its schedule — its declared purpose — and removing it does not restore already-dropped data',
      };
    case 'createContinuousAggregate':
      return {
        safety: 'one-way',
        reason:
          'a continuous aggregate is created WITH NO DATA — dropping it on down() discards only materialized (recomputable) rows, not source data',
      };
    case 'addContinuousAggregatePolicy':
      return {
        safety: 'online-safe',
        reason:
          'a continuous-aggregate refresh policy is a background job — cleanly removed on down()',
      };
    default: {
      // Exhaustiveness: a new Operation variant without a case fails to compile here.
      const unhandled: never = operation;
      return {
        safety: 'refuse-by-default',
        reason: `unknown operation kind: ${String((unhandled as { kind?: unknown }).kind)}`,
      };
    }
  }
}

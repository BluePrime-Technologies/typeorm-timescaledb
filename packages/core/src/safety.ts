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
 * NOTE: `alterColumnstoreConfig` is `needs-recompress`; `refuse-by-default` remains forward-looking
 * vocabulary for the drops slice (no current {@link Operation} variant returns it except the
 * unknown-kind fallback below).
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
    case 'addCompressionPolicy':
      return {
        safety: 'online-safe',
        reason:
          'adds only the compression policy job to an already-enabled columnstore — no data rewrite, cleanly removed on down()',
      };
    case 'alterCompressionPolicy':
      return {
        safety: 'online-safe',
        reason:
          'changes when compression runs (remove-then-add of a background job) — rewrites no data; down() restores the prior threshold',
      };
    case 'alterRetentionPolicy':
      return {
        safety: 'online-safe',
        reason:
          're-schedules future chunk drops (remove-then-add of a background job) — deletes no data at apply; down() restores the prior threshold. ⚠️ SHORTENING drop_after means the next scheduler tick drops chunks that were previously retained (declared intent, but review the from→to direction)',
      };
    case 'renameHypertable':
      return {
        safety: 'online-safe',
        reason:
          'ALTER TABLE ... RENAME TO is a catalog-only metadata change — no data rewrite, no lock beyond the instant rename — and is cleanly reversible (down() renames back); TimescaleDB updates the hypertable/chunk/CAGG catalog automatically',
      };
    case 'setChunkInterval':
      return {
        safety: 'online-safe',
        reason:
          'set_chunk_time_interval affects only FUTURE chunks — existing chunks keep their size, no data is rewritten; down() restores the prior interval',
      };
    case 'alterColumnstoreConfig':
      return {
        safety: 'needs-recompress',
        reason:
          'the ALTER itself is online and applies to FUTURE chunks; EXISTING compressed chunks keep the old segmentby/orderby layout until manually decompressed + recompressed — no data loss; down() restores the prior config',
      };
    case 'removeRetentionPolicy':
      return {
        safety: 'online-safe',
        reason:
          'removes a retention background job — deletes no data (it stops FUTURE chunk drops, keeping more data); down() re-adds the policy at its prior threshold',
      };
    case 'removeCompressionPolicy':
      return {
        safety: 'online-safe',
        reason:
          'removes a compression background job — the columnstore stays enabled and existing chunks are untouched (only future auto-compression stops); down() re-adds the policy at its prior threshold',
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

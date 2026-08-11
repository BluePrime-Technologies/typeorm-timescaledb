import type { Operation } from './operation.js';
import { isShortening } from './normalize.js';

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
    case 'createContinuousAggregateRaw':
      // The reason string is printed verbatim to the user by formatPlanPreview, so it has to
      // describe what the step ACTUALLY does. Saying "reproducing an EXISTING continuous aggregate"
      // to someone creating a brand new one was simply false, and it is the sentence they use to
      // decide whether to run the plan.
      return (operation.intent ?? 'reproduce') === 'create'
        ? {
            safety: 'one-way',
            reason:
              'a continuous aggregate is created WITH NO DATA from a rendered definition — dropping it on down() discards only materialized (recomputable) rows, not source data',
          }
        : {
            safety: 'one-way',
            reason:
              'reproducing an EXISTING continuous aggregate is not reverted by down() — unlike a freshly created one, its materialized rows may be the only surviving copy of data whose source chunks a retention policy has already dropped, so down() raises a notice instead of dropping the view',
          };
    case 'decompressChunk':
      return {
        safety: 'needs-recompress',
        reason:
          'decompressing a chunk rewrites its storage and temporarily expands it to rowstore size — no data is lost and down() recompresses, but it is IO-heavy and must not run as a side effect of a schema change',
      };
    case 'compressChunk':
      return {
        safety: 'needs-recompress',
        reason:
          'recompressing a chunk rewrites its storage using the hypertable CURRENT columnstore settings — no data is lost and down() decompresses, but it is IO-heavy',
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
    case 'alterRetentionPolicy': {
      // SHORTENING drop_after is the one policy alter with a real data effect: the apply itself
      // deletes nothing, but the next scheduler tick drops chunks that were previously retained, and
      // `down()` cannot bring them back. That is not "online-safe" — it must be opted into, exactly
      // like any other irreversible data loss. Lengthening (or an unprovable comparison) keeps the
      // reversible classification.
      const shortening = isShortening(operation.from, operation.to);
      if (shortening === true) {
        return {
          safety: 'refuse-by-default',
          reason:
            `shortens drop_after (${operation.from} → ${operation.to}) — the apply deletes nothing, but the next ` +
            'retention run drops chunks that were previously retained and down() cannot restore them; ' +
            'opt in explicitly to accept the data loss',
        };
      }
      // LENGTHENING is safe to APPLY but its rollback is not, and the two must not be conflated.
      // `down()` restores `from`, i.e. the SHORTER threshold — so rolling back a 30d → 365d change
      // re-installs 30d on a hypertable that has since been retaining a year, and the next retention
      // run drops ~11 months of chunks. Classifying that `online-safe` meant neither the apply gate
      // nor the linter said a word about it. The builder now emits a non-destructive notice for
      // `down()` instead of restoring the shorter threshold; `one-way` is what tells the user that.
      //
      // An UNPROVABLE comparison (raw: quarantine, integer-time) lands here too, deliberately: a
      // comparison we cannot prove must not be reported as reversible when the cost of being wrong
      // is deleted data.
      return {
        safety: 'one-way',
        reason:
          shortening === false
            ? `lengthens drop_after (${operation.from} → ${operation.to}) — safe to apply and deletes no data, but ` +
              `it is NOT reversible: restoring the shorter ${operation.from} threshold would make every chunk ` +
              `retained since eligible for dropping, so down() emits a notice instead of reverting`
            : `changes drop_after (${operation.from} → ${operation.to}) — safe to apply, but the two thresholds ` +
              `cannot be compared (integer-time or unparseable), so reversibility cannot be proven and down() ` +
              `emits a notice instead of reverting`,
      };
    }
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
          'removes a retention background job — the APPLY deletes no data (it stops future chunk ' +
          'drops, keeping more). Note the revert: down() re-adds the policy at its prior threshold, ' +
          'and the next scheduler tick then drops every chunk accumulated while the policy was gone. ' +
          'That is faithful restoration of the prior state, not a defect, but it is asynchronous ' +
          'deletion an operator reverting a migration would not otherwise expect',
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

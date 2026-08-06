import type { Operation } from './operation.js';
import { canonicalizeInterval } from './normalize.js';

/**
 * `true` when a retention/compression threshold is being SHORTENED — the change that has a real data
 * effect. Comparable only when both sides canonicalize to a duration (a `raw:` quarantine or an
 * integer-time value returns `undefined`, in which case we cannot prove it is safe).
 */
function isShortening(from: string, to: string): boolean | undefined {
  const a = canonicalizeInterval(from);
  const b = canonicalizeInterval(to);
  if (a.startsWith('raw:') || b.startsWith('raw:')) return undefined;
  const us = (v: string): number | undefined => {
    const m = /^us:(-?\d+)$/.exec(v);
    return m ? Number(m[1]) : undefined;
  };
  const x = us(a);
  const y = us(b);
  if (x === undefined || y === undefined) return undefined;
  return y < x;
}

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
      return {
        safety: 'online-safe',
        reason:
          're-schedules future chunk drops (remove-then-add of a background job) — deletes no data at apply; down() restores the prior threshold. The threshold is not shortened, so no previously-retained chunk becomes eligible for dropping',
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

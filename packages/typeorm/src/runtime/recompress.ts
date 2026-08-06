import type { DataSource } from 'typeorm';
import {
  TimescaleError,
  TimescaleErrorCode,
  compileOperation,
  type Operation,
} from '@blueprime/timescaledb-core';

/**
 * The decompress → alter → recompress planner.
 *
 * ## The problem it solves
 *
 * `ALTER TABLE ... SET (timescaledb.segmentby = ...)` is online and applies to FUTURE chunks. Chunks
 * already compressed keep the OLD layout indefinitely. So `push --apply` reported success on a
 * change that had only half-applied — and worse, `check` then AGREED with the declaration, because
 * the catalog reports the new table-level setting while the chunks on disk do not match it. A silent
 * wrongness: the schema says one thing, the stored data another, and nothing surfaced the gap.
 *
 * ## Why the chunk list is computed, not assumed
 *
 * `_timescaledb_catalog.compression_settings` carries the settings each chunk was compressed WITH,
 * so stale chunks can be identified exactly rather than rewriting the whole hypertable. That matters:
 * recompressing every chunk of a large hypertable when three are stale is hours of pointless IO.
 *
 * **But the internal catalog differs across supported versions**, all verified empirically rather
 * than assumed:
 * - **2.18** — `compression_settings.relid` keys on the COMPRESSED chunk (`compress_hyper_*`).
 * - **2.28** — it keys on the USER-FACING chunk (`_hyper_*`).
 * - **2.28** — `_timescaledb_catalog.chunk` has no `dropped` column at all; 2.18 does.
 *
 * So the query is driven by `timescaledb_information.chunks` — a PUBLIC view, and the only part of
 * this with a compatibility promise — and reaches into the internal catalog solely for the settings
 * comparison, matching `relid` against both shapes. Filtering on the public view's `is_compressed`
 * also removes the need for the `dropped` column that 2.28 does not have.
 *
 * That still leaves an internal dependency, so the rule is: a shape this does not recognise must
 * NEVER be read as "nothing to do" — see {@link RecompressionPlan.precision}.
 */

/** One chunk the planner intends to rewrite. */
export interface StaleChunk {
  /** User-facing chunk, `schema.name` — what `decompress_chunk`/`compress_chunk` take. */
  readonly chunk: string;
  /** The segmentby the chunk was compressed with, when it could be determined. */
  readonly chunkSegmentBy?: readonly string[];
  /** The segmentby the hypertable now declares. */
  readonly desiredSegmentBy?: readonly string[];
}

/**
 * How confident the plan is about WHICH chunks need rewriting.
 *
 * - `exact` — per-chunk settings were read and compared; only genuinely stale chunks are listed.
 * - `unknown` — the settings catalog was unreadable or had an unrecognised shape, so EVERY compressed
 *   chunk is listed as a candidate. Deliberately not silent: reporting "no stale chunks" because the
 *   probe failed would be the exact false-green this planner exists to remove.
 */
export type RecompressionPrecision = 'exact' | 'unknown';

export interface RecompressionPlan {
  readonly table: string;
  readonly chunks: readonly StaleChunk[];
  readonly precision: RecompressionPrecision;
  /** Total compressed chunks on the hypertable, for context against `chunks.length`. */
  readonly compressedChunkCount: number;
  /** Present when `precision` is `unknown`: why the exact comparison could not be made. */
  readonly imprecisionReason?: string;
}

/** Per-chunk progress, so a long run is observable rather than a hang. */
export interface RecompressionProgress {
  readonly chunk: string;
  readonly index: number;
  readonly total: number;
  readonly phase: 'decompressed' | 'recompressed';
}

export interface ApplyRecompressionOptions {
  /**
   * Required, and there is no default.
   *
   * This rewrites chunk storage — it is IO-heavy, can take hours on a large hypertable, and must
   * never happen because someone ran a schema command. Making the caller pass it means the work is
   * always something they chose.
   */
  readonly confirm: true;
  readonly onProgress?: (progress: RecompressionProgress) => void;
}

export interface RecompressionResult {
  readonly table: string;
  readonly processed: readonly string[];
  /** Chunks that failed, with the error. The run CONTINUES past a failure — see `applyRecompression`. */
  readonly failed: readonly { readonly chunk: string; readonly error: string }[];
}

/** Rows the stale-chunk probe returns. `chunk_segmentby` is null when the join found no settings. */
interface StaleRow {
  chunk: string;
  chunk_segmentby: string[] | null;
  desired_segmentby: string[] | null;
}

/**
 * Matches BOTH catalog shapes (see the module doc). `compression_settings.relid` is joined against
 * the user-facing chunk AND its compressed twin, so whichever the running version uses, the row is
 * found. Chunks whose settings equal the hypertable's are excluded — those are already correct.
 */
const STALE_CHUNKS_SQL = `
  SELECT
    format('%I.%I', c.chunk_schema, c.chunk_name) AS chunk,
    cs.segmentby AS chunk_segmentby,
    (
      -- ($1::text)::regclass, not $1::regclass: a parameter gets ONE inferred type across the whole
      -- statement, so an unadorned $1::regclass here made the text comparison below resolve as
      -- text = regclass, which has no operator. The query threw and the planner fell back to
      -- 'unknown' — safe, but it silently gave up the precision this whole query exists for.
      SELECT d.segmentby FROM _timescaledb_catalog.compression_settings d
      WHERE d.relid = ($1::text)::regclass
    ) AS desired_segmentby
  FROM timescaledb_information.chunks c
  LEFT JOIN _timescaledb_catalog.chunk ich
    ON ich.schema_name = c.chunk_schema AND ich.table_name = c.chunk_name
  LEFT JOIN _timescaledb_catalog.chunk cch
    ON cch.id = ich.compressed_chunk_id
  LEFT JOIN _timescaledb_catalog.compression_settings cs
    ON cs.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
    OR (cch.id IS NOT NULL AND cs.relid = format('%I.%I', cch.schema_name, cch.table_name)::regclass)
  WHERE format('%I.%I', c.hypertable_schema, c.hypertable_name) = $1::text
    AND c.is_compressed
`;

const COMPRESSED_COUNT_SQL = `
  SELECT count(*)::int AS n
  FROM timescaledb_information.chunks
  WHERE format('%I.%I', hypertable_schema, hypertable_name) = $1 AND is_compressed
`;

const sameArray = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Work out which chunks of `table` were compressed under settings the hypertable no longer declares.
 * Read-only.
 *
 * @throws {TimescaleError} if the DataSource is not initialized.
 */
export async function planRecompression(
  dataSource: DataSource,
  table: string,
): Promise<RecompressionPlan> {
  if (!dataSource.isInitialized) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'DataSource must be initialized (await dataSource.initialize()) before planning recompression',
    );
  }
  const qualified = table.includes('.') ? table : `public.${table}`;

  const countRows: { n: number }[] = await dataSource.query(COMPRESSED_COUNT_SQL, [qualified]);
  const compressedChunkCount = countRows[0]?.n ?? 0;
  if (compressedChunkCount === 0) {
    return { table: qualified, chunks: [], precision: 'exact', compressedChunkCount: 0 };
  }

  let rows: StaleRow[];
  try {
    rows = await dataSource.query(STALE_CHUNKS_SQL, [qualified]);
  } catch (error) {
    // The internal catalog is not a public API. If it moves under us, EVERY compressed chunk becomes
    // a candidate — never "nothing to do".
    return {
      table: qualified,
      chunks: await allCompressedChunks(dataSource, qualified),
      precision: 'unknown',
      compressedChunkCount,
      imprecisionReason: `could not read _timescaledb_catalog.compression_settings (${
        error instanceof Error ? error.message : String(error)
      }); every compressed chunk is listed as a candidate`,
    };
  }

  // The probe ran but told us nothing about any chunk — an unrecognised shape, not an empty result.
  // Same rule: assume nothing is known rather than that nothing is stale.
  if (rows.length === 0 || rows.every((r) => r.chunk_segmentby === null)) {
    return {
      table: qualified,
      chunks: await allCompressedChunks(dataSource, qualified),
      precision: 'unknown',
      compressedChunkCount,
      imprecisionReason:
        'per-chunk compression settings were not resolvable on this TimescaleDB version; every compressed chunk is listed as a candidate',
    };
  }

  const chunks = rows
    .filter((r) => !sameArray(r.chunk_segmentby, r.desired_segmentby))
    .map(
      (r): StaleChunk => ({
        chunk: r.chunk,
        ...(r.chunk_segmentby !== null && { chunkSegmentBy: r.chunk_segmentby }),
        ...(r.desired_segmentby !== null && { desiredSegmentBy: r.desired_segmentby }),
      }),
    );

  return { table: qualified, chunks, precision: 'exact', compressedChunkCount };
}

async function allCompressedChunks(
  dataSource: DataSource,
  qualified: string,
): Promise<StaleChunk[]> {
  const rows: { chunk: string }[] = await dataSource.query(
    `SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
     FROM timescaledb_information.chunks
     WHERE format('%I.%I', hypertable_schema, hypertable_name) = $1 AND is_compressed
     ORDER BY 1`,
    [qualified],
  );
  return rows.map((r) => ({ chunk: r.chunk }));
}

/**
 * Rewrite each stale chunk: decompress, then recompress under the hypertable's current settings.
 *
 * **Resumable, and deliberately not one transaction.** Each chunk is processed independently, and
 * both primitives are idempotent (`if_compressed` / `if_not_compressed`), so an interrupted run is
 * re-run rather than restarted. Wrapping a multi-hour rewrite of an entire hypertable in one
 * transaction would hold locks and bloat WAL for the duration, and lose all progress on any failure.
 *
 * **A failing chunk does not abort the rest.** It is recorded in `failed` and the run continues —
 * one unrewritable chunk should not leave the other ninety-nine in the old layout. The caller gets
 * the full list and can act on it.
 *
 * All SQL goes through `compileOperation`, so these statements are built by the same choke point as
 * every other operation in the engine.
 */
export async function applyRecompression(
  dataSource: DataSource,
  plan: RecompressionPlan,
  options: ApplyRecompressionOptions,
): Promise<RecompressionResult> {
  if (options.confirm !== true) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'applyRecompression rewrites chunk storage and must be confirmed explicitly ({ confirm: true })',
    );
  }

  const processed: string[] = [];
  const failed: { chunk: string; error: string }[] = [];

  for (const [index, { chunk }] of plan.chunks.entries()) {
    const step = async (
      operation: Operation,
      phase: RecompressionProgress['phase'],
    ): Promise<void> => {
      for (const sql of compileOperation(operation).up) await dataSource.query(sql);
      options.onProgress?.({ chunk, index, total: plan.chunks.length, phase });
    };
    try {
      await step({ kind: 'decompressChunk', chunk }, 'decompressed');
      await step({ kind: 'compressChunk', chunk }, 'recompressed');
      processed.push(chunk);
    } catch (error) {
      failed.push({ chunk, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { table: plan.table, processed, failed };
}

/** Human-readable summary — the thing a CLI prints, kept out of the CLI so it is unit-testable. */
export function formatRecompressionPlan(plan: RecompressionPlan): string {
  if (plan.compressedChunkCount === 0) {
    return `${plan.table}: no compressed chunks — nothing to recompress.`;
  }
  if (plan.chunks.length === 0) {
    return `${plan.table}: all ${String(plan.compressedChunkCount)} compressed chunk(s) already match the declared columnstore settings.`;
  }
  const lines = [
    `${plan.table}: ${String(plan.chunks.length)} of ${String(plan.compressedChunkCount)} compressed chunk(s) need rewriting.`,
  ];
  if (plan.precision === 'unknown') {
    lines.push(
      `\n⚠  Could not determine which chunks are actually stale, so ALL of them are listed.`,
      `   Reason: ${plan.imprecisionReason ?? 'unknown'}`,
      `   Rewriting a chunk that was already correct is wasteful but not harmful.`,
    );
  }
  for (const c of plan.chunks.slice(0, 10)) {
    const from = c.chunkSegmentBy ? `[${c.chunkSegmentBy.join(', ')}]` : '?';
    const to = c.desiredSegmentBy ? `[${c.desiredSegmentBy.join(', ')}]` : '?';
    lines.push(`  - ${c.chunk}: segmentby ${from} → ${to}`);
  }
  if (plan.chunks.length > 10) {
    lines.push(`  … and ${String(plan.chunks.length - 10)} more`);
  }
  lines.push(
    `\nThis rewrites chunk storage: IO-heavy, and slow on a large hypertable. It is resumable —`,
    `re-running continues rather than starting over.`,
  );
  return lines.join('\n');
}

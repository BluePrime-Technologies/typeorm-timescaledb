import type { DataSource } from 'typeorm';
import {
  TimescaleError,
  TimescaleErrorCode,
  compileOperation,
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
  /** The orderby the chunk was compressed with. */
  readonly chunkOrderBy?: readonly string[];
  /** The orderby the hypertable now declares. */
  readonly desiredOrderBy?: readonly string[];
  /** Per-column DESC flags the chunk was compressed with. */
  readonly chunkOrderByDesc?: readonly boolean[];
  /** Per-column DESC flags the hypertable now declares. */
  readonly desiredOrderByDesc?: readonly boolean[];
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
  chunk_orderby: string[] | null;
  desired_orderby: string[] | null;
  // Direction lives in its OWN columns: `orderby` stores only the column names, so `ts DESC` and
  // `ts ASC` are BOTH `{ts}` there. Comparing `orderby` alone would have missed every direction
  // flip — the same blindness as ignoring orderby entirely, one level down.
  chunk_orderby_desc: boolean[] | null;
  desired_orderby_desc: boolean[] | null;
  chunk_orderby_nullsfirst: boolean[] | null;
  desired_orderby_nullsfirst: boolean[] | null;
}

/**
 * Matches BOTH catalog shapes (see the module doc). `compression_settings.relid` is joined against
 * the user-facing chunk AND its compressed twin, so whichever the running version uses, the row is
 * found. Chunks whose settings equal the hypertable's are excluded — those are already correct.
 */
const STALE_CHUNKS_SQL = `
  -- DISTINCT ON: on a version where compression_settings holds a row for BOTH the user-facing chunk
  -- and its compressed twin, the OR below matches twice and the chunk would be rewritten twice —
  -- double the IO and double the lock time, for nothing.
  --
  -- Schema and table are matched as SEPARATE parameters rather than through
  -- format('%I.%I', ...) = $1. format() quotes only identifiers that need it, so a hypertable named
  -- e.g. "My Table" rendered as "public"."My Table" and never equalled the plain 'public.My Table'
  -- the caller passed — the planner then reported "no compressed chunks" for a table full of them.
  SELECT DISTINCT ON (c.chunk_schema, c.chunk_name)
    format('%I.%I', c.chunk_schema, c.chunk_name) AS chunk,
    cs.segmentby          AS chunk_segmentby,
    cs.orderby            AS chunk_orderby,
    cs.orderby_desc       AS chunk_orderby_desc,
    cs.orderby_nullsfirst AS chunk_orderby_nullsfirst,
    d.segmentby           AS desired_segmentby,
    d.orderby             AS desired_orderby,
    d.orderby_desc        AS desired_orderby_desc,
    d.orderby_nullsfirst  AS desired_orderby_nullsfirst
  FROM timescaledb_information.chunks c
  LEFT JOIN _timescaledb_catalog.chunk ich
    ON ich.schema_name = c.chunk_schema AND ich.table_name = c.chunk_name
  LEFT JOIN _timescaledb_catalog.chunk cch
    ON cch.id = ich.compressed_chunk_id
  LEFT JOIN _timescaledb_catalog.compression_settings cs
    ON cs.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
    OR (cch.id IS NOT NULL AND cs.relid = format('%I.%I', cch.schema_name, cch.table_name)::regclass)
  LEFT JOIN _timescaledb_catalog.compression_settings d
    ON d.relid = format('%I.%I', c.hypertable_schema, c.hypertable_name)::regclass
  WHERE c.hypertable_schema = $1::text
    AND c.hypertable_name = $2::text
    AND c.is_compressed
  ORDER BY c.chunk_schema, c.chunk_name, cs.segmentby NULLS LAST
`;

const COMPRESSED_COUNT_SQL = `
  SELECT count(*)::int AS n
  FROM timescaledb_information.chunks
  WHERE hypertable_schema = $1::text AND hypertable_name = $2::text AND is_compressed
`;

/**
 * Facet equality. `null === null` is EQUAL: a hypertable may legitimately declare no orderby, and
 * treating "both absent" as a difference would report every such chunk as permanently stale.
 * `null` vs a value is NOT equal — that is a real difference, or an unreadable side, and both
 * deserve to be surfaced rather than assumed away.
 */
const sameArray = (a: readonly unknown[] | null, b: readonly unknown[] | null): boolean => {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

/**
 * Every facet the catalog records about a columnstore layout. Missing one is a silent false-green —
 * comparing only `segmentby` made an orderby change invisible, and comparing only `orderby` (which
 * stores column NAMES) would have missed every ASC/DESC flip, since direction lives in
 * `orderby_desc`.
 *
 * A facet whose DESIRED side is NULL is SKIPPED, not treated as a difference. The hypertable row
 * records only what was explicitly declared, while each chunk records the EFFECTIVE settings the
 * engine expanded them into — verified on 2.28, where a table declaring just `segmentby` has NULL
 * orderby while its chunks carry the auto-filled `{ts}/{t}/{t}`. Comparing those directly reported
 * every chunk as stale forever. "Undeclared" means "accept the engine's choice", which is the same
 * rule the hypertable diff applies via TIMESCALE_DEFAULTS.
 */
const FACETS = [
  ['chunk_segmentby', 'desired_segmentby'],
  ['chunk_orderby', 'desired_orderby'],
  ['chunk_orderby_desc', 'desired_orderby_desc'],
  ['chunk_orderby_nullsfirst', 'desired_orderby_nullsfirst'],
] as const;

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
  const dot = qualified.indexOf('.');
  const params = [qualified.slice(0, dot), qualified.slice(dot + 1)];

  const countRows: { n: number }[] = await dataSource.query(COMPRESSED_COUNT_SQL, params);
  const compressedChunkCount = countRows[0]?.n ?? 0;
  if (compressedChunkCount === 0) {
    return { table: qualified, chunks: [], precision: 'exact', compressedChunkCount: 0 };
  }

  let rows: StaleRow[];
  try {
    rows = await dataSource.query(STALE_CHUNKS_SQL, params);
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

  // The probe ran but could not resolve BOTH sides of the comparison. Either half being unreadable
  // makes the verdict meaningless, and the failure modes differ:
  //   - chunk_segmentby unresolved   -> a chunk is compared against nothing;
  //   - desired_segmentby unresolved -> EVERY chunk compares unequal, so all are reported stale at
  //     precision 'exact'. That is the dangerous one: it never converges, so every run confidently
  //     rewrites the whole hypertable again, forever.
  // A PARTIAL resolution is not trustworthy either, so any unresolved row degrades the whole plan
  // rather than silently mixing verified and unverified verdicts.
  const unresolved =
    rows.length === 0 ||
    rows.some((r) => r.chunk_segmentby === null) ||
    rows.some((r) => r.desired_segmentby === null);
  if (unresolved) {
    return {
      table: qualified,
      chunks: await allCompressedChunks(dataSource, qualified),
      precision: 'unknown',
      compressedChunkCount,
      imprecisionReason:
        'per-chunk compression settings were not resolvable on this TimescaleDB version; every compressed chunk is listed as a candidate',
    };
  }

  // BOTH facets. Comparing only segmentby made an orderby-only change completely invisible: the
  // planner reported "already match" while every chunk on disk was stale — the precise false-green
  // this planner exists to remove, inside the planner that removes it. `compression_settings` has
  // carried `orderby` all along; it simply was not read.
  const chunks = rows
    .filter((r) =>
      FACETS.some(([c, d]) => {
        const desired = r[d] ?? null;
        if (desired === null) return false; // undeclared -> the engine's default is accepted
        return !sameArray(r[c] ?? null, desired);
      }),
    )
    .map(
      (r): StaleChunk => ({
        chunk: r.chunk,
        ...(r.chunk_segmentby !== null && { chunkSegmentBy: r.chunk_segmentby }),
        ...(r.desired_segmentby !== null && { desiredSegmentBy: r.desired_segmentby }),
        ...(r.chunk_orderby !== null && { chunkOrderBy: r.chunk_orderby }),
        ...(r.desired_orderby !== null && { desiredOrderBy: r.desired_orderby }),
        ...(r.chunk_orderby_desc !== null && { chunkOrderByDesc: r.chunk_orderby_desc }),
        ...(r.desired_orderby_desc !== null && { desiredOrderByDesc: r.desired_orderby_desc }),
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
    // ONE TRANSACTION PER CHUNK — the difference between resumable and data-stranding.
    //
    // Without it, a crash between the decompress and the compress left the chunk in rowstore. And
    // because the planner only looks at chunks WHERE is_compressed, it would never be seen again:
    // the chunk stayed uncompressed permanently, silently bloating the table, and re-running (the
    // documented recovery) did not help because the planner could no longer see it. Calling that
    // pass "resumable" was wrong for precisely the failure resumability exists to cover.
    //
    // Verified on 2.18 and 2.28: decompress_chunk and compress_chunk both run inside a transaction,
    // and ROLLBACK genuinely restores the compressed state (chunk count unchanged after an aborted
    // decompress). A killed process now leaves the chunk exactly as it was.
    //
    // Per CHUNK, not one transaction for the run: a multi-hour rewrite in a single transaction would
    // hold locks and bloat WAL throughout, and lose all progress on any failure.
    const runner = dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      const steps = [
        { operation: { kind: 'decompressChunk' as const, chunk }, phase: 'decompressed' as const },
        { operation: { kind: 'compressChunk' as const, chunk }, phase: 'recompressed' as const },
      ];
      for (const { operation, phase } of steps) {
        for (const sql of compileOperation(operation).up) await runner.query(sql);
        options.onProgress?.({ chunk, index, total: plan.chunks.length, phase });
      }
      await runner.commitTransaction();
      processed.push(chunk);
    } catch (error) {
      // Roll back so the chunk returns to its pre-run state rather than being stranded in rowstore.
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      failed.push({ chunk, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await runner.release();
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
    const fmt = (v: readonly string[] | undefined): string => (v ? `[${v.join(', ')}]` : '?');
    const facets: string[] = [];
    if (c.desiredSegmentBy && !sameArray(c.chunkSegmentBy ?? null, c.desiredSegmentBy)) {
      facets.push(`segmentby ${fmt(c.chunkSegmentBy)} → ${fmt(c.desiredSegmentBy)}`);
    }
    const withDir = (
      cols: readonly string[] | undefined,
      desc: readonly boolean[] | undefined,
    ): string =>
      cols ? `[${cols.map((n, i) => `${n} ${desc?.[i] ? 'DESC' : 'ASC'}`).join(', ')}]` : '?';
    if (
      (c.desiredOrderBy && !sameArray(c.chunkOrderBy ?? null, c.desiredOrderBy)) ||
      (c.desiredOrderByDesc && !sameArray(c.chunkOrderByDesc ?? null, c.desiredOrderByDesc))
    ) {
      facets.push(
        `orderby ${withDir(c.chunkOrderBy, c.chunkOrderByDesc)} → ${withDir(c.desiredOrderBy, c.desiredOrderByDesc)}`,
      );
    }
    lines.push(`  - ${c.chunk}: ${facets.length > 0 ? facets.join('; ') : 'stale'}`);
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

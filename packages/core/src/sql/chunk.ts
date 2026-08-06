import { quoteLiteral } from '../literal.js';
import { parseTable, type MigrationStatement } from './hypertable.js';

/**
 * Per-chunk columnstore (compression) primitives — the pieces the recompression planner drives.
 *
 * Empirically verified on TimescaleDB **2.18.0** and **2.28.1**: `compress_chunk(regclass)` and
 * `decompress_chunk(regclass)` are FUNCTIONS on both and can be called from `SELECT`. The newer
 * `convert_to_columnstore` / `convert_to_rowstore` names are **procedures**, so they need `CALL` and
 * do not exist on 2.18 — using them would have split the code path across versions for no gain.
 */

/** A chunk to compress or decompress, as `schema.name`. */
export interface ChunkInput {
  /** The USER-FACING chunk (e.g. `_timescaledb_internal._hyper_1_1_chunk`), not its compressed twin. */
  readonly chunk: string;
}

/**
 * `SELECT decompress_chunk(<chunk>, if_compressed => TRUE)`.
 *
 * `if_compressed => TRUE` makes it a no-op on an already-decompressed chunk rather than an error.
 * That is what makes the recompression pass RESUMABLE: an interrupted run can simply be re-run, and
 * chunks it already processed are skipped instead of aborting the whole thing. Recompressing a large
 * hypertable takes long enough that "start over on any failure" is not a real option.
 *
 * `down` recompresses — the inverse, not a notice: this operation is genuinely reversible, and the
 * chunk's rows are never at risk (decompress and compress are both lossless representations of the
 * same data).
 */
export function decompressChunkSQL(input: ChunkInput): MigrationStatement {
  const chunk = parseTable(input.chunk);
  return {
    up: [`SELECT decompress_chunk(${quoteLiteral(chunk.ident)}::regclass, if_compressed => TRUE);`],
    down: [
      `SELECT compress_chunk(${quoteLiteral(chunk.ident)}::regclass, if_not_compressed => TRUE);`,
    ],
    inspect:
      `SELECT is_compressed FROM timescaledb_information.chunks ` +
      `WHERE format('%I.%I', chunk_schema, chunk_name) = ${quoteLiteral(chunk.ident)};`,
  };
}

/**
 * `SELECT compress_chunk(<chunk>, if_not_compressed => TRUE)`.
 *
 * Recompression uses the hypertable's CURRENT columnstore settings, which is the whole mechanism
 * behind applying a changed segmentby/orderby to chunks written before the change.
 *
 * `down` decompresses. Note this is the inverse of {@link decompressChunkSQL} and equally lossless.
 */
export function compressChunkSQL(input: ChunkInput): MigrationStatement {
  const chunk = parseTable(input.chunk);
  return {
    up: [
      `SELECT compress_chunk(${quoteLiteral(chunk.ident)}::regclass, if_not_compressed => TRUE);`,
    ],
    down: [
      `SELECT decompress_chunk(${quoteLiteral(chunk.ident)}::regclass, if_compressed => TRUE);`,
    ],
    inspect:
      `SELECT is_compressed FROM timescaledb_information.chunks ` +
      `WHERE format('%I.%I', chunk_schema, chunk_name) = ${quoteLiteral(chunk.ident)};`,
  };
}

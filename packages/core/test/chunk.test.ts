import { describe, expect, it } from 'vitest';
import {
  classifyOperation,
  compileOperation,
  compressChunkSQL,
  decompressChunkSQL,
} from '../src/index.js';

const CHUNK = '_timescaledb_internal._hyper_1_1_chunk';

describe('chunk compress/decompress builders', () => {
  it('emits idempotent SQL — which is what makes a long run RESUMABLE', () => {
    // Without if_compressed/if_not_compressed an interrupted rewrite could not simply be re-run:
    // the first already-processed chunk would error and abort. Recompressing a large hypertable
    // takes long enough that "start over on any failure" is not a real option.
    expect(decompressChunkSQL({ chunk: CHUNK }).up[0]).toContain('if_compressed => TRUE');
    expect(compressChunkSQL({ chunk: CHUNK }).up[0]).toContain('if_not_compressed => TRUE');
  });

  it('uses compress_chunk/decompress_chunk, which exist on BOTH supported versions', () => {
    // convert_to_columnstore/convert_to_rowstore are PROCEDURES (need CALL) and absent on 2.18 —
    // verified on live containers. Using them would have split the code path for no gain.
    expect(compressChunkSQL({ chunk: CHUNK }).up[0]).toMatch(/SELECT compress_chunk\(/);
    expect(decompressChunkSQL({ chunk: CHUNK }).up[0]).toMatch(/SELECT decompress_chunk\(/);
    expect(compressChunkSQL({ chunk: CHUNK }).up.join()).not.toMatch(/convert_to_/);
  });

  it('is exactly reversible — the two are inverses, and neither loses data', () => {
    const d = decompressChunkSQL({ chunk: CHUNK });
    const c = compressChunkSQL({ chunk: CHUNK });
    expect(d.down).toEqual(c.up);
    expect(c.down).toEqual(d.up);
    // No notice-instead-of-inverse here: unlike a hypertable conversion, this genuinely reverses.
    expect(d.down.join()).not.toMatch(/notice|cannot/i);
  });

  it('quotes the chunk identifier rather than interpolating it raw', () => {
    const sql = compressChunkSQL({ chunk: CHUNK }).up[0] ?? '';
    expect(sql).toContain(`'"_timescaledb_internal"."_hyper_1_1_chunk"'::regclass`);
  });

  it('routes through compileOperation like every other operation', () => {
    expect(compileOperation({ kind: 'compressChunk', chunk: CHUNK }).up).toEqual(
      compressChunkSQL({ chunk: CHUNK }).up,
    );
    expect(compileOperation({ kind: 'decompressChunk', chunk: CHUNK }).up).toEqual(
      decompressChunkSQL({ chunk: CHUNK }).up,
    );
  });

  it('classifies both as needs-recompress, never online-safe', () => {
    // These rewrite chunk storage. Classifying either as online-safe would let the apply gate run
    // them as though they were free.
    for (const kind of ['compressChunk', 'decompressChunk'] as const) {
      const c = classifyOperation({ kind, chunk: CHUNK });
      expect(c.safety).toBe('needs-recompress');
      expect(c.reason).toMatch(/IO-heavy/);
      expect(c.reason).toMatch(/no data is lost/);
    }
  });
});

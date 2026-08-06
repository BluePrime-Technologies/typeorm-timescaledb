import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { formatRecompressionPlan, planRecompression } from '../src/index.js';

/**
 * The degradation path, which a live database cannot reach.
 *
 * `planRecompression` reads `_timescaledb_catalog` — an INTERNAL catalog whose shape already differs
 * between the two supported versions (2.18 keys settings by the compressed chunk, 2.28 by the
 * user-facing one; 2.28 has no `dropped` column at all). When a future version moves it again, the
 * probe will fail — and the ONE thing it must not then do is report "no stale chunks", because that
 * is indistinguishable from a genuinely clean database.
 *
 * On a healthy container the probe always succeeds, so this behaviour is unreachable in the
 * integration test — verified: deleting the guard left all 8 of those green. Hence stubs.
 */
function stubDs(handler: (sql: string) => unknown[]): DataSource {
  return {
    isInitialized: true,
    query: async (sql: string) => handler(sql),
  } as unknown as DataSource;
}

const COMPRESSED = [{ n: 3 }];
const CHUNK_ROWS = [
  { chunk: 'a', chunk_segmentby: ['dev'], desired_segmentby: ['v'] },
  { chunk: 'b', chunk_segmentby: ['v'], desired_segmentby: ['v'] },
];

describe('planRecompression — degrading safely when the catalog cannot be read', () => {
  it('reports UNKNOWN, listing every compressed chunk, when the probe throws', async () => {
    const ds = stubDs((sql) => {
      if (sql.includes('count(*)')) return COMPRESSED;
      if (sql.includes('compression_settings')) throw new Error('relation does not exist');
      return [{ chunk: 'a' }, { chunk: 'b' }, { chunk: 'c' }];
    });
    const plan = await planRecompression(ds, 'm');
    expect(plan.precision).toBe('unknown');
    expect(plan.chunks).toHaveLength(3); // ALL of them, not none
    expect(plan.imprecisionReason).toMatch(/relation does not exist/);
  });

  it('reports UNKNOWN when the probe returns rows it cannot interpret', async () => {
    // The subtler failure: the query runs, but the join resolves nothing — which is what a changed
    // catalog shape looks like. Treating that as "no chunk is stale" is the false green.
    const ds = stubDs((sql) => {
      if (sql.includes('count(*)')) return COMPRESSED;
      if (sql.includes('compression_settings'))
        return [{ chunk: 'a', chunk_segmentby: null, desired_segmentby: null }];
      return [{ chunk: 'a' }, { chunk: 'b' }, { chunk: 'c' }];
    });
    const plan = await planRecompression(ds, 'm');
    expect(plan.precision).toBe('unknown');
    expect(plan.chunks).toHaveLength(3);
    expect(plan.imprecisionReason).toMatch(/not resolvable/);
  });

  it('says so LOUDLY in the formatted output, not just in a field', () => {
    const text = formatRecompressionPlan({
      table: 'public.m',
      chunks: [{ chunk: 'a' }],
      precision: 'unknown',
      compressedChunkCount: 3,
      imprecisionReason: 'catalog moved',
    });
    expect(text).toMatch(/Could not determine which chunks are actually stale/);
    expect(text).toMatch(/catalog moved/);
    // ...and it is honest that over-doing the work is the safe direction.
    expect(text).toMatch(/wasteful but not harmful/);
  });

  it('still compares exactly when the probe DOES resolve', async () => {
    const ds = stubDs((sql) => {
      if (sql.includes('count(*)')) return COMPRESSED;
      if (sql.includes('compression_settings')) return CHUNK_ROWS;
      return [];
    });
    const plan = await planRecompression(ds, 'm');
    expect(plan.precision).toBe('exact');
    // Only the chunk whose settings differ — 'b' already matches and must not be rewritten.
    expect(plan.chunks.map((c) => c.chunk)).toEqual(['a']);
  });

  it('short-circuits with no compressed chunks, without touching the internal catalog', async () => {
    let probed = false;
    const ds = stubDs((sql) => {
      if (sql.includes('count(*)')) return [{ n: 0 }];
      probed = true;
      return [];
    });
    const plan = await planRecompression(ds, 'm');
    expect(plan.chunks).toEqual([]);
    expect(plan.precision).toBe('exact'); // genuinely clean, not a degraded guess
    expect(probed).toBe(false);
  });

  it('refuses an uninitialized DataSource', async () => {
    const ds = { isInitialized: false } as unknown as DataSource;
    await expect(planRecompression(ds, 'm')).rejects.toThrow(/must be initialized/);
  });

  it('qualifies a bare table name with public, matching how chunks are reported', async () => {
    let seen = '';
    const ds = {
      isInitialized: true,
      query: async (sql: string, params: unknown[]) => {
        seen = String(params[0]);
        return sql.includes('count(*)') ? [{ n: 0 }] : [];
      },
    } as unknown as DataSource;
    await planRecompression(ds, 'm');
    expect(seen).toBe('public.m');
  });
});

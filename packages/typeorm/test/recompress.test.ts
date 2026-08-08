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
/** Every facet column the query selects — a stub missing one would read as a spurious difference. */
const facets = (
  chunkSeg: string[] | null,
  desiredSeg: string[] | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  chunk_segmentby: chunkSeg,
  desired_segmentby: desiredSeg,
  chunk_orderby: null,
  desired_orderby: null,
  chunk_orderby_desc: null,
  desired_orderby_desc: null,
  chunk_orderby_nullsfirst: null,
  desired_orderby_nullsfirst: null,
  ...over,
});

const CHUNK_ROWS = [
  { chunk: 'a', ...facets(['dev'], ['v']) },
  { chunk: 'b', ...facets(['v'], ['v']) },
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
      if (sql.includes('compression_settings')) return [{ chunk: 'a', ...facets(null, null) }];
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

  it('reports UNKNOWN when the DESIRED side is unresolved, not confident-stale', async () => {
    // Found by review, and the mutation pass showed it was unpinned. If the hypertable's own
    // settings row cannot be read while the per-chunk rows CAN, every chunk compares unequal — so
    // the planner would report all of them stale at precision 'exact'. That never converges: each
    // run confidently rewrites the entire hypertable, forever.
    const ds = stubDs((sql) => {
      if (sql.includes('count(*)')) return COMPRESSED;
      if (sql.includes('compression_settings')) return [{ chunk: 'a', ...facets(['dev'], null) }];
      return [{ chunk: 'a' }, { chunk: 'b' }, { chunk: 'c' }];
    });
    const plan = await planRecompression(ds, 'm');
    expect(plan.precision).toBe('unknown');
    expect(plan.chunks).toHaveLength(3);
  });

  it('reports UNKNOWN on a PARTIAL resolution rather than mixing verified and unverified', async () => {
    // Some rows resolve, some do not. Trusting the resolved ones and silently accepting the rest
    // would produce a verdict that is part measurement and part guess, labelled 'exact'.
    const ds = stubDs((sql) => {
      if (sql.includes('count(*)')) return COMPRESSED;
      if (sql.includes('compression_settings'))
        return [
          { chunk: 'a', ...facets(['dev'], ['v']) },
          { chunk: 'b', ...facets(null, ['v']) },
        ];
      return [{ chunk: 'a' }, { chunk: 'b' }, { chunk: 'c' }];
    });
    const plan = await planRecompression(ds, 'm');
    expect(plan.precision).toBe('unknown');
    expect(plan.chunks).toHaveLength(3);
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

  it('splits a bare table name into (public, name) rather than formatting a qualified string', () => {
    // Passed as two parameters on purpose: matching via format('%I.%I', …) = $1 quoted only names
    // that needed it, so a table called "My Table" never matched and reported zero chunks.
    let seen: unknown[] = [];
    const ds = {
      isInitialized: true,
      query: async (sql: string, params: unknown[]) => {
        seen = params;
        return sql.includes('count(*)') ? [{ n: 0 }] : [];
      },
    } as unknown as DataSource;
    return planRecompression(ds, 'm').then(() => {
      expect(seen).toEqual(['public', 'm']);
    });
  });

  it('splits a name that itself contains characters needing quoting', () => {
    let seen: unknown[] = [];
    const ds = {
      isInitialized: true,
      query: async (sql: string, params: unknown[]) => {
        seen = params;
        return sql.includes('count(*)') ? [{ n: 0 }] : [];
      },
    } as unknown as DataSource;
    return planRecompression(ds, 'public.My Table').then(() => {
      expect(seen).toEqual(['public', 'My Table']);
    });
  });
});

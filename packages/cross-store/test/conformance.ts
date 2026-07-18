import { describe, expect, it } from 'vitest';
import type { CrossStoreAdapter, SnapshotRow } from '../src/index.js';

/**
 * The fixture a conformance run needs. A caller (unit test with the fake adapter, or an
 * integration test with a real adapter) provides a healthy adapter whose store contains exactly
 * `seeded` rows, plus a `brokenAdapter` guaranteed to fail — so the same contract is asserted
 * against every adapter implementation.
 */
export interface ConformanceContext {
  readonly adapter: CrossStoreAdapter;
  readonly table: string;
  readonly column: string;
  /** Rows present in the store; the first three are used for batching/scope assertions. */
  readonly seeded: readonly SnapshotRow[];
  /** An adapter whose `findMany` is guaranteed to reject (e.g. a closed connection). */
  readonly brokenAdapter: CrossStoreAdapter;
  /** A scope column present on `seeded` rows, if the fixture supports scope filtering. */
  readonly scopeColumn?: string;
  /**
   * An id that is **type-valid for the key column** but absent from the store. Must be provided
   * for typed columns (e.g. a valid-but-unused uuid); defaults to a text sentinel otherwise.
   */
  readonly missingId?: unknown;
}

/**
 * The adapter contract every {@link CrossStoreAdapter} must satisfy. Asserts batching (one call
 * returns all matching rows), full-snapshot return, empty-id short-circuit, scope filtering, and —
 * the critical availability contract (issue #124 fix #5) — that an unreachable store **throws**
 * rather than returning `[]`/a truncated set (which the engine would misread as `not_found`).
 */
export function runAdapterConformance(
  label: string,
  makeContext: () => Promise<ConformanceContext>,
): void {
  describe(`CrossStoreAdapter conformance: ${label}`, () => {
    it('returns every matching row for a batch of ids in one call', async () => {
      const ctx = await makeContext();
      const ids = ctx.seeded.map((r) => r[ctx.column]);
      const rows = await ctx.adapter.findMany({ table: ctx.table, column: ctx.column, ids });
      expect(rows).toHaveLength(ctx.seeded.length);
      const got = rows.map((r) => String(r[ctx.column])).sort();
      const want = ids.map(String).sort();
      expect(got).toEqual(want);
    });

    it('returns a snapshot row carrying at least the seeded fields (not just the key)', async () => {
      const ctx = await makeContext();
      const first = ctx.seeded[0]!;
      const rows = await ctx.adapter.findMany({
        table: ctx.table,
        column: ctx.column,
        ids: [first[ctx.column]],
      });
      expect(rows).toHaveLength(1);
      // every seeded field on the first row is present in the returned snapshot (the adapter may
      // return more columns — SELECT * — but never fewer)
      for (const key of Object.keys(first)) {
        expect(String(rows[0]![key])).toBe(String(first[key]));
      }
    });

    it('returns [] for an id that does not exist (absence, not error)', async () => {
      const ctx = await makeContext();
      const rows = await ctx.adapter.findMany({
        table: ctx.table,
        column: ctx.column,
        ids: [ctx.missingId ?? '__definitely_missing__'],
      });
      expect(rows).toEqual([]);
    });

    it('returns [] for an empty id set without hitting the store', async () => {
      const ctx = await makeContext();
      const rows = await ctx.adapter.findMany({ table: ctx.table, column: ctx.column, ids: [] });
      expect(rows).toEqual([]);
    });

    it('filters by scope: returns exactly the in-scope rows and EXCLUDES out-of-scope ones', async () => {
      const ctx = await makeContext();
      if (!ctx.scopeColumn) return; // fixture opted out of scope
      const scopeCol = ctx.scopeColumn;
      const target = String(ctx.seeded[0]![scopeCol]);
      // the exact set of seeded ids that belong to the target scope
      const expected = ctx.seeded
        .filter((r) => String(r[scopeCol]) === target)
        .map((r) => String(r[ctx.column]))
        .sort();
      const outOfScope = ctx.seeded.filter((r) => String(r[scopeCol]) !== target);
      const rows = await ctx.adapter.findMany({
        table: ctx.table,
        column: ctx.column,
        ids: ctx.seeded.map((r) => r[ctx.column]),
        scope: { [scopeCol]: ctx.seeded[0]![scopeCol] },
      });
      const got = rows.map((r) => String(r[ctx.column])).sort();
      // exact subset — proves the scope filter both includes in-scope AND excludes out-of-scope
      expect(got).toEqual(expected);
      // guard against a fixture that can't detect a no-op filter (needs an out-of-scope row)
      expect(outOfScope.length).toBeGreaterThan(0);
      for (const r of outOfScope) expect(got).not.toContain(String(r[ctx.column]));
    });

    it('THROWS when the store is unreachable — never returns [] (availability != absence)', async () => {
      const ctx = await makeContext();
      await expect(
        ctx.brokenAdapter.findMany({ table: ctx.table, column: ctx.column, ids: ['a'] }),
      ).rejects.toThrow();
    });
  });
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrossStoreAdapter, SnapshotRow } from '../../src/types.js';

/**
 * What a concrete `CrossStoreAdapter` implementation must provide to run the shared
 * conformance suite below. `table`/`column`/`scopeColumn` are fixed for the fixture's
 * lifetime so every test can seed and query against the same target without re-declaring it.
 */
export interface AdapterConformanceFixture {
  readonly adapter: CrossStoreAdapter;
  readonly table: string;
  readonly column: string;
  readonly scopeColumn: string;
  /** Insert/seed rows the adapter's `findMany` should be able to fetch. */
  seed(rows: SnapshotRow[]): Promise<void>;
  /** Round-trips the underlying store actually executed since `setup()` (or the last reset). */
  roundTripCount(): number;
  /** Make the NEXT `findMany` call fail the way a real connection drop would (reject, not a truncated result). */
  breakNextRoundTrip(): void;
}

/**
 * The adapter-conformance suite every {@link CrossStoreAdapter} implementation must pass —
 * addresses the M3.2 red-team's deferred all-or-throw item. Reused, unchanged, by
 * `DataSourceAdapter` (this slice, `../typeorm/data-source-adapter.test.ts`) and the Prisma
 * adapter (M3.3b): the assertions are identical regardless of which ORM/driver sits
 * underneath, because they describe the {@link CrossStoreAdapter} *contract*, not any one
 * implementation.
 */
export function defineAdapterConformanceSuite(
  label: string,
  setup: () => Promise<AdapterConformanceFixture>,
  teardown?: (fixture: AdapterConformanceFixture) => Promise<void>,
): void {
  describe(`CrossStoreAdapter conformance — ${label}`, () => {
    let fixture: AdapterConformanceFixture;

    beforeEach(async () => {
      fixture = await setup();
    });

    afterEach(async () => {
      await teardown?.(fixture);
    });

    it('performs exactly one round-trip for a batch of ids', async () => {
      await fixture.seed([
        { [fixture.column]: 'a' },
        { [fixture.column]: 'b' },
        { [fixture.column]: 'c' },
      ]);
      await fixture.adapter.findMany({
        table: fixture.table,
        column: fixture.column,
        ids: ['a', 'b', 'c'],
      });
      expect(fixture.roundTripCount()).toBe(1);
    });

    it('returns rows matching only the requested ids', async () => {
      await fixture.seed([{ [fixture.column]: 'a' }, { [fixture.column]: 'b' }]);
      const rows = await fixture.adapter.findMany({
        table: fixture.table,
        column: fixture.column,
        ids: ['a'],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[fixture.column]).toBe('a');
    });

    it('respects a scope filter', async () => {
      await fixture.seed([
        { [fixture.column]: 'a', [fixture.scopeColumn]: 'w1' },
        { [fixture.column]: 'a', [fixture.scopeColumn]: 'w2' },
      ]);
      const rows = await fixture.adapter.findMany({
        table: fixture.table,
        column: fixture.column,
        ids: ['a'],
        scope: { [fixture.scopeColumn]: 'w1' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[fixture.scopeColumn]).toBe('w1');
    });

    it('throws — never returns a truncated result — when the store is unavailable', async () => {
      await fixture.seed([{ [fixture.column]: 'a' }]);
      fixture.breakNextRoundTrip();
      await expect(
        fixture.adapter.findMany({ table: fixture.table, column: fixture.column, ids: ['a'] }),
      ).rejects.toThrow();
    });
  });
}

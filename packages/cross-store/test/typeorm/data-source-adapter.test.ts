import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { DataSourceAdapter } from '../../src/typeorm/data-source-adapter.js';
import type { SnapshotRow } from '../../src/types.js';
import { defineAdapterConformanceSuite } from '../support/adapter-conformance.js';

const TABLE = 'canonical_records';
const COLUMN = 'id';
const SCOPE_COLUMN = 'workspace_id';

/**
 * A fake `DataSource` for a fast, no-DB unit test: `.query` never parses the SQL text (that is
 * independently covered by `sql.test.ts`) — it interprets `params` by the shape
 * `buildFindManySql` is known to produce (`params[0]` = the id array, `params[1]` = the sole
 * scope value, when present), and filters an in-memory row set. This proves `DataSourceAdapter`
 * forwards to `dataSource.query` correctly and surfaces its result/failure faithfully, while a
 * real Postgres/TimescaleDB engine proves the SQL itself works in the two-DataSource
 * integration test.
 */
function fakeDataSource(rows: SnapshotRow[]): {
  dataSource: DataSource;
  calls: Array<{ sql: string; params: unknown[] }>;
  breakNext(): void;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let breakNext = false;

  const query = (sql: string, params: unknown[] = []): Promise<SnapshotRow[]> => {
    calls.push({ sql, params });
    if (breakNext) {
      breakNext = false;
      return Promise.reject(new Error('connection refused'));
    }
    const ids = new Set((params[0] as unknown[]).map((v) => String(v)));
    const scopeValue = params[1];
    const matched = rows.filter((row) => {
      if (!ids.has(String(row[COLUMN]))) return false;
      if (scopeValue !== undefined && String(row[SCOPE_COLUMN]) !== String(scopeValue)) {
        return false;
      }
      return true;
    });
    return Promise.resolve(matched);
  };

  return {
    dataSource: { query } as unknown as DataSource,
    calls,
    breakNext(): void {
      breakNext = true;
    },
  };
}

describe('DataSourceAdapter', () => {
  it('exposes the configured store name', () => {
    const { dataSource } = fakeDataSource([]);
    const adapter = new DataSourceAdapter({ store: 'canonical', dataSource });
    expect(adapter.store).toBe('canonical');
  });

  it('short-circuits an empty id batch without a round-trip', async () => {
    const { dataSource, calls } = fakeDataSource([{ id: 'a' }]);
    const adapter = new DataSourceAdapter({ store: 'canonical', dataSource });
    const rows = await adapter.findMany({ table: TABLE, column: COLUMN, ids: [] });
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('runs the built SQL through dataSource.query with bound params', async () => {
    const { dataSource, calls } = fakeDataSource([{ id: 'a' }]);
    const adapter = new DataSourceAdapter({ store: 'canonical', dataSource });
    await adapter.findMany({ table: TABLE, column: COLUMN, ids: ['a'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe('SELECT * FROM "canonical_records" WHERE "id" = ANY($1)');
    expect(calls[0]?.params).toEqual([['a']]);
  });

  it('propagates a connection failure as a rejected promise (mapped by the engine to ADAPTER_UNAVAILABLE)', async () => {
    const { dataSource, breakNext } = fakeDataSource([{ id: 'a' }]);
    const adapter = new DataSourceAdapter({ store: 'canonical', dataSource });
    breakNext();
    await expect(adapter.findMany({ table: TABLE, column: COLUMN, ids: ['a'] })).rejects.toThrow(
      'connection refused',
    );
  });
});

defineAdapterConformanceSuite('DataSourceAdapter (fake DataSource)', async () => {
  const rows: SnapshotRow[] = [];
  const { dataSource, calls, breakNext } = fakeDataSource(rows);
  const adapter = new DataSourceAdapter({ store: 'canonical', dataSource });
  return {
    adapter,
    table: TABLE,
    column: COLUMN,
    scopeColumn: SCOPE_COLUMN,
    async seed(seedRows: SnapshotRow[]): Promise<void> {
      rows.push(...seedRows);
    },
    roundTripCount(): number {
      return calls.length;
    },
    breakNextRoundTrip(): void {
      breakNext();
    },
  };
});

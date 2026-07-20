import { describe, expect, it } from 'vitest';
import { DataSourceAdapter, type SqlRunner } from '../src/typeorm.js';
import type { SnapshotRow } from '../src/index.js';

/** A fake SqlRunner recording queries — mirrors what TypeORM's DataSource.query returns (a row array). */
class FakeRunner implements SqlRunner {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  constructor(private readonly result: unknown) {}
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ sql, params: parameters });
    return Promise.resolve(this.result);
  }
}

describe('DataSourceAdapter', () => {
  it('runs the native index-friendly ANY($1) query with ids bound as $1', async () => {
    const runner = new FakeRunner([{ id: 'a', v: 1 }] as SnapshotRow[]);
    const adapter = new DataSourceAdapter({ store: 'canonical', runner });
    const rows = await adapter.findMany({ table: 'accounts', column: 'id', ids: ['a'] });
    expect(rows).toEqual([{ id: 'a', v: 1 }]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.sql).toBe('SELECT * FROM "accounts" WHERE "id" = ANY($1)');
    expect(runner.calls[0]!.params).toEqual([['a']]);
  });

  it('binds scope as an additional predicate', async () => {
    const runner = new FakeRunner([] as SnapshotRow[]);
    const adapter = new DataSourceAdapter({ store: 'canonical', runner });
    await adapter.findMany({
      table: 'accounts',
      column: 'id',
      ids: ['a'],
      scope: { workspace_id: 'w1' },
    });
    expect(runner.calls[0]!.sql).toBe(
      'SELECT * FROM "accounts" WHERE "id" = ANY($1) AND "workspace_id" = $2',
    );
    expect(runner.calls[0]!.params).toEqual([['a'], 'w1']);
  });

  it('short-circuits an empty id set without querying', async () => {
    const runner = new FakeRunner([] as SnapshotRow[]);
    const adapter = new DataSourceAdapter({ store: 'canonical', runner });
    expect(await adapter.findMany({ table: 'accounts', column: 'id', ids: [] })).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  it('THROWS (→ ADAPTER_UNAVAILABLE) when the runner resolves a non-array, never coerces to []', async () => {
    // e.g. a raw pg.Client returns a Result object { rows, ... }, not an array
    const runner = new FakeRunner({ rows: [], rowCount: 0 });
    const adapter = new DataSourceAdapter({ store: 'canonical', runner });
    await expect(
      adapter.findMany({ table: 'accounts', column: 'id', ids: ['a'] }),
    ).rejects.toThrow();
  });

  it('propagates a driver error (a blip is never swallowed to not_found)', async () => {
    const runner: SqlRunner = { query: () => Promise.reject(new Error('connection refused')) };
    const adapter = new DataSourceAdapter({ store: 'canonical', runner });
    await expect(adapter.findMany({ table: 'accounts', column: 'id', ids: ['a'] })).rejects.toThrow(
      /connection refused/,
    );
  });
});

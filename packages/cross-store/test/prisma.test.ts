import { describe, expect, it } from 'vitest';
import { PrismaAdapter, type PrismaClientLike } from '../src/prisma.js';
import type { SnapshotRow } from '../src/index.js';
import { runAdapterConformance, type ConformanceContext } from './conformance.js';

/** A fake Prisma client: records $queryRawUnsafe calls and matches rows the way the built SQL does. */
class FakePrisma implements PrismaClientLike {
  readonly calls: Array<{ query: string; values: unknown[] }> = [];
  constructor(
    private readonly rows: SnapshotRow[],
    private readonly keyColumn: string,
    private readonly opts: { scopeColumn?: string; broken?: boolean; nonArray?: boolean } = {},
  ) {}

  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.calls.push({ query, values });
    if (this.opts.broken) return Promise.reject(new Error('connection refused'));
    if (this.opts.nonArray) return Promise.resolve({ not: 'an array' } as T);
    const ids = new Set((values[0] as unknown[]).map(String));
    let matched = this.rows.filter((r) => ids.has(String(r[this.keyColumn])));
    if (values.length > 1 && this.opts.scopeColumn) {
      const col = this.opts.scopeColumn;
      matched = matched.filter((r) => String(r[col]) === String(values[1]));
    }
    return Promise.resolve(matched as T);
  }
}

const SEEDED: SnapshotRow[] = [
  { id: 'a', workspace_id: 'w1', kind: 'inflow' },
  { id: 'b', workspace_id: 'w1', kind: 'outflow' },
  { id: 'c', workspace_id: 'w2', kind: 'inflow' },
];

describe('PrismaAdapter', () => {
  it('runs a compareAsText query (col::text = ANY($1)) with the ids spread as $1', async () => {
    const client = new FakePrisma([{ id: 'a', v: 1 }], 'id');
    const adapter = new PrismaAdapter({ store: 'canonical', client });
    const rows = await adapter.findMany({ table: 'accounts', column: 'id', ids: ['a'] });
    expect(rows).toEqual([{ id: 'a', v: 1 }]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.query).toBe('SELECT * FROM "accounts" WHERE "id"::text = ANY($1)');
    expect(client.calls[0]!.values).toEqual([['a']]); // ids bound as the single $1 array
  });

  it('short-circuits an empty id set without querying', async () => {
    const client = new FakePrisma([], 'id');
    const adapter = new PrismaAdapter({ store: 'canonical', client });
    expect(await adapter.findMany({ table: 'accounts', column: 'id', ids: [] })).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('throws (→ ADAPTER_UNAVAILABLE) if the client resolves a non-array, never coerces to []', async () => {
    const client = new FakePrisma([], 'id', { nonArray: true });
    const adapter = new PrismaAdapter({ store: 'canonical', client });
    await expect(
      adapter.findMany({ table: 'accounts', column: 'id', ids: ['a'] }),
    ).rejects.toThrow();
  });

  it('binds scope as a text-cast predicate', async () => {
    const client = new FakePrisma(SEEDED, 'id', { scopeColumn: 'workspace_id' });
    const adapter = new PrismaAdapter({ store: 'canonical', client });
    await adapter.findMany({
      table: 'accounts',
      column: 'id',
      ids: ['a', 'c'],
      scope: { workspace_id: 'w1' },
    });
    expect(client.calls[0]!.query).toBe(
      'SELECT * FROM "accounts" WHERE "id"::text = ANY($1) AND "workspace_id"::text = $2',
    );
    expect(client.calls[0]!.values).toEqual([['a', 'c'], 'w1']);
  });
});

runAdapterConformance('PrismaAdapter (fake client)', (): Promise<ConformanceContext> =>
  Promise.resolve({
    adapter: new PrismaAdapter({
      store: 'canonical',
      client: new FakePrisma(SEEDED, 'id', { scopeColumn: 'workspace_id' }),
    }),
    brokenAdapter: new PrismaAdapter({
      store: 'canonical',
      client: new FakePrisma([], 'id', { broken: true }),
    }),
    table: 'accounts',
    column: 'id',
    seeded: SEEDED,
    scopeColumn: 'workspace_id',
  }),
);

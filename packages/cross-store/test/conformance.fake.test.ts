import type { CrossStoreAdapter, FindManyInput, SnapshotRow } from '../src/index.js';
import { runAdapterConformance, type ConformanceContext } from './conformance.js';

/** A minimal in-memory adapter used to validate the conformance harness itself. */
class InMemoryAdapter implements CrossStoreAdapter {
  constructor(
    readonly store: string,
    private readonly rows: SnapshotRow[],
    private readonly broken = false,
  ) {}

  findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    if (this.broken) return Promise.reject(new Error('store unreachable'));
    if (input.ids.length === 0) return Promise.resolve([]);
    const ids = new Set(input.ids.map(String));
    const matched = this.rows.filter((r) => {
      if (!ids.has(String(r[input.column]))) return false;
      if (input.scope) {
        for (const [col, val] of Object.entries(input.scope)) {
          if (String(r[col]) !== String(val)) return false;
        }
      }
      return true;
    });
    return Promise.resolve(matched);
  }
}

const SEEDED: SnapshotRow[] = [
  { id: 'a', workspace_id: 'w1', kind: 'inflow' },
  { id: 'b', workspace_id: 'w1', kind: 'outflow' },
  { id: 'c', workspace_id: 'w2', kind: 'inflow' },
];

runAdapterConformance('in-memory fake', (): Promise<ConformanceContext> =>
  Promise.resolve({
    adapter: new InMemoryAdapter('canonical', SEEDED),
    brokenAdapter: new InMemoryAdapter('canonical', [], true),
    table: 'canonical_records',
    column: 'id',
    seeded: SEEDED,
    scopeColumn: 'workspace_id',
  }),
);

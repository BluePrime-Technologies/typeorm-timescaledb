import type { DataSource } from 'typeorm';
import { buildFindManySql } from '../sql.js';
import type { CrossStoreAdapter, FindManyInput, SnapshotRow } from '../types.js';

/** Options for {@link DataSourceAdapter}. */
export interface DataSourceAdapterOptions {
  /** Logical store name this adapter serves (matches a `ResolveRef.store`). */
  readonly store: string;
  /** An initialized TypeORM `DataSource` for that store. */
  readonly dataSource: DataSource;
}

/**
 * A {@link CrossStoreAdapter} over a TypeORM `DataSource` — the first real (non-fake) adapter
 * for `@blueprime/cross-store`. Ships behind this `./typeorm` subpath so the core engine
 * (`../index.js`) never imports `typeorm`: the only reference to it here is the type-only
 * `import type { DataSource }`, erased at build time, so `typeorm` stays an **optional peer
 * dependency** of `@blueprime/cross-store` — installing the package's main entrypoint never
 * pulls in an ORM.
 *
 * `findMany` runs the shared {@link buildFindManySql} query via `dataSource.query`, which is
 * itself a single round-trip — satisfying the adapter contract's "one batched fetch" and
 * "all-or-throw" requirements without any extra bookkeeping here: a connection drop or a
 * partial-result driver error simply propagates as a rejected promise, which
 * `resolveReferences` treats as `ADAPTER_UNAVAILABLE` (never a false `REFERENCE_NOT_FOUND`).
 */
export class DataSourceAdapter implements CrossStoreAdapter {
  readonly store: string;
  private readonly dataSource: DataSource;

  constructor(options: DataSourceAdapterOptions) {
    this.store = options.store;
    this.dataSource = options.dataSource;
  }

  async findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    // Defensive short-circuit: an empty id batch needs no round-trip, and `= ANY($1)` on an
    // empty array is well-defined (matches nothing) but not worth a query.
    if (input.ids.length === 0) return [];
    const { sql, params } = buildFindManySql(input);
    const rows: unknown = await this.dataSource.query(sql, [...params]);
    return rows as SnapshotRow[];
  }
}

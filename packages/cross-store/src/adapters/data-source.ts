import type { CrossStoreAdapter, FindManyInput, SnapshotRow } from '../types.js';
import { buildFindManySql } from '../sql/find-many.js';

/**
 * The minimal query surface this adapter needs — deliberately structural so the package never
 * imports `typeorm`. A TypeORM `DataSource`, `EntityManager`, or `QueryRunner` satisfies it and
 * resolves a SELECT to a **row array**; passing an `EntityManager` from a caller's transaction is
 * how M3.4 will resolve references inside the write transaction.
 *
 * ⚠️ A raw `pg.Client`/`pg.Pool` is structurally assignable too, but its `query` resolves a
 * `Result` object (`{ rows, ... }`), NOT an array — use `client.query(...).then(r => r.rows)` or
 * wrap it. `findMany` asserts the result is an array and throws otherwise (surfacing as
 * `ADAPTER_UNAVAILABLE`), so a raw client fails loudly rather than silently reporting `not_found`.
 */
export interface SqlRunner {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

/** What {@link DataSourceAdapter} is constructed with. */
export interface DataSourceAdapterOptions {
  /** Logical store name — must match the `store` on the registered reference targets. */
  readonly store: string;
  /** A TypeORM `DataSource` / `EntityManager` / `QueryRunner` (anything that runs `query`). */
  readonly runner: SqlRunner;
}

/**
 * A {@link CrossStoreAdapter} backed by a TypeORM `DataSource` (or `EntityManager`/`QueryRunner`).
 * Exposed via the `@blueprime/cross-store/typeorm` subpath so the core engine stays ORM-agnostic.
 *
 * `findMany` runs the shared {@link buildFindManySql} query (identifiers allow-listed + quoted,
 * values bound) as one batched round-trip. It does NOT catch driver errors: a connection failure
 * propagates so the resolve engine records `ADAPTER_UNAVAILABLE` (availability ≠ correctness) —
 * a truncated/partial result must therefore never be returned in place of throwing (all-or-throw).
 *
 * Reference/scope values must be **type-compatible** with their columns. Because ids are batched
 * into one `= ANY($1)`, a single type-incompatible value (e.g. a non-uuid string for a `uuid`
 * column) makes Postgres reject the whole batch — which surfaces as `ADAPTER_UNAVAILABLE`
 * (couldn't verify), never a silent `not_found` for the valid ids in the same batch. In practice
 * a referencing FK column is itself typed, so its values are always compatible.
 */
export class DataSourceAdapter implements CrossStoreAdapter {
  readonly store: string;
  private readonly runner: SqlRunner;

  constructor(options: DataSourceAdapterOptions) {
    this.store = options.store;
    this.runner = options.runner;
  }

  async findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    // Defensive: the engine never calls with an empty id set, but a degenerate `= ANY('{}')`
    // is wasteful — return immediately.
    if (input.ids.length === 0) return [];
    const { text, params } = buildFindManySql(input);
    const rows = await this.runner.query(text, params);
    // All-or-throw: a SELECT that resolved with a non-array (a mis-routed/failed query that still
    // resolved) must NOT be coerced to `[]` — that would read as `not_found`. Throw so the engine
    // records `ADAPTER_UNAVAILABLE` (couldn't verify) instead.
    if (!Array.isArray(rows)) {
      throw new TypeError(
        `DataSourceAdapter: query for "${input.table}" did not return a row array`,
      );
    }
    return rows as SnapshotRow[];
  }
}

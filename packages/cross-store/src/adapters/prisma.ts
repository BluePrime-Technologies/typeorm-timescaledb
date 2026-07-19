import type { CrossStoreAdapter, FindManyInput, SnapshotRow } from '../types.js';
import { buildFindManySql } from '../sql/find-many.js';

/**
 * The minimal Prisma surface this adapter needs — deliberately structural so the package never
 * imports `@prisma/client` (a generated, project-specific module). A `PrismaClient` satisfies it.
 * `$queryRawUnsafe(query, ...values)` binds `values` positionally to `$1..$n`; a JS array bound to
 * `$1` becomes a Postgres array (for `= ANY($1)`).
 */
export interface PrismaClientLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** What {@link PrismaAdapter} is constructed with. */
export interface PrismaAdapterOptions {
  /** Logical store name — must match the `store` on the registered reference targets. */
  readonly store: string;
  /** A Prisma client (or anything exposing `$queryRawUnsafe`). */
  readonly client: PrismaClientLike;
}

/**
 * A {@link CrossStoreAdapter} backed by a Prisma client. Exposed via the
 * `@blueprime/cross-store/prisma` subpath so the core engine stays ORM-agnostic.
 *
 * Prisma binds parameters **type-strictly** (a JS string is sent as `text`), and Postgres has no
 * implicit `text`→`uuid`/`bigint`/… cast, so a native `col = ANY($1)` raw query fails (`P2010`).
 * This adapter therefore builds with `compareAsText` — `col::text = ANY($1)` with string-bound
 * values — which is universally type-compatible and matches the resolver's `String()` equality, at
 * the cost of a btree index on the compared columns (acceptable for a best-effort existence check).
 *
 * `findMany` runs one batched `$queryRawUnsafe`. It does NOT catch driver errors: a connection
 * failure propagates so the resolve engine records `ADAPTER_UNAVAILABLE` (availability ≠
 * correctness) — a truncated/partial result must never be returned in place of throwing.
 */
export class PrismaAdapter implements CrossStoreAdapter {
  readonly store: string;
  private readonly client: PrismaClientLike;

  constructor(options: PrismaAdapterOptions) {
    this.store = options.store;
    this.client = options.client;
  }

  async findMany(input: FindManyInput): Promise<readonly SnapshotRow[]> {
    if (input.ids.length === 0) return [];
    const { text, params } = buildFindManySql(input, { compareAsText: true });
    const rows = await this.client.$queryRawUnsafe(text, ...params);
    // All-or-throw: a raw query that resolved with a non-array must NOT be coerced to `[]` (that
    // would read as `not_found`); throw so the engine records `ADAPTER_UNAVAILABLE`.
    if (!Array.isArray(rows)) {
      throw new TypeError(`PrismaAdapter: query for "${input.table}" did not return a row array`);
    }
    return rows as SnapshotRow[];
  }
}

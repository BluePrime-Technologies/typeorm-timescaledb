/**
 * A fully-qualified cross-store reference target: a `column` in a `table` in a logical
 * `store`. The referencing value must equal some registered target's value. Used both to
 * key the allowed-reference registry and to drive a batched existence/validation fetch.
 */
export interface ResolveRef {
  /** Logical store name (e.g. `'canonical'`, `'timescale'`) — selects the adapter. */
  readonly store: string;
  /** Target table, optionally schema-qualified (`schema.table`). */
  readonly table: string;
  /** Target column the reference points at (usually a primary/unique key). */
  readonly column: string;
}

/**
 * One reference to validate: `value` must exist in `ref` (optionally narrowed by `scope`,
 * a map of scope-column → value that is bound as a parameter). `validators` names domain
 * validators (registered by the app) that run against the fetched row.
 */
export interface ReferenceCheck {
  readonly ref: ResolveRef;
  /** The referencing value (e.g. a foreign id on the row being written). */
  readonly value: unknown;
  /** Optional scope filter (tenant isolation): scope-column name → value (values are bound). */
  readonly scope?: Readonly<Record<string, unknown>>;
  /** Names of registered domain validators to run against the fetched reference row. */
  readonly validators?: readonly string[];
}

/** A best-effort snapshot row fetched from a store — an opaque, read-only column map. */
export type SnapshotRow = Readonly<Record<string, unknown>>;

/**
 * What {@link CrossStoreAdapter.findMany} is asked to fetch. The engine has already
 * validated `table`/`column`/scope-column identifiers against the registry before calling,
 * but a well-behaved adapter still quotes identifiers and binds `ids`/scope values.
 */
export interface FindManyInput {
  readonly table: string;
  readonly column: string;
  /**
   * Distinct reference values to look up in one round-trip (`WHERE column = ANY($ids)`).
   * The resolve engine never calls with an empty array, but a defensive adapter should
   * return `[]` immediately for empty `ids` rather than emitting a degenerate query.
   */
  readonly ids: readonly unknown[];
  /** Optional scope filter applied to every id (`AND scopeCol = $value`). */
  readonly scope?: Readonly<Record<string, unknown>>;
}

/**
 * A store adapter — deliberately ORM-agnostic so the resolver core never imports `typeorm`
 * or `prisma`. `store` identifies which logical store this adapter serves.
 *
 * `findMany` MUST perform a **single batched** best-effort fetch (one round-trip for all
 * `ids`) and return the matching rows; the engine indexes them by `column`. It MAY throw —
 * the engine treats any throw as `ADAPTER_UNAVAILABLE` (a blip must never be reported as a
 * missing reference). The returned snapshot is explicitly best-effort/stale (there is a
 * TOCTOU window across separate DB instances).
 *
 * A **partial** batch failure (some rows fetched, then the connection drops) MUST throw for
 * the whole batch — never return a truncated result set. A short return would look to the
 * engine like the missing ids do not exist, turning an availability blip into a false
 * `REFERENCE_NOT_FOUND`. All-or-throw is the contract.
 */
export interface CrossStoreAdapter {
  readonly store: string;
  findMany(input: FindManyInput): Promise<readonly SnapshotRow[]>;
}

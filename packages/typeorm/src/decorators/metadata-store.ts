import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import type { HypertableOptions, TimescaleEntityMetadata } from '@blueprime/timescaledb-core';

/** An entity class constructor — the public key type for reading metadata. */
type Ctor = abstract new (...args: never[]) => unknown;

/**
 * Module-private metadata store, keyed by the entity **constructor**.
 *
 * Deliberately a `WeakMap` — NOT TypeORM's global metadata args storage, NOT
 * `Reflect.defineMetadata`, and NEVER a prototype mutation. This is the rule that
 * makes the predecessor's "import patches `DataSource.prototype` globally" bug
 * structurally impossible here, and it lets entity metadata be garbage-collected
 * with the class.
 */
interface MutableEntityMeta {
  /** True only once `@Hypertable` has run on this constructor (a stray `@TimeColumn` is not enough). */
  isHypertable: boolean;
  options: HypertableOptions;
  timeColumn?: string;
  primaryKeyColumns: string[];
}

const store = new WeakMap<object, MutableEntityMeta>();

function ensure(ctor: object): MutableEntityMeta {
  let meta = store.get(ctor);
  if (!meta) {
    meta = { isHypertable: false, options: {}, primaryKeyColumns: [] };
    store.set(ctor, meta);
  }
  return meta;
}

export function setHypertableOptions(ctor: object, options: HypertableOptions): void {
  const meta = ensure(ctor);
  meta.isHypertable = true;
  meta.options = options;
}

export function setTimeColumn(ctor: object, column: string): void {
  ensure(ctor).timeColumn = column;
}

export function addPrimaryKeyColumn(ctor: object, column: string): void {
  const meta = ensure(ctor);
  if (!meta.primaryKeyColumns.includes(column)) {
    meta.primaryKeyColumns.push(column);
  }
}

/**
 * Resolve metadata for a constructor, merging `@TimeColumn`/`@HypertablePrimaryKey`
 * inherited from base classes (TypeORM inherits columns from base entities). Returns
 * a fresh immutable snapshot, or `undefined` unless some class in the chain is `@Hypertable`.
 */
function resolve(ctor: Ctor): TimescaleEntityMetadata | undefined {
  const chain: MutableEntityMeta[] = [];
  let c: unknown = ctor;
  while (typeof c === 'function') {
    const own = store.get(c);
    if (own) chain.unshift(own); // base-first
    c = Object.getPrototypeOf(c);
  }
  if (!chain.some((m) => m.isHypertable)) return undefined;

  let options: HypertableOptions = {};
  let timeColumn: string | undefined;
  const primaryKeyColumns: string[] = [];
  for (const m of chain) {
    options = { ...options, ...m.options };
    if (m.timeColumn !== undefined) timeColumn = m.timeColumn; // derived overrides base
    for (const col of m.primaryKeyColumns) {
      if (!primaryKeyColumns.includes(col)) primaryKeyColumns.push(col);
    }
  }
  return timeColumn === undefined
    ? { options, primaryKeyColumns }
    : { options, timeColumn, primaryKeyColumns };
}

/** Read merged metadata for an entity constructor (undefined if it is not a hypertable). */
export function getTimescaleMetadata(ctor: Ctor): TimescaleEntityMetadata | undefined {
  return resolve(ctor);
}

export function hasTimescaleMetadata(ctor: Ctor): boolean {
  return resolve(ctor) !== undefined;
}

/**
 * Cross-check the entity's ACTUAL TypeORM primary key against the hypertable's partitioning
 * columns. `validateHypertableMetadata` only sees columns marked with `@HypertablePrimaryKey`, so a
 * user who declares their key with plain TypeORM `@PrimaryColumn`/`@PrimaryGeneratedColumn` would
 * pass validation and only fail at migration-run time with a raw Postgres error ("cannot create a
 * unique index without the column ... used for partitioning"). This catches it at codegen/boot.
 *
 * Only enforced when the entity HAS a primary key — a hypertable with no unique constraint is legal
 * (TimescaleDB just needs any unique/primary key to contain every partitioning column). Compares
 * property names (both sides are entity property names, before the DB-name mapping).
 *
 * @throws {TimescaleError} `TSDB_INVALID_HYPERTABLE_PK` if the PK omits a partitioning column.
 */
export function assertTypeOrmPrimaryKeyIncludesPartitioning(
  em: {
    readonly tableName: string;
    readonly primaryColumns?: ReadonlyArray<{ readonly propertyName: string }>;
  },
  partitioningColumns: readonly string[],
): void {
  // `?? []`: real TypeORM EntityMetadata always exposes primaryColumns, but tolerate metadata
  // shapes that don't (→ treat as no PK, i.e. no enforcement — never crash on partial metadata).
  const columns = em.primaryColumns ?? [];
  if (columns.length === 0) return; // no PK constraint → create_hypertable is unconstrained
  const pk = new Set(columns.map((c) => c.propertyName));
  const missing = partitioningColumns.filter((c) => !pk.has(c));
  if (missing.length > 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_HYPERTABLE_PK,
      `hypertable ${em.tableName}: its primary key [${[...pk].join(', ')}] must include every partitioning column; missing: ${missing.join(', ')}. TimescaleDB requires every unique/primary key to contain the time (and space) partition column(s) — add them to the PK or mark them with @HypertablePrimaryKey.`,
      { table: em.tableName, missing, primaryKey: [...pk] },
    );
  }
}

// ---------------------------------------------------------------------------
// Continuous-aggregate metadata (M2.5b) — a separate WeakMap store, same rules:
// keyed by the entity constructor, never a prototype / global mutation.
// ---------------------------------------------------------------------------

/** One aggregate output column of a continuous aggregate. */
export interface CaggAggregate {
  /** The CAGG entity property that receives the aggregate value. */
  readonly property: string;
  /** Aggregate function (validated at codegen against the allow-list). */
  readonly fn: string;
  /** Source column **property** to aggregate; omit for `count` → `count(*)`. */
  readonly column?: string;
}

/** An automatic refresh policy attached to a continuous aggregate. */
export interface CaggRefreshPolicy {
  /**
   * How far back from *now* the refresh window starts, as an INTERVAL literal
   * (e.g. `'1 month'`). `null` = from the beginning of time (refreshes all history — expensive).
   */
  readonly startOffset: string | null;
  /**
   * How far back from *now* the refresh window ends, as an INTERVAL literal
   * (e.g. `'1 hour'`, to leave the still-filling latest bucket alone). `null` = up to now.
   *
   * Must be *smaller* than `startOffset` — TimescaleDB requires `start_offset > end_offset`
   * (an inverted window fails loudly when the migration runs).
   */
  readonly endOffset: string | null;
  /**
   * How often the policy runs, as an INTERVAL literal. Defaults at codegen to the CAGG's
   * **bucket width**. (Always emitted into the migration — TimescaleDB 2.18 has no
   * overload that omits `schedule_interval`.)
   */
  readonly scheduleInterval?: string;
}

/** Resolved `@ContinuousAggregate` metadata for a CAGG entity constructor. */
export interface ContinuousAggregateMeta {
  /** The CAGG view name, optionally `schema.view`. */
  readonly viewName: string;
  /** The source hypertable entity constructor. */
  readonly source: Ctor;
  /** Bucket width, e.g. `'1 hour'`. */
  readonly bucketInterval: string;
  /** `timescaledb.materialized_only`; defaults to `false` (real-time) at codegen. */
  readonly materializedOnly?: boolean;
  /** Source time **property** override; defaults to the source's `@TimeColumn`. */
  readonly timeColumn?: string;
  /** The `@BucketColumn` property (the time-bucket output column). */
  readonly bucketProperty: string;
  /** `@GroupColumn` properties (extra GROUP BY keys; also output columns). */
  readonly groupProperties: readonly string[];
  /** `@AggregateColumn` outputs. */
  readonly aggregates: readonly CaggAggregate[];
  /** Optional automatic refresh policy (`add_continuous_aggregate_policy`). */
  readonly refresh?: CaggRefreshPolicy;
}

interface MutableCaggMeta {
  declared: boolean; // true once @ContinuousAggregate has run
  viewName?: string;
  source?: Ctor;
  bucketInterval?: string;
  materializedOnly?: boolean;
  timeColumn?: string;
  bucketProperty?: string;
  groupProperties: string[];
  aggregates: CaggAggregate[];
  refresh?: CaggRefreshPolicy;
}

const caggStore = new WeakMap<object, MutableCaggMeta>();

function ensureCagg(ctor: object): MutableCaggMeta {
  let meta = caggStore.get(ctor);
  if (!meta) {
    meta = { declared: false, groupProperties: [], aggregates: [] };
    caggStore.set(ctor, meta);
  }
  return meta;
}

export function setContinuousAggregate(
  ctor: object,
  cfg: {
    viewName: string;
    source: Ctor;
    bucketInterval: string;
    materializedOnly?: boolean;
    timeColumn?: string;
    refresh?: CaggRefreshPolicy;
  },
): void {
  const meta = ensureCagg(ctor);
  meta.declared = true;
  meta.viewName = cfg.viewName;
  meta.source = cfg.source;
  meta.bucketInterval = cfg.bucketInterval;
  if (cfg.materializedOnly !== undefined) meta.materializedOnly = cfg.materializedOnly;
  if (cfg.timeColumn !== undefined) meta.timeColumn = cfg.timeColumn;
  if (cfg.refresh !== undefined) meta.refresh = cfg.refresh;
}

export function setBucketColumn(ctor: object, property: string): void {
  const meta = ensureCagg(ctor);
  if (meta.bucketProperty !== undefined && meta.bucketProperty !== property) {
    const name = (ctor as { name?: string }).name ?? 'entity';
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${name} has more than one @BucketColumn (${meta.bucketProperty}, ${property}) — a continuous aggregate has exactly one time bucket`,
      { entity: name },
    );
  }
  meta.bucketProperty = property;
}

export function addGroupColumn(ctor: object, property: string): void {
  const meta = ensureCagg(ctor);
  if (!meta.groupProperties.includes(property)) meta.groupProperties.push(property);
}

export function addAggregateColumn(
  ctor: object,
  property: string,
  fn: string,
  column?: string,
): void {
  ensureCagg(ctor).aggregates.push({ property, fn, ...(column !== undefined && { column }) });
}

/**
 * Read `@ContinuousAggregate` metadata for a constructor, or `undefined` if the class
 * is not a continuous aggregate. Throws `TimescaleError(INVALID_ARGUMENT)` if it is
 * declared but structurally incomplete (missing source/bucket/@BucketColumn/aggregates).
 *
 * NOTE: unlike hypertable metadata (which merges the prototype chain), CAGG metadata is read
 * off the exact constructor and is NOT inherited — a `@ContinuousAggregate` class is a concrete
 * view definition, not a base to subclass. A subclass without its own `@ContinuousAggregate`
 * resolves to `undefined`.
 */
export function getContinuousAggregateMeta(ctor: Ctor): ContinuousAggregateMeta | undefined {
  const m = caggStore.get(ctor);
  if (!m || !m.declared) return undefined;
  const name = (ctor as { name?: string }).name ?? 'entity';
  if (m.viewName === undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `@ContinuousAggregate on ${name} is missing its \`name\` (the view name)`,
      { entity: name },
    );
  }
  if (!m.source) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `@ContinuousAggregate on ${name} is missing its \`source\` hypertable`,
      { entity: name },
    );
  }
  if (m.bucketInterval === undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `@ContinuousAggregate on ${name} is missing its \`bucket\` interval`,
      { entity: name },
    );
  }
  if (m.bucketProperty === undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${name} needs exactly one @BucketColumn() property`,
      { entity: name },
    );
  }
  if (m.aggregates.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${name} needs at least one @AggregateColumn() property`,
      { entity: name },
    );
  }
  return {
    viewName: m.viewName,
    source: m.source,
    bucketInterval: m.bucketInterval,
    ...(m.materializedOnly !== undefined && { materializedOnly: m.materializedOnly }),
    ...(m.timeColumn !== undefined && { timeColumn: m.timeColumn }),
    bucketProperty: m.bucketProperty,
    groupProperties: [...m.groupProperties],
    aggregates: m.aggregates.map((a) => ({ ...a })),
    ...(m.refresh !== undefined && { refresh: { ...m.refresh } }),
  };
}

export function hasContinuousAggregateMeta(ctor: Ctor): boolean {
  const m = caggStore.get(ctor);
  return !!m && m.declared;
}

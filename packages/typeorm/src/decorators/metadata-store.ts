import type {
  HypertableOptions,
  TimescaleEntityMetadata,
} from '@blueprime/timescaledb-core';

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

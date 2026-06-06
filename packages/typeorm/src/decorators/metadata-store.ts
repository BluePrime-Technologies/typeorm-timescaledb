import type {
  HypertableOptions,
  TimescaleEntityMetadata,
} from '@blueprime-technologies/timescaledb-core';

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
  options: HypertableOptions;
  timeColumn?: string;
  primaryKeyColumns: string[];
}

const store = new WeakMap<object, MutableEntityMeta>();

function ensure(ctor: object): MutableEntityMeta {
  let meta = store.get(ctor);
  if (!meta) {
    meta = { options: {}, primaryKeyColumns: [] };
    store.set(ctor, meta);
  }
  return meta;
}

export function setHypertableOptions(ctor: object, options: HypertableOptions): void {
  ensure(ctor).options = options;
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

/** Read captured metadata for an entity constructor (undefined if not a hypertable). */
export function getTimescaleMetadata(ctor: object): TimescaleEntityMetadata | undefined {
  return store.get(ctor);
}

export function hasTimescaleMetadata(ctor: object): boolean {
  return store.has(ctor);
}

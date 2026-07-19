import { CrossStoreError, CrossStoreErrorCode } from './errors.js';
import type { ResolveRef } from './types.js';

/** Any entity constructor — the key type for the metadata store. */
export type EntityClass = new (...args: never[]) => object;

/**
 * Options for {@link Resolve}. `scope` maps a **DB scope column** → the **sibling entity property**
 * whose value fills it (tenant isolation: `{ workspace_id: 'workspaceId' }` means "scope column
 * workspace_id = this.workspaceId"). `validators` names domain validators to run against the
 * fetched reference row.
 */
export interface ResolveFieldOptions {
  readonly scope?: Readonly<Record<string, string>>;
  readonly validators?: readonly string[];
  /**
   * When `true`, a `null`/`undefined` value on this field is a hard failure at resolve time (the
   * reference is mandatory). When omitted/`false` the field is a **nullable** FK — a `null`/
   * `undefined` value means "no reference" and is skipped. Set this for a required FK so an
   * accidental `undefined` (a partial DTO, an un-hydrated relation) fails closed instead of the
   * reference being silently unchecked.
   */
  readonly required?: boolean;
}

/** The recorded metadata for one `@Resolve`d entity field. */
export interface ResolveFieldMeta {
  /** The entity property that holds the referencing value (the "foreign id"). */
  readonly property: string;
  /** The reference target `(store, table, column)`. */
  readonly ref: ResolveRef;
  /** Scope column → sibling property name (see {@link ResolveFieldOptions.scope}). */
  readonly scope?: Readonly<Record<string, string>>;
  readonly validators?: readonly string[];
  /** The reference is mandatory — a `null`/`undefined` value fails closed (see {@link ResolveFieldOptions.required}). */
  readonly required?: boolean;
}

/**
 * The reference metadata store — a module-private `WeakMap` keyed by the entity constructor. This
 * is the tier-0 invariant: NO global/prototype mutation. Metadata is only ever read back through
 * {@link getResolveMetadata}; the map itself is not exported.
 */
const RESOLVE_META = new WeakMap<EntityClass, Map<string, ResolveFieldMeta>>();

/**
 * Parse a `store.table.column` (or `store.schema.table.column`) spec into a {@link ResolveRef}.
 * First segment is the store, last is the column, the middle segment(s) are the table (joined, so a
 * schema-qualified `schema.table` survives). Identifiers themselves are validated by the registry
 * at registration; here we only enforce the shape (≥3 non-empty segments).
 */
function parseRef(spec: string): ResolveRef {
  if (typeof spec !== 'string') {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      '@Resolve spec must be a string',
      {
        spec,
      },
    );
  }
  const parts = spec.split('.');
  if (parts.length < 3 || parts.some((p) => p.length === 0)) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `@Resolve spec must be "store.table.column" or "store.schema.table.column", got: ${spec}`,
      { spec },
    );
  }
  return Object.freeze({
    store: parts[0]!,
    table: parts.slice(1, -1).join('.'),
    column: parts[parts.length - 1]!,
  });
}

function freezeFieldMeta(meta: ResolveFieldMeta): ResolveFieldMeta {
  return Object.freeze({
    property: meta.property,
    ref: meta.ref,
    ...(meta.scope !== undefined && { scope: Object.freeze({ ...meta.scope }) }),
    ...(meta.validators !== undefined && {
      validators: Object.freeze([...meta.validators]),
    }),
    ...(meta.required !== undefined && { required: meta.required }),
  });
}

/**
 * Declare that an entity property is a **cross-store reference** — its value must exist in another
 * store's `store.table.column` (validated at write time by `createManyResolved`, and enumerable via
 * {@link resolveEntities}). ORM-agnostic: records metadata only, mutates no prototype/global.
 *
 * ```ts
 * class LedgerEntry {
 *   @Resolve('canonical.accounts.id', { scope: { workspace_id: 'workspaceId' }, validators: ['isOpen'] })
 *   accountId!: string;
 *   workspaceId!: string;
 * }
 * ```
 */
export function Resolve(spec: string, options: ResolveFieldOptions = {}): PropertyDecorator {
  const ref = parseRef(spec);
  return (target, propertyKey) => {
    if (typeof propertyKey === 'symbol') {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        '@Resolve cannot decorate a symbol property',
        { spec },
      );
    }
    // A static-member decoration passes the constructor itself as `target` (not the prototype); its
    // `.constructor` is `Function`, so metadata would be stored under a key getResolveMetadata never
    // visits → the reference would be silently unchecked (fail-open). Reject it, like a symbol.
    if (typeof target === 'function') {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        '@Resolve must decorate an instance property, not a static member',
        { spec, property: propertyKey },
      );
    }
    const ctor = (target as { constructor: EntityClass }).constructor;
    let fields = RESOLVE_META.get(ctor);
    if (!fields) {
      fields = new Map();
      RESOLVE_META.set(ctor, fields);
    }
    fields.set(
      propertyKey,
      freezeFieldMeta({
        property: propertyKey,
        ref,
        ...(options.scope !== undefined && { scope: options.scope }),
        ...(options.validators !== undefined && { validators: options.validators }),
        ...(options.required !== undefined && { required: options.required }),
      }),
    );
  };
}

/**
 * The `@Resolve` field metadata for an entity class, walking the prototype chain so a subclass
 * inherits its base class's references. Resolution is **additive/override-only**: a subclass field
 * of the same name overrides the base's declaration, but a subclass cannot *remove* an inherited
 * `@Resolve` by omission (the base metadata is never mutated — the walk just reads it). Returns an
 * empty array for a class with no `@Resolve`d fields. The walk reads only each constructor's OWN
 * metadata entry, never a sibling's, and terminates at the top of the chain (`null`).
 */
export function getResolveMetadata(entityClass: EntityClass): readonly ResolveFieldMeta[] {
  const merged = new Map<string, ResolveFieldMeta>();
  let ctor: EntityClass | null = entityClass;
  while (ctor) {
    const fields = RESOLVE_META.get(ctor);
    if (fields) {
      // most-derived wins: only set a property a subclass hasn't already defined
      for (const [property, meta] of fields) if (!merged.has(property)) merged.set(property, meta);
    }
    ctor = Object.getPrototypeOf(ctor) as EntityClass | null;
  }
  return [...merged.values()];
}

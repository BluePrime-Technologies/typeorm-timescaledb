import { assertSafeIdentifier } from '@blueprime/timescaledb-core';
import { CrossStoreError, CrossStoreErrorCode } from './errors.js';
import { safeColumnType } from './sql/column-type.js';
import type { ResolveRef } from './types.js';

/** One allowed reference target plus the scope columns and append-only guarantee it carries. */
export interface ReferenceRegistryEntry {
  readonly store: string;
  /** Target table, optionally `schema.table`. */
  readonly table: string;
  readonly column: string;
  /**
   * Columns allowed as scope filters for this target. Every scope column that reaches SQL
   * MUST be allowlisted here (issue #124 fix #4 — the registry gates the target table AND
   * the scope column identifiers, not just the target).
   */
  readonly scopeColumns?: readonly string[];
  /**
   * The target is append-only / soft-delete (a validated row can never be hard-deleted).
   * Required for the TOCTOU mitigation to hold (issue #124 fix #1); a registered target
   * without this flag is surfaced by {@link ReferenceRegistry.nonAppendOnlyTargets} so the
   * runtime can warn at startup.
   */
  readonly targetIsAppendOnly?: boolean;
  /**
   * Asserts the target `column` is **unique** (a primary key or a `UNIQUE` constraint). The
   * resolver assumes this: it indexes fetched rows by the key value and takes one row per value, so
   * a non-unique target makes "resolved" pick an arbitrary row — an ambiguous, silently wrong match.
   * A registered target without this flag is surfaced by {@link ReferenceRegistry.nonUniqueTargets}
   * so the runtime can warn at startup (see {@link warnNonUniqueTargets}). Declarative only — the
   * package cannot verify the constraint exists; it's the caller's assertion that it does.
   */
  readonly targetIsUnique?: boolean;
  /**
   * The base SQL type of the key `column` (e.g. `'uuid'`, `'bigint'`, `'text'`). When set, the
   * fetch casts the bound PARAM (`= ANY($1::uuid[])`) rather than the column, so the target's index
   * stays usable while still working with a type-strict driver (Prisma). Validated against a
   * conservative allowlist at registration (it is interpolated into SQL as a cast target, never
   * bound). Omit to use the column-text-cast (Prisma) / native (TypeORM) comparison.
   */
  readonly columnType?: string;
}

/**
 * The internal Map key for a reference target. `JSON.stringify` of the tuple is injective
 * (distinct `[store, table, column]` -> distinct strings), so no delimiter-based collision is
 * possible - including from an *unvalidated* lookup ref. A `table` may be `schema.table`, so a
 * naive `.`-joined key would let a malformed lookup (`store:'a.b'`) collide with a legitimate
 * dotted-table ref (`table:'b.x'`); the structured key cannot.
 */
function refKey(ref: { store: string; table: string; column: string }): string {
  return JSON.stringify([ref.store, ref.table, ref.column]);
}

/** `store.table.column` — a human-readable label for error messages. */
function refLabel(ref: { store: string; table: string; column: string }): string {
  return `${ref.store}.${ref.table}.${ref.column}`;
}

/**
 * Normalize + deep-freeze an entry for storage: dedupe `scopeColumns` (preserving order),
 * freeze that array, and freeze the entry. Freezing is the anti-tamper guarantee — once
 * registered, nothing in-process can widen the allowlist by mutating a returned entry.
 */
function freezeEntry(entry: ReferenceRegistryEntry): ReferenceRegistryEntry {
  const scopeColumns =
    entry.scopeColumns !== undefined ? Object.freeze([...new Set(entry.scopeColumns)]) : undefined;
  return Object.freeze({
    store: entry.store,
    table: entry.table,
    column: entry.column,
    ...(scopeColumns !== undefined && { scopeColumns }),
    ...(entry.targetIsAppendOnly !== undefined && { targetIsAppendOnly: entry.targetIsAppendOnly }),
    ...(entry.targetIsUnique !== undefined && { targetIsUnique: entry.targetIsUnique }),
    // store the canonical (validated, lower-cased) type — the exact token later interpolated into SQL
    ...(entry.columnType !== undefined && { columnType: safeColumnType(entry.columnType) }),
  });
}

/**
 * Two entries at the same key are equivalent iff their scope-column SET, append-only flag, and
 * unique flag all match — a conflicting re-registration (differing on any of these) is rejected.
 */
function sameEntry(a: ReferenceRegistryEntry, b: ReferenceRegistryEntry): boolean {
  if ((a.targetIsAppendOnly === true) !== (b.targetIsAppendOnly === true)) return false;
  if ((a.targetIsUnique === true) !== (b.targetIsUnique === true)) return false;
  if ((a.columnType ?? undefined) !== (b.columnType ?? undefined)) return false;
  const sa = new Set(a.scopeColumns ?? []);
  const sb = new Set(b.scopeColumns ?? []);
  if (sa.size !== sb.size) return false;
  for (const col of sa) if (!sb.has(col)) return false;
  return true;
}

/** Validate a logical store name (not SQL, but keep it a safe token). */
function assertStore(store: string): void {
  assertSafeIdentifier(store, 'store name');
}

/** Validate an optionally schema-qualified table identifier (each part safe; at most `schema.table`). */
function assertTableIdent(table: string): void {
  if (typeof table !== 'string' || table.length === 0) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      'table must be a non-empty string',
      { table },
    );
  }
  const parts = table.split('.');
  if (parts.length > 2) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `table must be "name" or "schema.name", got: ${table}`,
      { table },
    );
  }
  if (parts.some((part) => part.length === 0)) {
    // e.g. "schema.", ".tbl", "a..b" — explicit guard so intent doesn't rely on
    // assertSafeIdentifier('') happening to reject the empty string.
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `table identifier parts must be non-empty, got: ${table}`,
      { table },
    );
  }
  for (const part of parts) assertSafeIdentifier(part, 'table identifier');
}

/**
 * The allowed-reference registry: the anti-injection allowlist of every cross-store
 * reference target the app may resolve. Registration validates every identifier up front
 * (fail fast); resolution rejects any target/scope column not present here. This is the
 * single boundary that keeps identifiers safe — the resolver never trusts a decorator or a
 * caller for a table/column/scope name.
 *
 * The registry holds only the generic *mechanism* (what is referenceable). Domain policy
 * (the concrete list, and named validators) is supplied by the application.
 */
export class ReferenceRegistry {
  private readonly entries = new Map<string, ReferenceRegistryEntry>();

  /**
   * Register an allowed reference target. Throws (core `TimescaleError` `UNSAFE_IDENTIFIER`,
   * or `CrossStoreError` `INVALID_ARGUMENT`) if any identifier is unsafe/malformed —
   * misconfiguration fails at wiring time, never at runtime.
   *
   * Re-registering the same `(store, table, column)` is idempotent **only** when the scope
   * columns and append-only flag are identical; a *conflicting* re-registration throws
   * `INVALID_ARGUMENT` so a late module cannot silently widen the scope or clear the
   * append-only flag. Identifiers are case-sensitive (they are quoted, not folded). The
   * stored entry is deep-frozen — a returned entry cannot be mutated to widen the allowlist.
   */
  register(entry: ReferenceRegistryEntry): this {
    assertStore(entry.store);
    assertTableIdent(entry.table);
    assertSafeIdentifier(entry.column, 'reference column');
    for (const scopeCol of entry.scopeColumns ?? []) assertSafeIdentifier(scopeCol, 'scope column');
    if (entry.columnType !== undefined) safeColumnType(entry.columnType); // allowlist-validate (fail fast)
    const key = refKey(entry);
    const frozen = freezeEntry(entry);
    const existing = this.entries.get(key);
    if (existing && !sameEntry(existing, frozen)) {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `conflicting re-registration of ${key} (scope columns / append-only / unique flag / columnType differ)`,
        { existing, attempted: frozen },
      );
    }
    this.entries.set(key, frozen);
    return this;
  }

  /** The registered entry (deep-frozen) for a target, or `undefined` if not allowlisted. */
  get(ref: ResolveRef): ReferenceRegistryEntry | undefined {
    return this.entries.get(refKey(ref));
  }

  /** Whether a reference target is allowlisted. */
  isAllowed(ref: ResolveRef): boolean {
    return this.entries.has(refKey(ref));
  }

  /** Return the entry, or throw `REFERENCE_NOT_ALLOWED` if the target is not registered. */
  assertRegistered(ref: ResolveRef): ReferenceRegistryEntry {
    const entry = this.entries.get(refKey(ref));
    if (!entry) {
      throw new CrossStoreError(
        CrossStoreErrorCode.REFERENCE_NOT_ALLOWED,
        `reference ${refLabel(ref)} is not in the allowed-reference registry`,
        { ref },
      );
    }
    return entry;
  }

  /**
   * Assert every given scope column is allowlisted for a target (and the target itself is
   * registered), and return the (deep-frozen) registered entry. Throws `REFERENCE_NOT_ALLOWED`
   * if the target is not registered, or `SCOPE_VIOLATION` on the first column that is not
   * allowed. Returning the entry lets the resolve engine validate scope + obtain the entry in
   * one call, without a second registry lookup.
   */
  assertScopeAllowed(ref: ResolveRef, scopeColumns: readonly string[]): ReferenceRegistryEntry {
    const entry = this.assertRegistered(ref);
    const allowed = new Set(entry.scopeColumns ?? []);
    for (const scopeCol of scopeColumns) {
      if (!allowed.has(scopeCol)) {
        throw new CrossStoreError(
          CrossStoreErrorCode.SCOPE_VIOLATION,
          `scope column "${scopeCol}" is not allowed for reference ${refLabel(ref)}`,
          { ref, scopeColumn: scopeCol },
        );
      }
    }
    return entry;
  }

  /**
   * Validate a batch of `@Resolve` targets up front (boot-time). Throws
   * `REFERENCE_NOT_ALLOWED` for the first target that is not registered — so a mis-declared
   * `@Resolve` fails at startup, not on the first write (issue #124 fix #4).
   */
  assertAllRegistered(refs: readonly ResolveRef[]): void {
    for (const ref of refs) this.assertRegistered(ref);
  }

  /** All registered entries (snapshot copy). */
  list(): ReferenceRegistryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Registered targets NOT marked `targetIsAppendOnly` — the runtime warns about these at
   * startup because the TOCTOU mitigation (issue #124 fix #1) assumes validated rows cannot
   * be hard-deleted out from under a write.
   */
  nonAppendOnlyTargets(): ReferenceRegistryEntry[] {
    return this.list().filter((entry) => entry.targetIsAppendOnly !== true);
  }

  /**
   * Registered targets NOT marked `targetIsUnique` — the runtime warns about these at startup
   * because the resolver assumes a target column is unique (it takes one row per key value). A
   * non-unique target makes a "resolved" verdict pick an arbitrary matching row (ambiguous,
   * silently wrong). See {@link warnNonUniqueTargets}.
   */
  nonUniqueTargets(): ReferenceRegistryEntry[] {
    return this.list().filter((entry) => entry.targetIsUnique !== true);
  }
}

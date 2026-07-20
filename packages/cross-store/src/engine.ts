import { CrossStoreError, CrossStoreErrorCode } from './errors.js';
import type { ReferenceRegistry } from './registry.js';
import type { CrossStoreAdapter, ReferenceCheck, SnapshotRow } from './types.js';

/**
 * A domain validator: runs against the fetched best-effort snapshot `row` for a resolved
 * reference (issue #124 fix #6). **Fail-closed**: return `true`/`undefined`/`void` to accept;
 * anything else (`false`, any other value, or a throw) rejects the row. May be async. The engine
 * reports a rejection as `VALIDATOR_FAILED` carrying the validator's name.
 */
export type Validator = (
  row: SnapshotRow,
  check: ReferenceCheck,
) => boolean | void | Promise<boolean | void>;

/** Named validators supplied by the application (domain policy lives outside this package). */
export type ValidatorMap = Readonly<Record<string, Validator>>;

/** The dependencies a resolve pass needs: the allowlist, the store adapters, and the validators. */
export interface ResolveOptions {
  readonly registry: ReferenceRegistry;
  /** One adapter per logical store. Two adapters claiming the same `store` is a wiring error. */
  readonly adapters: readonly CrossStoreAdapter[];
  /** Named domain validators; required only if a check references one by name. */
  readonly validators?: ValidatorMap;
}

/**
 * The disposition of a single reference check. `resolved` and `not_referenced` are the only
 * success (`ok: true`) statuses. `resolveReferences` itself never emits `invalid` or
 * `not_referenced`; both are produced only by the entity layer (`resolveEntities`) for a check
 * that never reached the engine: `invalid` for a check that could not even be FORMED (report mode
 * only — a `required` field that is null/undefined, or an unset scope sibling), `not_referenced`
 * for a nullable field that was null/undefined at validation time (issue #140 window #1 baseline —
 * see {@link EntityFieldVerdict} in `resolve-entities.ts`).
 */
export type ResolveStatus =
  | 'resolved'
  | 'not_found'
  | 'not_allowed'
  | 'scope_violation'
  | 'unavailable'
  | 'validator_failed'
  | 'invalid'
  | 'not_referenced';

/** The verdict for one input check — always returned (the engine never throws per-check). */
export interface ResolveVerdict {
  readonly check: ReferenceCheck;
  /** `true` only for `resolved`. */
  readonly ok: boolean;
  readonly status: ResolveStatus;
  /** Present iff `!ok`; a stable {@link CrossStoreError} describing the failure. */
  readonly error?: CrossStoreError;
  /** The fetched snapshot row, present when a row was found (`resolved` or `validator_failed`). */
  readonly row?: SnapshotRow;
}

/**
 * Scalar equality key. Reference and scope values are ids (uuid/int/bigint/string); a driver
 * may hand a bigint column back as a number or a string, so we compare by `String(value)` —
 * matching SQL scalar equality and dissolving the bigint/number/string ambiguity. Input values
 * are scalar-guarded up front by {@link assertScalarId}, so a non-scalar can never reach here to
 * collide via `"[object Object]"`; row-column values from an adapter are keyed leniently (a
 * non-scalar simply fails to match any real id — fail-closed).
 */
function valueKey(value: unknown): string {
  return String(value);
}

/**
 * Reference and scope values MUST be scalar ids. Reject anything else up front (a wiring/usage
 * error, e.g. an object id) with `INVALID_ARGUMENT` — otherwise `String(value)` would map every
 * object to `"[object Object]"` and silently conflate distinct references.
 */
function assertScalarId(value: unknown, role: string): void {
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'bigint') {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `${role} must be a scalar id (string | number | bigint), got ${value === null ? 'null' : t}`,
      { role },
    );
  }
}

/** An empty scope map is equivalent to no scope — normalize it away so grouping is deterministic. */
function normalizeScope(
  scope?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  return scope && Object.keys(scope).length > 0 ? scope : undefined;
}

/** The scope columns (keys) a check filters on, if any. */
function scopeColumnsOf(check: ReferenceCheck): string[] {
  const scope = normalizeScope(check.scope);
  return scope ? Object.keys(scope) : [];
}

/**
 * A stable, injective signature for a check's scope map: `JSON.stringify` of sorted
 * `[column, value]` pairs. Two checks share a `findMany` only if their (store, table, column)
 * AND this signature match — because scope is a bound SQL filter, so different scope values are
 * genuinely different queries. JSON encoding (not `col=val` concatenation) is what makes it
 * collision-proof: a value containing `=`/`&` cannot forge another scope's signature and cause a
 * wrong-merge (which would fetch rows under the wrong scope — a tenant-isolation break).
 */
function scopeSignature(check: ReferenceCheck): string {
  const scope = normalizeScope(check.scope);
  if (!scope) return '';
  return JSON.stringify(
    Object.keys(scope)
      .sort()
      .map((col) => [col, valueKey(scope[col])]),
  );
}

interface Group {
  readonly store: string;
  readonly table: string;
  readonly column: string;
  readonly scope?: Readonly<Record<string, unknown>>;
  /** Original indices (into the input `checks`) of every member of this group. */
  readonly members: number[];
}

/**
 * Batch-resolve cross-store reference checks. ORM-agnostic and side-effect free: it never
 * writes and never imports an ORM — it groups, fetches once per group via the store adapters,
 * runs validators against the fetched rows, and returns one {@link ResolveVerdict} per input
 * check (in input order).
 *
 * Failures that are about a check's *data or declaration* become verdicts, never throws:
 * `not_allowed` (target not registered), `scope_violation` (scope column not allowlisted),
 * `not_found` (row genuinely absent), `unavailable` (the adapter threw — a blip, NOT a missing
 * reference), and `validator_failed`. Only *wiring* errors throw `INVALID_ARGUMENT` up front —
 * before any fetch — because they are deploy-wide bugs, not per-write conditions: two adapters
 * for one store, a needed store with no adapter, or a validator named but not supplied.
 *
 * Batching (issue #124 fix #3): checks are grouped by `(store, table, column, scope)`, values
 * deduped, and each group fetched with a single `adapter.findMany`. Groups run concurrently.
 */
export async function resolveReferences(
  checks: readonly ReferenceCheck[],
  options: ResolveOptions,
): Promise<readonly ResolveVerdict[]> {
  const { registry } = options;
  if (!registry) {
    throw new CrossStoreError(CrossStoreErrorCode.INVALID_ARGUMENT, 'a registry is required');
  }

  const verdicts = new Array<ResolveVerdict | undefined>(checks.length);

  // 1. Index adapters by store — reject a duplicate store (ambiguous wiring).
  const adapterByStore = new Map<string, CrossStoreAdapter>();
  for (const adapter of options.adapters ?? []) {
    if (adapterByStore.has(adapter.store)) {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `two adapters registered for store "${adapter.store}"`,
        { store: adapter.store },
      );
    }
    adapterByStore.set(adapter.store, adapter);
  }

  // 2. Gate every check against the registry. Registered + scope-allowed checks proceed to
  //    fetching; the rest get a per-check verdict now and are excluded from any query.
  const groups = new Map<string, Group>();
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    const { ref } = check;
    // Usage precondition (throws INVALID_ARGUMENT): reference + scope values must be scalar ids.
    assertScalarId(check.value, 'reference value');
    const scope = normalizeScope(check.scope);
    if (scope)
      for (const col of Object.keys(scope)) assertScalarId(scope[col], `scope value "${col}"`);
    try {
      registry.assertScopeAllowed(ref, scopeColumnsOf(check));
    } catch (e) {
      // A per-check data/declaration failure → verdict. An unexpected (non-CrossStore) throw is
      // an internal bug and must NOT be masked as not_allowed — rethrow it.
      if (!(e instanceof CrossStoreError)) throw e;
      const status: ResolveStatus =
        e.code === CrossStoreErrorCode.SCOPE_VIOLATION ? 'scope_violation' : 'not_allowed';
      verdicts[i] = { check, ok: false, status, error: e };
      continue;
    }
    const key = JSON.stringify([ref.store, ref.table, ref.column, scopeSignature(check)]);
    const existing = groups.get(key);
    if (existing) existing.members.push(i);
    else
      groups.set(key, {
        store: ref.store,
        table: ref.table,
        column: ref.column,
        ...(scope !== undefined && { scope }),
        members: [i],
      });
  }

  // 3. Pre-flight wiring for the checks that will actually be fetched: every needed store must
  //    have an adapter, and every named validator must be supplied. Throw before any fetch.
  const validators = options.validators ?? {};
  for (const group of groups.values()) {
    if (!adapterByStore.has(group.store)) {
      throw new CrossStoreError(
        CrossStoreErrorCode.INVALID_ARGUMENT,
        `no adapter registered for store "${group.store}"`,
        { store: group.store },
      );
    }
    for (const i of group.members) {
      for (const name of checks[i]!.validators ?? []) {
        if (!Object.prototype.hasOwnProperty.call(validators, name)) {
          throw new CrossStoreError(
            CrossStoreErrorCode.INVALID_ARGUMENT,
            `no validator registered under the name "${name}"`,
            { validator: name },
          );
        }
      }
    }
  }

  // 4. Fetch each group once and evaluate its members. Groups are independent → run concurrently.
  await Promise.all(
    [...groups.values()].map((group) =>
      resolveGroup(group, checks, adapterByStore.get(group.store)!, validators, verdicts),
    ),
  );

  // Every slot is filled (gated-out in step 2, or resolved in step 4).
  return verdicts as ResolveVerdict[];
}

/** Fetch one group's rows in a single round-trip and write a verdict for each member. */
async function resolveGroup(
  group: Group,
  checks: readonly ReferenceCheck[],
  adapter: CrossStoreAdapter,
  validators: ValidatorMap,
  verdicts: Array<ResolveVerdict | undefined>,
): Promise<void> {
  // Dedup the referenced values so one round-trip covers every member (issue #124 fix #3).
  const distinct = new Map<string, unknown>();
  for (const i of group.members) distinct.set(valueKey(checks[i]!.value), checks[i]!.value);

  let rowByValue: Map<string, SnapshotRow>;
  try {
    const rows = await adapter.findMany({
      table: group.table,
      column: group.column,
      ids: [...distinct.values()],
      ...(group.scope !== undefined && { scope: group.scope }),
    });
    // Index by the key column. A row whose key column is SQL NULL/absent is NOT indexed — a
    // reference value can never legitimately be null (scalar-guarded), so a null-keyed row must
    // not be matchable (else a literal `"null"` string value could false-resolve against it).
    // Rows are frozen: a validator cannot mutate the snapshot a sibling check then reads.
    rowByValue = new Map();
    for (const row of rows) {
      const keyValue = row[group.column];
      if (keyValue === null || keyValue === undefined) continue;
      const k = valueKey(keyValue);
      if (!rowByValue.has(k)) rowByValue.set(k, Object.freeze(row));
    }
  } catch (cause) {
    // The adapter threw: availability, not correctness. Every member is UNAVAILABLE, NOT
    // "not found" — a transient blip must never reject a valid reference (issue #124 fix #5).
    for (const i of group.members) {
      const check = checks[i]!;
      verdicts[i] = {
        check,
        ok: false,
        status: 'unavailable',
        error: new CrossStoreError(
          CrossStoreErrorCode.ADAPTER_UNAVAILABLE,
          `store "${group.store}" was unavailable while resolving ${group.table}.${group.column}`,
          { store: group.store, table: group.table, column: group.column, cause: String(cause) },
        ),
      };
    }
    return;
  }

  for (const i of group.members) {
    const check = checks[i]!;
    const row = rowByValue.get(valueKey(check.value));
    if (!row) {
      verdicts[i] = {
        check,
        ok: false,
        status: 'not_found',
        error: new CrossStoreError(
          CrossStoreErrorCode.REFERENCE_NOT_FOUND,
          `no ${group.table}.${group.column} = ${valueKey(check.value)} in store "${group.store}"`,
          { store: group.store, table: group.table, column: group.column, value: check.value },
        ),
      };
      continue;
    }
    verdicts[i] = await runValidators(check, row, validators);
  }
}

/**
 * Run a check's named validators against its fetched row; first failure wins. Names are deduped
 * (a repeated name runs once). Semantics are **fail-closed**: only `true`, `undefined`, or `void`
 * accept the row; any other return value (including `false` and any falsy non-`false` value) or a
 * throw rejects it — so a mis-typed validator can never silently pass a bad reference.
 */
async function runValidators(
  check: ReferenceCheck,
  row: SnapshotRow,
  validators: ValidatorMap,
): Promise<ResolveVerdict> {
  for (const name of new Set(check.validators ?? [])) {
    // Presence guaranteed by the pre-flight in resolveReferences.
    const validator = validators[name]!;
    let result: boolean | void;
    try {
      result = await validator(row, check);
    } catch (cause) {
      return validatorFailure(check, row, name, `validator "${name}" threw`, cause);
    }
    if (result !== true && result !== undefined) {
      return validatorFailure(check, row, name, `validator "${name}" rejected the reference row`);
    }
  }
  return { check, ok: true, status: 'resolved', row };
}

function validatorFailure(
  check: ReferenceCheck,
  row: SnapshotRow,
  name: string,
  message: string,
  cause?: unknown,
): ResolveVerdict {
  return {
    check,
    ok: false,
    status: 'validator_failed',
    row,
    error: new CrossStoreError(CrossStoreErrorCode.VALIDATOR_FAILED, message, {
      validator: name,
      ...(cause !== undefined && { cause: String(cause) }),
    }),
  };
}

/**
 * Throw the first failure among `verdicts` (fail-closed helper for a write path). Returns the
 * verdicts unchanged when every check resolved, so callers can chain.
 */
export function assertAllResolved(verdicts: readonly ResolveVerdict[]): readonly ResolveVerdict[] {
  for (const verdict of verdicts) {
    if (!verdict.ok) {
      // A well-formed failed verdict always carries its error. The fallback must NOT invent a
      // code (a hardcoded REFERENCE_NOT_FOUND would collapse an `unavailable` verdict into
      // not_found — the one thing issue #124 fix #5 forbids); surface it as a malformed verdict.
      throw (
        verdict.error ??
        new CrossStoreError(
          CrossStoreErrorCode.INVALID_ARGUMENT,
          `verdict with status "${verdict.status}" is missing its error`,
          { status: verdict.status },
        )
      );
    }
  }
  return verdicts;
}

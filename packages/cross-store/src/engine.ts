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
  | 'misconfigured'
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
function valueKey(value: unknown, columnType?: string): string {
  const key = String(value);
  // Postgres matches some column types by a rule the raw driver value does not preserve, so keying
  // on the value verbatim makes a row the database DID match look missing:
  //   • `char(n)`/`bpchar` — equality ignores trailing blanks, but the driver returns the value
  //     space-padded ('AB' matches a char(8) row that comes back as 'AB      ').
  //   • `citext` — equality is case-insensitive, but the driver returns the stored casing.
  // Normalize the key the same way on BOTH the indexing and the lookup side.
  const base = columnType
    ?.toLowerCase()
    .replace(/\s*\(.*$/, '')
    .trim();
  if (base === 'char' || base === 'bpchar') return key.replace(/ +$/, '');
  if (base === 'citext') return key.toLowerCase();
  return key;
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
  // A `number` beyond the safe-integer range has already lost precision before it reaches us: two
  // distinct bigint ids can collapse onto the same double, so the lookup would silently resolve
  // against the WRONG row. NaN/Infinity stringify to keys that can never match anything.
  if (t === 'number' && !Number.isSafeInteger(value as number)) {
    const n = value as number;
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `${role} must be a safe-integer number (got ${String(n)}) — a value outside ` +
        `Number.MIN_SAFE_INTEGER..MAX_SAFE_INTEGER has already lost precision and could resolve ` +
        `against the wrong row; pass large ids as a string or bigint`,
      { role, value: String(n) },
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
  /** The registered key-column SQL type (from the registry entry), threaded to `findMany`. */
  readonly columnType?: string;
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
    let entry;
    try {
      entry = registry.assertScopeAllowed(ref, scopeColumnsOf(check));
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
        // columnType is a property of the target (store,table,column) — every member of a group
        // shares it (they share the target); thread it from the registry entry to `findMany`.
        ...(entry.columnType !== undefined && { columnType: entry.columnType }),
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

/**
 * Postgres SQLSTATEs that mean "the referenced object does not exist" — a mis-declared registry
 * entry (wrong table/column/schema), NOT a transient outage. Deliberately an explicit allowlist, not
 * the whole SQLSTATE class 42: class 42 also includes `42501` (insufficient_privilege — a
 * grant/role-rotation issue that can be operational/transient) and `42601` (syntax_error — our bug,
 * not the caller's registry), which must NOT be labelled "check the registry declaration".
 */
/**
 * Postgres SQLSTATEs that mean "one of the supplied VALUES is not representable in the target
 * column's type" — e.g. a non-uuid string sent to a `uuid` column, or a number out of range. The
 * batch resolves every id for a group in ONE `= ANY($1::uuid[])` statement, so a single bad id makes
 * Postgres reject the WHOLE statement. That is a permanent, caller-side data error: classifying it
 * as a transient outage made the batch retryable forever and poisoned provably-valid siblings.
 */
const INVALID_VALUE_SQLSTATES: ReadonlySet<string> = new Set([
  '22P02', // invalid_text_representation (e.g. "not-a-uuid" for a uuid column)
  '22003', // numeric_value_out_of_range
]);

const MISCONFIGURED_SQLSTATES: ReadonlySet<string> = new Set([
  '42P01', // undefined_table
  '42703', // undefined_column
  '42883', // undefined_function
  '42704', // undefined_object
  '3F000', // invalid_schema_name
]);

/**
 * Extract a **permanent** "object does not exist" SQLSTATE ({@link MISCONFIGURED_SQLSTATES}) from a
 * caught adapter error, if present — the signal that the reference target is misconfigured (its
 * table/column/schema is absent), which a retry can never fix. Handles a direct pg / TypeORM driver
 * error (`.code` is the SQLSTATE; TypeORM's `QueryFailedError` copies the driver's `.code`) and a
 * Prisma `P2010` raw-query wrapper (the real code is in `.meta.code`, or embedded in the message as
 * ``Code: `42P01` ``). The message is consulted **only** for a Prisma-shaped error — parsing every
 * error's `.message` for a code would let a data-influenced message (e.g. `22P02`'s echoed value)
 * forge a false match. Returns `undefined` for anything else (a connection blip like `ECONNREFUSED`,
 * or a permission/syntax class-42), which stays {@link CrossStoreErrorCode.ADAPTER_UNAVAILABLE}.
 */
function permanentSqlState(cause: unknown): string | undefined {
  // Unwrap a shallow driver-error chain (TypeORM `.driverError`, a wrapped `.cause`) — bounded to a
  // few hops so a self-referential `.cause` can't loop. The first object carrying a usable code wins.
  let err = cause as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  for (let hop = 0; hop < 4 && err !== null && typeof err === 'object'; hop++) {
    const direct = typeof err.code === 'string' ? err.code.toUpperCase() : undefined;
    const isPrismaRaw =
      direct === 'P2010' ||
      (typeof err.message === 'string' && err.message.startsWith('Raw query failed'));
    const prismaMeta =
      isPrismaRaw && typeof err.meta?.code === 'string' ? err.meta.code.toUpperCase() : undefined;
    const fromMessage =
      isPrismaRaw && typeof err.message === 'string'
        ? /Code:\s*[`"']?(42[0-9A-Za-z]{3}|3F000)\b/i.exec(err.message)?.[1]?.toUpperCase()
        : undefined;
    // A message-derived code may only ever mean "misconfigured": an INVALID_VALUE state echoes the
    // offending value in its message, so honouring it here would let hostile data forge a code.
    const match =
      [direct, prismaMeta].find(
        (c): c is string =>
          c !== undefined && (MISCONFIGURED_SQLSTATES.has(c) || INVALID_VALUE_SQLSTATES.has(c)),
      ) ??
      (fromMessage !== undefined && MISCONFIGURED_SQLSTATES.has(fromMessage)
        ? fromMessage
        : undefined);
    if (match !== undefined) return match;
    const next =
      (err as { driverError?: unknown; cause?: unknown }).driverError ??
      (err as { cause?: unknown }).cause;
    err = next as typeof err;
  }
  return undefined;
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
  for (const i of group.members)
    distinct.set(valueKey(checks[i]!.value, group.columnType), checks[i]!.value);

  let rowByValue: Map<string, SnapshotRow>;
  try {
    const rows = await adapter.findMany({
      table: group.table,
      column: group.column,
      ids: [...distinct.values()],
      ...(group.scope !== undefined && { scope: group.scope }),
      ...(group.columnType !== undefined && { columnType: group.columnType }),
    });
    // Index by the key column. A row whose key column is SQL NULL/absent is NOT indexed — a
    // reference value can never legitimately be null (scalar-guarded), so a null-keyed row must
    // not be matchable (else a literal `"null"` string value could false-resolve against it).
    // Rows are frozen: a validator cannot mutate the snapshot a sibling check then reads.
    rowByValue = new Map();
    for (const row of rows) {
      const keyValue = row[group.column];
      if (keyValue === null || keyValue === undefined) continue;
      const k = valueKey(keyValue, group.columnType);
      if (!rowByValue.has(k)) rowByValue.set(k, Object.freeze(row));
    }
  } catch (cause) {
    // A PERMANENT "object does not exist" SQL error (undefined table/column/schema) means the
    // registry entry is mis-declared — a wiring bug that will never resolve on retry. Record a
    // `misconfigured` verdict (NOT a throw): the engine keeps its "one verdict per check, never
    // throws per-group" contract, so `resolveReferences` still returns the full array (healthy
    // groups' results survive) and the `verifyReferences` sweep never crashes. The WRITE path still
    // fails loud — `assertAllResolved`/`assertEntitiesResolved` throw on any non-`ok` verdict, so a
    // misconfigured verdict surfaces `REFERENCE_MISCONFIGURED` there. Distinct from `unavailable`
    // (retryable) so a sweep won't re-queue it forever.
    const sqlState = permanentSqlState(cause);
    const [code, status, reason] =
      sqlState !== undefined && INVALID_VALUE_SQLSTATES.has(sqlState)
        ? // A value that the target column's type cannot represent. PERMANENT (never retryable):
          // one malformed id rejects the whole batched statement, so report it as a wiring/data
          // error rather than an outage that a retry could clear.
          ([
            CrossStoreErrorCode.REFERENCE_MISCONFIGURED,
            'misconfigured',
            `received a value its column type cannot represent (SQL error ${sqlState}) — one malformed id rejects the whole batch; validate ids before resolving`,
          ] as const)
        : sqlState !== undefined
          ? ([
              CrossStoreErrorCode.REFERENCE_MISCONFIGURED,
              'misconfigured',
              `is misconfigured (SQL error ${sqlState}) — check the registry declaration matches the target schema`,
            ] as const)
          : // Otherwise a TRANSIENT failure: availability, not correctness — every member is
            // UNAVAILABLE, NOT "not found" (a blip must never reject a valid reference; #124 fix #5).
            ([CrossStoreErrorCode.ADAPTER_UNAVAILABLE, 'unavailable', `was unavailable`] as const);
    for (const i of group.members) {
      verdicts[i] = {
        check: checks[i]!,
        ok: false,
        status,
        error: new CrossStoreError(
          code,
          `reference target ${group.table}.${group.column} in store "${group.store}" ${reason}`,
          {
            store: group.store,
            table: group.table,
            column: group.column,
            ...(sqlState !== undefined && { sqlState }),
            cause: String(cause),
          },
        ),
      };
    }
    return;
  }

  for (const i of group.members) {
    const check = checks[i]!;
    const row = rowByValue.get(valueKey(check.value, group.columnType));
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

import { assertSafeIdentifier, quoteQualified, safeIdent } from '@blueprime/timescaledb-core';
import { CrossStoreError, CrossStoreErrorCode } from './errors.js';

/**
 * What {@link buildFindManySql} needs to build a single batched fetch. Mirrors
 * {@link FindManyInput} (see `types.ts`) — kept as a separate, narrower type here so this
 * module has no dependency on the resolve-engine types and can be used standalone by any
 * adapter.
 */
export interface BuildFindManySqlInput {
  /** Target table, optionally schema-qualified (`schema.table`). */
  readonly table: string;
  readonly column: string;
  readonly ids: readonly unknown[];
  readonly scope?: Readonly<Record<string, unknown>>;
}

/** A parameterized query ready to execute: `sql` with positional `$1..$N` placeholders and `params` bound in order. */
export interface BuiltFindManySql {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Validate a (possibly schema-qualified) table identifier — at most `schema.table`, every part
 * safe — against the conservative allow-list, then quote it. `quoteQualified` alone only
 * quotes — it does not allow-list — so this pairs it with `assertSafeIdentifier` per part
 * (issue #124 fix #4: this builder must not trust an already-registered caller and
 * re-validates independently). Mirrors the registry's own `assertTableIdent` shape check so a
 * caller using this builder outside the registry-gated `resolveReferences` path gets the same
 * guarantee.
 */
function assertAndQuoteQualifiedTable(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `table must be "name" or "schema.name", got: ${table}`,
      { table },
    );
  }
  for (const part of parts) assertSafeIdentifier(part, 'table identifier');
  return quoteQualified(table, 'table identifier');
}

/**
 * Build the shared, ORM-agnostic SQL for a `CrossStoreAdapter.findMany` batched fetch:
 * `SELECT * FROM <table> WHERE <column> = ANY($1) [AND <scopeCol> = $N ...]`.
 *
 * Every identifier that reaches the SQL text — the schema-qualified table, the reference
 * column, and every scope column — is validated (`assertSafeIdentifier`) and quoted
 * (`safeIdent`/`quoteQualified`) before concatenation; it is never interpolated raw. Every
 * value — the id array (`$1`) and each scope value (`$2..$N`) — is returned in `params` to be
 * bound by the caller's driver, never embedded in `sql`. Pure and side-effect free: any
 * `CrossStoreAdapter` (TypeORM's `dataSource.query(sql, params)`, Prisma's
 * `$queryRawUnsafe(sql, ...params)`, or a raw `pg` client) can execute the result directly.
 *
 * Scope columns are appended in `Object.entries` order (insertion order for a plain object),
 * so callers building `scope` from a sorted/stable source get deterministic placeholder
 * numbering; the SQL is correct regardless of order.
 */
export function buildFindManySql(input: BuildFindManySqlInput): BuiltFindManySql {
  const table = assertAndQuoteQualifiedTable(input.table);
  const column = safeIdent(input.column, 'reference column');

  const params: unknown[] = [[...input.ids]];
  const clauses = [`${column} = ANY($1)`];

  for (const [scopeCol, value] of Object.entries(input.scope ?? {})) {
    const quotedScopeCol = safeIdent(scopeCol, 'scope column');
    params.push(value);
    clauses.push(`${quotedScopeCol} = $${params.length}`);
  }

  return { sql: `SELECT * FROM ${table} WHERE ${clauses.join(' AND ')}`, params };
}

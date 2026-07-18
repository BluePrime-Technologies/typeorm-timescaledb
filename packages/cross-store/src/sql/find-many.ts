import { safeIdent, TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import type { FindManyInput } from '../types.js';

/** A parameterized SQL statement: `text` with `$1..$n` placeholders and the bound `params`. */
export interface FindManySql {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * Validate + quote a `table` or `schema.table` identifier, part-by-part (anti-injection).
 * Rejects 3+ parts explicitly: `"a"."b"."c"` is a composite-attribute reference to Postgres, not
 * a table — it would parse-error and mark the whole batch unavailable, so a rogue identifier must
 * be rejected up front rather than turned into a runtime failure. (The registry already enforces
 * this at registration; the builder re-enforces it as the driver-layer boundary.)
 */
function safeQualified(table: string, role: string): string {
  const parts = table.split('.');
  if (parts.length > 2) {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `${role} must be "table" or "schema.table", got: ${table}`,
      { role, identifier: table },
    );
  }
  return parts.map((part) => safeIdent(part, role)).join('.');
}

/**
 * Build the batched existence/snapshot query for a {@link FindManyInput}:
 *
 * ```sql
 * SELECT * FROM <table> WHERE <column> = ANY($1) [AND <scopeCol> = $2 ...]
 * ```
 *
 * This is the single SQL surface every store adapter shares, and the anti-injection boundary at
 * the driver layer (issue #124 fix #4): the target table (incl. `schema.table`), the reference
 * column, and every scope column are validated against the conservative allow-list AND quoted via
 * core `safeIdent`; the id array and every scope value are **bound** (`$1` = ids, `$2..$n` =
 * scope values), never interpolated. The engine has already registry-gated these identifiers, but
 * the adapter re-validates here so the SQL surface is safe on its own.
 *
 * `SELECT *` returns the full snapshot row so domain validators can inspect any column; the engine
 * indexes the rows by `column`. Callers should short-circuit an empty `ids` array before building.
 */
export function buildFindManySql(input: FindManyInput): FindManySql {
  const table = safeQualified(input.table, 'reference table');
  const column = safeIdent(input.column, 'reference column');
  // Native `= ANY($1)` (no `::text[]` cast) so a btree index on the key column is usable. The
  // tradeoff: one type-incompatible id in a batch makes pg reject the whole statement (22P02) →
  // the group is ADAPTER_UNAVAILABLE. Batch-splitting to isolate the poison value was consciously
  // rejected — it would force `col::text` and defeat the index on the resolve hot path. A typed FK
  // column always holds type-compatible values in the real write path.
  const params: unknown[] = [input.ids];
  const conditions = [`${column} = ANY($1)`];
  if (input.scope) {
    for (const scopeColumn of Object.keys(input.scope)) {
      const quoted = safeIdent(scopeColumn, 'scope column');
      params.push(input.scope[scopeColumn]);
      conditions.push(`${quoted} = $${params.length}`);
    }
  }
  return { text: `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')}`, params };
}

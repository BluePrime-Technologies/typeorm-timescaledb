import { safeIdent, TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import type { FindManyInput } from '../types.js';

/** A parameterized SQL statement: `text` with `$1..$n` placeholders and the bound `params`. */
export interface FindManySql {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** Options for {@link buildFindManySql}. */
export interface BuildFindManyOptions {
  /**
   * Compare the key + scope columns as text (`col::text = ANY($1)`, `scopeCol::text = $n`) and bind
   * every value as a string. Required for drivers that bind parameters **type-strictly**: Prisma
   * sends a JS string as `text`, and Postgres has no implicit `text`→`uuid` (etc.) cast, so a
   * native `uuid = ANY($1)` raw query fails (`P2010`). Casting the column to text makes the filter
   * universally type-compatible and matches the resolver's `String()` equality — at the cost of a
   * btree index on the compared columns. Default `false` (native typing, index-friendly), which
   * suits node-pg / TypeORM (they bind untyped text and let Postgres infer the column type).
   */
  readonly compareAsText?: boolean;
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
 * With `compareAsText` the columns are cast to text (`<column>::text = ANY($1)`) and every value
 * is bound as a string — see {@link BuildFindManyOptions.compareAsText} (the Prisma path).
 *
 * `SELECT *` returns the full snapshot row so domain validators can inspect any column; the engine
 * indexes the rows by `column`. Callers should short-circuit an empty `ids` array before building.
 */
export function buildFindManySql(
  input: FindManyInput,
  options: BuildFindManyOptions = {},
): FindManySql {
  const asText = options.compareAsText === true;
  const table = safeQualified(input.table, 'reference table');
  const column = safeIdent(input.column, 'reference column');
  // Native `= ANY($1)` (no cast) keeps a btree index on the key column usable (node-pg/TypeORM
  // bind untyped text, so Postgres infers the column type). The tradeoff: one type-incompatible id
  // in a batch makes pg reject the whole statement (22P02) → the group is ADAPTER_UNAVAILABLE.
  // With `compareAsText` we cast the column to text and bind string values — universal, but no
  // index — because a type-strict driver (Prisma) cannot rely on that inference. This compares the
  // caller's String(value) to Postgres's canonical text rendering, so a non-canonical value (e.g.
  // an UPPERCASE uuid, since `uuid::text` is lowercase) resolves to not_found — the SAME verdict
  // the native path gives, because the engine's post-fetch match is also String()-keyed (see
  // ReferenceCheck.value). The index sacrifice is only necessary while the registry carries no
  // per-column SQL type; a future `columnType` would let us cast the *param* (`= ANY($1::uuid[])`),
  // keeping the index and canonicalizing the input — a deliberate deferral, not a hard constraint.
  const cast = asText ? '::text' : '';
  const ids = asText ? input.ids.map((v) => String(v)) : input.ids;
  const params: unknown[] = [ids];
  const conditions = [`${column}${cast} = ANY($1)`];
  if (input.scope) {
    for (const scopeColumn of Object.keys(input.scope)) {
      const quoted = safeIdent(scopeColumn, 'scope column');
      const raw = input.scope[scopeColumn];
      params.push(asText ? String(raw) : raw);
      conditions.push(`${quoted}${cast} = $${params.length}`);
    }
  }
  return { text: `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')}`, params };
}

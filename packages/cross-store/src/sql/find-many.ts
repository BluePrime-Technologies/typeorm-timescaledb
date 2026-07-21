import { safeIdent, TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';
import type { FindManyInput } from '../types.js';
import { safeColumnType } from './column-type.js';

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
  // Key-column comparison, three modes:
  //  - `columnType` given → **param-cast**: `<col> = ANY($1::<type>[])`. Casts the PARAM, not the
  //    column, so the column's btree index stays usable AND a type-strict driver (Prisma, which
  //    binds a JS string as `text`) works because the array is explicitly typed. Values are bound as
  //    strings; the `::<type>[]` cast converts + canonicalizes them (safeColumnType allowlists the
  //    type — it is interpolated, never bound). This is the preferred path.
  //  - `compareAsText` (no columnType) → `<col>::text = ANY($1)`, string-bound: universal for a
  //    type-strict driver but sacrifices the index (casts the column). Compares String(value) to
  //    Postgres's canonical text rendering.
  //  - neither → native `<col> = ANY($1)`: node-pg/TypeORM bind untyped text and Postgres infers the
  //    column type; index-friendly, but one type-incompatible id (22P02) rejects the whole batch.
  // In every mode the engine's post-fetch match is also String()-keyed, so a non-canonical input
  // (e.g. an UPPERCASE uuid) resolves to the same `not_found` verdict regardless of mode.
  const columnType = input.columnType !== undefined ? safeColumnType(input.columnType) : undefined;
  let keyCondition: string;
  let ids: readonly unknown[];
  if (columnType !== undefined) {
    keyCondition = `${column} = ANY($1::${columnType}[])`;
    ids = input.ids.map((v) => String(v));
  } else if (asText) {
    keyCondition = `${column}::text = ANY($1)`;
    ids = input.ids.map((v) => String(v));
  } else {
    keyCondition = `${column} = ANY($1)`;
    ids = input.ids;
  }
  // Scope columns are governed by `compareAsText` only (they carry no declared per-column type):
  // text-cast + string-bind under Prisma, native bind otherwise. Independent of the key's columnType.
  const scopeCast = asText ? '::text' : '';
  const params: unknown[] = [ids];
  const conditions = [keyCondition];
  if (input.scope) {
    for (const scopeColumn of Object.keys(input.scope)) {
      const quoted = safeIdent(scopeColumn, 'scope column');
      const raw = input.scope[scopeColumn];
      params.push(asText ? String(raw) : raw);
      conditions.push(`${quoted}${scopeCast} = $${params.length}`);
    }
  }
  return { text: `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')}`, params };
}

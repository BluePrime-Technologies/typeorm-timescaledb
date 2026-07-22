import { CrossStoreError, CrossStoreErrorCode } from '../errors.js';

/**
 * Base SQL scalar types allowed for a reference key's `columnType`. A `columnType` is interpolated
 * into SQL as a cast target (`$1::<type>[]`) — it CANNOT be a bound parameter (Postgres does not
 * parameterize type names) — so it MUST be an allowlisted literal, never caller-controlled free
 * text. Deliberately conservative: the realistic set of reference-key column types (uuid, the
 * integer family, the text family, numeric, boolean). Type *modifiers* (a length/precision such as
 * `varchar(255)` or `numeric(10,2)`) are irrelevant to an equality cast and are NOT accepted — pass
 * the base type name.
 */
const SAFE_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'uuid',
  'text',
  'varchar',
  'citext',
  'char',
  'bpchar',
  'name',
  'smallint',
  'int2',
  'int',
  'integer',
  'int4',
  'bigint',
  'int8',
  'numeric',
  'decimal',
  'bool',
  'boolean',
]);

/**
 * Validate a registry `columnType` against {@link SAFE_COLUMN_TYPES} and return its canonical
 * (lower-cased, trimmed) form — the only value ever interpolated into SQL as a cast target. Throws
 * `INVALID_ARGUMENT` for anything not allowlisted, so a bad/hostile type fails at registration (and
 * again at the driver boundary), never reaching the database.
 */
export function safeColumnType(columnType: string): string {
  const canonical = typeof columnType === 'string' ? columnType.trim().toLowerCase() : '';
  if (!SAFE_COLUMN_TYPES.has(canonical)) {
    throw new CrossStoreError(
      CrossStoreErrorCode.INVALID_ARGUMENT,
      `columnType "${String(columnType)}" is not an allowed reference-key type (base scalar types only, e.g. uuid, bigint, integer, text, varchar)`,
      { columnType },
    );
  }
  return canonical;
}

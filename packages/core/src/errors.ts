/**
 * Stable, documented error codes. These are part of the public contract — once
 * shipped, a code's meaning must not change (only new codes may be added).
 */
export const TimescaleErrorCode = {
  /** An identifier (table/column) failed allow-list / safety validation. */
  UNSAFE_IDENTIFIER: 'TSDB_UNSAFE_IDENTIFIER',
  /** A caller-supplied SQL expression FRAGMENT carried a statement separator or comment opener
   * at top level. Distinct from UNSAFE_IDENTIFIER: a fragment is composed SQL text, not a name,
   * and reporting it as an identifier problem misdirects whoever reads the log. */
  UNSAFE_FRAGMENT: 'TSDB_UNSAFE_FRAGMENT',
  /** A required timescaledb_toolkit function was used but the extension is absent. */
  TOOLKIT_MISSING: 'TSDB_TOOLKIT_MISSING',
  /** A hypertable-scoped operation was requested but the `timescaledb` extension is absent. */
  TIMESCALEDB_MISSING: 'TSDB_TIMESCALEDB_MISSING',
  /** Live DB schema does not match the entity metadata (drift). */
  SCHEMA_DRIFT: 'TSDB_SCHEMA_DRIFT',
  /** A hypertable primary key does not include the partition (time) column. */
  INVALID_HYPERTABLE_PK: 'TSDB_INVALID_HYPERTABLE_PK',
  /** A `@Hypertable` entity declares no time/partition column. */
  NO_TIME_COLUMN: 'TSDB_NO_TIME_COLUMN',
  /** `@Hypertable` options failed schema validation. */
  INVALID_HYPERTABLE_CONFIG: 'TSDB_INVALID_HYPERTABLE_CONFIG',
  /** A repository/operation was requested for an entity that is not a `@Hypertable`. */
  NOT_A_HYPERTABLE: 'TSDB_NOT_A_HYPERTABLE',
  /** An argument was the wrong type (e.g. an entity name/schema where the class is required). */
  INVALID_ARGUMENT: 'TSDB_INVALID_ARGUMENT',
} as const;

export type TimescaleErrorCode = (typeof TimescaleErrorCode)[keyof typeof TimescaleErrorCode];

export class TimescaleError extends Error {
  readonly code: TimescaleErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: TimescaleErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TimescaleError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

/**
 * Stable, documented error codes. These are part of the public contract — once
 * shipped, a code's meaning must not change (only new codes may be added).
 */
export const TimescaleErrorCode = {
  /** An identifier (table/column) failed allow-list / safety validation. */
  UNSAFE_IDENTIFIER: 'TSDB_UNSAFE_IDENTIFIER',
  /** A required timescaledb_toolkit function was used but the extension is absent. */
  TOOLKIT_MISSING: 'TSDB_TOOLKIT_MISSING',
  /** Live DB schema does not match the entity metadata (drift). */
  SCHEMA_DRIFT: 'TSDB_SCHEMA_DRIFT',
  /** A hypertable primary key does not include the partition (time) column. */
  INVALID_HYPERTABLE_PK: 'TSDB_INVALID_HYPERTABLE_PK',
  /** A `@Hypertable` entity declares no time/partition column. */
  NO_TIME_COLUMN: 'TSDB_NO_TIME_COLUMN',
  /** `@Hypertable` options failed schema validation. */
  INVALID_HYPERTABLE_CONFIG: 'TSDB_INVALID_HYPERTABLE_CONFIG',
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

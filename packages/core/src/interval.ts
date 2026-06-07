import { TimescaleError, TimescaleErrorCode } from './errors.js';

/**
 * A PostgreSQL interval of the form `<n> <unit>`, e.g. `'7 days'`.
 *
 * These values are emitted into DDL (`INTERVAL '7 days'`), so they are validated
 * to a conservative `<n> <unit>` shape rather than accepting arbitrary interval
 * strings. This is the single source of truth for interval validation — the Zod
 * metadata schema and the SQL builders both use it.
 */
export const INTERVAL_PATTERN =
  /^\d+\s+(microsecond|millisecond|second|minute|hour|day|week|month|year)s?$/i;

/**
 * Validate a PostgreSQL interval string (`<n> <unit>`), returning it unchanged.
 *
 * This checks shape only — numeric magnitude is delegated to PostgreSQL, which is
 * the final authority (an out-of-range value like `99999999999999999999 days`
 * is well-formed here and rejected by PG at execution time).
 *
 * @throws {TimescaleError} `TSDB_INVALID_ARGUMENT` if the value is not a conservative interval.
 */
export function assertInterval(value: string, role = 'interval'): string {
  if (typeof value !== 'string' || !INTERVAL_PATTERN.test(value)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a PostgreSQL interval like "7 days" (<n> <unit>), got: ${String(value)}`,
      { role, value: String(value) },
    );
  }
  return value;
}

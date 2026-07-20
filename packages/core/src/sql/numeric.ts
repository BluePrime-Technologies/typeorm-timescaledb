import { TimescaleError, TimescaleErrorCode } from '../errors.js';

/**
 * Validate and render a finite JS number as a SQL numeric literal. A finite number's `String()`
 * form is ALWAYS a valid PostgreSQL numeric literal — including exponent notation (`1e-7`,
 * `1e+21`), which PostgreSQL parses — and it carries zero injection surface (a `number`
 * stringifies only to `[-0-9.eE+]`, never user text). This is the single shared helper for both
 * the base-hyperfunction and toolkit builders; do NOT reject exponent forms (that wrongly refuses
 * legitimate tiny/huge bounds such as a `histogram(col, 1e-7, 1, …)` min).
 *
 * @throws {TimescaleError} `TSDB_INVALID_ARGUMENT` if `value` is not a finite number.
 */
export function numericLiteral(value: number, role: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a finite number, got: ${String(value)}`,
      { role, value: String(value) },
    );
  }
  return String(value);
}

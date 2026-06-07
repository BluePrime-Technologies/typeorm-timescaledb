import { TimescaleError, TimescaleErrorCode } from './errors.js';

/** True if the string contains any ASCII control character (0x00–0x1F) or DEL (0x7F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Returns a safely single-quoted SQL string literal, equivalent to PostgreSQL's
 * `quote_literal()` / `format('%L', ...)`. Embedded single-quotes are doubled.
 *
 * Use this for values that reach SQL in a **string-literal** position — e.g. the
 * `regclass` argument of `create_hypertable('schema.table', ...)`, the column name
 * inside `by_range('time', ...)`, or the `timescaledb.segmentby = '...'` reloption.
 * For values in an **identifier** position (`ALTER TABLE "table"`) use
 * {@link quoteIdent}/{@link quoteQualified} instead.
 *
 * Safe regardless of the server's `standard_conforming_strings` setting: if the
 * value contains a backslash, the explicit escape-string form `E'…'` is emitted
 * (with backslashes doubled), matching libpq's `PQescapeLiteral`. This prevents a
 * `\` from combining with a doubled quote to terminate the literal early when
 * `standard_conforming_strings = off`.
 *
 * @throws {TimescaleError} `TSDB_INVALID_ARGUMENT` if the value contains control characters.
 */
export function quoteLiteral(value: string, role = 'value'): string {
  if (typeof value !== 'string') {
    throw new TimescaleError(TimescaleErrorCode.INVALID_ARGUMENT, `${role} must be a string`, {
      role,
    });
  }
  if (hasControlChar(value)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must not contain control characters or null bytes`,
      { role },
    );
  }
  const quotesEscaped = value.replace(/'/g, "''");
  if (value.includes('\\')) {
    return `E'${quotesEscaped.replace(/\\/g, '\\\\')}'`;
  }
  return `'${quotesEscaped}'`;
}

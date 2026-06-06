import { TimescaleError, TimescaleErrorCode } from './errors.js';

/** PostgreSQL identifiers are limited to 63 bytes (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_BYTES = 63;

/** Conservative unquoted-identifier shape: letter/underscore, then word chars or `$`. */
const SAFE_UNQUOTED = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

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

function assertString(value: string, role: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `${role} must be a non-empty string`,
      { role },
    );
  }
  if (hasControlChar(value)) {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `${role} must not contain control characters or null bytes`,
      { role },
    );
  }
  if (byteLength(value) > MAX_IDENTIFIER_BYTES) {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `${role} exceeds PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit`,
      { role, identifier: value },
    );
  }
}

/**
 * Throws if `identifier` is not a safe, conservative SQL identifier.
 *
 * This is the anti-injection boundary: dynamic table/column names CANNOT be
 * passed as bound parameters, so every identifier that reaches SQL must pass
 * through here (or {@link quoteIdent}) — never string concatenation of raw input.
 */
export function assertSafeIdentifier(identifier: string, role = 'identifier'): string {
  assertString(identifier, role);
  if (!SAFE_UNQUOTED.test(identifier)) {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `${role} "${identifier}" is not a safe identifier (allowed: letters, digits, underscore, $; must not start with a digit)`,
      { role, identifier },
    );
  }
  return identifier;
}

/**
 * Returns a safely double-quoted identifier, equivalent to PostgreSQL's
 * `quote_ident()` / `format('%I', ...)`. Embedded double-quotes are doubled.
 * Rejects control characters and over-length identifiers.
 */
export function quoteIdent(identifier: string, role = 'identifier'): string {
  assertString(identifier, role);
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Quotes a possibly-qualified identifier (`schema.table`) part-by-part.
 * Each part is validated/quoted independently so a dot inside a part cannot
 * smuggle extra qualification.
 */
export function quoteQualified(qualified: string, role = 'identifier'): string {
  return qualified
    .split('.')
    .map((part) => quoteIdent(part, role))
    .join('.');
}

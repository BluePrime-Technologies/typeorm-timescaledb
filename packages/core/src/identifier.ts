import { TimescaleError, TimescaleErrorCode } from './errors.js';
import { findUnquotedToken } from './sql-lex.js';

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
 *
 * ⚠️ This only QUOTES — it does NOT enforce the conservative allow-list. Quoting
 * neutralizes injection, but a string like `id, (SELECT …)` becomes a single
 * (bizarre) quoted identifier rather than being rejected. For any **untrusted /
 * user-supplied** identifier use {@link safeIdent}; reserve `quoteIdent` for
 * identifiers you already trust but that need quoting (mixed case, reserved words).
 */
export function quoteIdent(identifier: string, role = 'identifier'): string {
  assertString(identifier, role);
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Quotes a possibly-qualified identifier (`schema.table`) part-by-part.
 * Each part is validated/quoted independently so a dot inside a part cannot
 * smuggle extra qualification. Rejects 3+ parts: no PostgreSQL object in this
 * library is more qualified than `schema.table`, so `a.b.c` is a malformed input,
 * not a valid identifier (mirrors the cap in `parseTable`).
 */
export function quoteQualified(qualified: string, role = 'identifier'): string {
  const parts = qualified.split('.');
  if (parts.length > 2) {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_IDENTIFIER,
      `${role} must be "name" or "schema.name", got: ${qualified}`,
      { role, identifier: qualified },
    );
  }
  return parts.map((part) => quoteIdent(part, role)).join('.');
}

/**
 * The safe-by-default primitive for an **untrusted / user-supplied** dynamic
 * identifier (table, column, or scope name): validate against the conservative
 * allow-list ({@link assertSafeIdentifier}) AND quote the result.
 *
 * Dynamic identifiers cannot be bound SQL parameters, so every user-supplied
 * identifier that reaches SQL must pass through here — never `quoteIdent` alone
 * (which quotes but does not allow-list) and never string concatenation.
 *
 * @throws {TimescaleError} `TSDB_UNSAFE_IDENTIFIER` if the identifier is not allow-listed.
 */
export function safeIdent(identifier: string, role = 'identifier'): string {
  return quoteIdent(assertSafeIdentifier(identifier, role), role);
}

/**
 * Tokens that must not appear at TOP LEVEL in an expression fragment: a statement separator, and
 * both comment openers. Order is not significant — the lexer tests every token at each position.
 */
const DANGEROUS_FRAGMENT_TOKENS = [';', '--', '/*'] as const;

/**
 * Defence-in-depth for the COMPOSED-FRAGMENT surface: ~25 public expression helpers take an
 * already-built SQL fragment (`locf(expr)`, `candlestickAccessorExpr(agg)`, …) and wrap it verbatim.
 *
 * The contract is coherent — the intended producers (`candlestickAggExpr`, `statsAgg1DExpr`, …) all
 * run their columns through {@link safeIdent}, and no internal caller feeds unvalidated text in. But
 * it is the largest raw-string surface in a public library and, until now, the contract lived only in
 * prose. This does not replace that contract; it refuses the shapes that could only be an injection
 * or a mistake, so a caller who violates the contract gets an error here instead of a surprise in
 * their database.
 *
 * Deliberately NOT a SQL parser. It rejects statement separators and comment introducers — the
 * constructs that let a fragment stop being an expression — and nothing else, so every legitimate
 * expression (function calls, casts, string literals, arithmetic) still passes.
 *
 * The compile-time version of this is a branded `SafeSqlFragment` returned by the agg builders and
 * required by the accessors. That is a breaking change to ~25 signatures, so it belongs to 1.0, not
 * to a minor.
 */
export function assertSafeFragment(fragment: string, role: string): string {
  if (typeof fragment !== 'string' || fragment.length === 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} must be a non-empty SQL expression fragment`,
      { role },
    );
  }
  // `;` ends a statement; the two comment openers each swallow the rest of the generated expression.
  //
  // Scanned with the shared lexer rather than tested against the raw text, because these three CAN
  // appear in a legitimate expression — inside a literal. `string_agg(message, '--')` and
  // `count(*) FILTER (WHERE tag <> 'a;b')` are valid SQL, and the first version of this guard
  // rejected both while reporting a reason that was false. Only a top-level occurrence is dangerous.
  const found = findUnquotedToken(fragment, DANGEROUS_FRAGMENT_TOKENS);
  if (found.kind === 'found') {
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_FRAGMENT,
      `${role} contains ${JSON.stringify(found.token)} at offset ${found.index}, outside any ` +
        `literal or comment, where it would ${found.token === ';' ? 'end the statement' : 'comment out the rest of the expression'}. ` +
        `Build it from the aggregate helpers (e.g. candlestickAggExpr, statsAgg1DExpr) rather than ` +
        `assembling SQL text by hand.`,
      { role, value: fragment },
    );
  }
  if (found.kind === 'unterminated') {
    // An unterminated literal or block comment hides whatever this fragment is composed into, which
    // is the same swallowing failure by a different route.
    throw new TimescaleError(
      TimescaleErrorCode.UNSAFE_FRAGMENT,
      `${role} ends inside an unterminated string literal, quoted identifier, block comment or ` +
        `dollar-quoted block, so anything composed after it would be swallowed.`,
      { role, value: fragment },
    );
  }
  return fragment;
}

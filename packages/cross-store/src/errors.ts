/**
 * Stable, documented error codes for cross-store reference resolution. These are part
 * of the public contract — once shipped, a code's meaning must not change (only new
 * codes may be added).
 *
 * The critical distinction (issue #124 fix #5) is `ADAPTER_UNAVAILABLE` vs
 * `REFERENCE_NOT_FOUND`: availability is not correctness. A transient failure to reach
 * the referenced store must NOT be reported as "the reference does not exist" — that
 * would reject a perfectly valid write during a DB blip.
 */
export const CrossStoreErrorCode = {
  /** The referenced value was fetched and is genuinely absent in the target store. */
  REFERENCE_NOT_FOUND: 'XS_REFERENCE_NOT_FOUND',
  /** The reference target `(store, table, column)` is not in the allowed-reference registry. */
  REFERENCE_NOT_ALLOWED: 'XS_REFERENCE_NOT_ALLOWED',
  /** The target store could not be reached / queried (a blip — NOT a missing reference). */
  ADAPTER_UNAVAILABLE: 'XS_ADAPTER_UNAVAILABLE',
  /** A scope column used to filter the reference is not allowlisted for this target. */
  SCOPE_VIOLATION: 'XS_SCOPE_VIOLATION',
  /** A named domain validator rejected the fetched reference row. */
  VALIDATOR_FAILED: 'XS_VALIDATOR_FAILED',
  /** An argument was the wrong type/shape (e.g. no adapter registered for a store). */
  INVALID_ARGUMENT: 'XS_INVALID_ARGUMENT',
} as const;

export type CrossStoreErrorCode = (typeof CrossStoreErrorCode)[keyof typeof CrossStoreErrorCode];

/**
 * An error raised by the cross-store resolver. Carries a stable {@link CrossStoreErrorCode}
 * and a frozen `context` bag for diagnostics. Mirrors the core `TimescaleError` shape so
 * the two packages present a consistent error surface.
 */
export class CrossStoreError extends Error {
  readonly code: CrossStoreErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: CrossStoreErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CrossStoreError';
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

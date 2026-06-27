import { safeIdent, TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';

/** Standard SQL aggregates this package builds safely (allow-listed). */
export type StandardAggregate = 'avg' | 'sum' | 'min' | 'max' | 'count';

const STANDARD_AGGREGATES: ReadonlySet<string> = new Set(['avg', 'sum', 'min', 'max', 'count']);

/**
 * Build a safe standard-aggregate SQL fragment: the function is allow-listed and the
 * column flows through {@link safeIdent}. `count` with no column → `count(*)`.
 *
 * Shared by `getTimeBucket` and the `TimescaleQueryBuilder` gapfill wrappers so the
 * allow-list lives in exactly one place.
 */
export function standardAggregateExpr(fn: string, column?: string): string {
  // SQL function names are case-insensitive; normalize so `AVG`/`Sum` are accepted.
  const f = String(fn).toLowerCase();
  if (!STANDARD_AGGREGATES.has(f)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unsupported aggregate "${String(fn)}"`,
      { fn: String(fn) },
    );
  }
  if (f === 'count' && (column === undefined || column === '')) {
    return 'count(*)';
  }
  if (column === undefined || column === '') {
    throw new TimescaleError(TimescaleErrorCode.INVALID_ARGUMENT, `${f} requires a column`, {
      fn: f,
    });
  }
  return `${f}(${safeIdent(column, `${f} column`)})`;
}

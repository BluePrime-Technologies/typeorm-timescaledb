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
  if (!STANDARD_AGGREGATES.has(fn)) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `unsupported aggregate "${String(fn)}"`,
      { fn: String(fn) },
    );
  }
  if (fn === 'count' && (column === undefined || column === '')) {
    return 'count(*)';
  }
  if (column === undefined || column === '') {
    throw new TimescaleError(TimescaleErrorCode.INVALID_ARGUMENT, `${fn} requires a column`, {
      fn,
    });
  }
  return `${fn}(${safeIdent(column, `${fn} column`)})`;
}

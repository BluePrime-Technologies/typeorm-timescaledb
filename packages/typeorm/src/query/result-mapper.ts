import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';

/**
 * Coercion helpers for **raw** hyperfunction results.
 *
 * The `pg` driver returns `numeric`/`decimal`/`bigint` as **strings** (to preserve
 * precision) and `double precision` as a JS `number`. Aggregate results therefore
 * come back with mixed types, so a typed mapper must coerce explicitly rather than
 * trust the row shape. These helpers make that safe and intention-revealing.
 */

/** Coerce a raw aggregate cell to a finite `number`. Throws on non-numeric input. */
export function toNumber(value: unknown, role = 'value'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `${role} is not a finite number`,
        { role, value: String(value) },
      );
    }
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new TimescaleError(
    TimescaleErrorCode.INVALID_ARGUMENT,
    `${role} could not be coerced to a number: ${String(value)}`,
    { role, value: String(value) },
  );
}

/** Like {@link toNumber} but passes SQL `NULL` through as `null`. */
export function toNumberOrNull(value: unknown, role = 'value'): number | null {
  return value === null || value === undefined ? null : toNumber(value, role);
}

/**
 * Keep a `bigint`/`count` result as a **string** to avoid precision loss past
 * `Number.MAX_SAFE_INTEGER` (e.g. `approx_count_distinct` over a huge cardinality).
 */
export function toBigIntString(value: unknown, role = 'value'): string {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return String(value);
  }
  throw new TimescaleError(
    TimescaleErrorCode.INVALID_ARGUMENT,
    `${role} is not an integer value: ${String(value)}`,
    { role, value: String(value) },
  );
}

/** Coerce a raw timestamp cell (Date or ISO string) to a `Date`. */
export function toDate(value: unknown, role = 'value'): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  throw new TimescaleError(
    TimescaleErrorCode.INVALID_ARGUMENT,
    `${role} could not be coerced to a Date: ${String(value)}`,
    { role, value: String(value) },
  );
}

/** Coerce a `histogram(...)` result (`int[]`) to `number[]`. */
export function toNumberArray(value: unknown, role = 'value'): number[] {
  if (Array.isArray(value)) {
    return value.map((v, i) => toNumber(v, `${role}[${i}]`));
  }
  throw new TimescaleError(
    TimescaleErrorCode.INVALID_ARGUMENT,
    `${role} is not an array: ${String(value)}`,
    { role, value: String(value) },
  );
}

/** Map raw rows through a typed mapper — a thin, explicit alternative to `rows.map`. */
export function mapRawRows<R, M>(rows: readonly R[], map: (row: R, index: number) => M): M[] {
  return rows.map((row, index) => map(row, index));
}

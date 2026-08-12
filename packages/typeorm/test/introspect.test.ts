import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { introspect, TimescaleError, TimescaleErrorCode } from '../src/index.js';

interface StubState {
  /** Whether `pg_extension` reports `timescaledb` installed. Defaults to `true`. */
  extensionPresent?: boolean;
}

interface RunnerCalls {
  rollbackCalled: boolean;
  releaseCalled: boolean;
}

/**
 * A `createQueryRunner()`-based stub, matching `introspect()`'s actual query surface (unlike
 * `assertSchema()`, it never calls `dataSource.query()` directly). Every catalog query beyond
 * `pg_extension` returns empty rows — sufficient for the fail-fast and happy-path cases below,
 * which don't need populated hypertables/CAGGs.
 */
function stubDataSource(
  state: StubState = {},
  initialized = true,
): { ds: DataSource; calls: RunnerCalls } {
  const calls: RunnerCalls = { rollbackCalled: false, releaseCalled: false };
  const runner = {
    connect: async () => {},
    startTransaction: async () => {},
    rollbackTransaction: async () => {
      calls.rollbackCalled = true;
    },
    release: async () => {
      calls.releaseCalled = true;
    },
    get isTransactionActive() {
      // introspect() always rolls back (read-only, no side effects to persist) — true throughout,
      // so the `finally` block's rollback is exercised on both the happy path and the new
      // fail-fast path.
      return true;
    },
    query: async (sql: string): Promise<unknown[]> => {
      if (sql.includes('pg_extension')) {
        return state.extensionPresent === false ? [] : [{ extversion: '2.18.0' }];
      }
      // SET LOCAL and every other catalog query (hypertables/dimensions/columnstore/jobs/caggs).
      return [];
    },
  };
  const ds = {
    isInitialized: initialized,
    createQueryRunner: () => runner,
  } as unknown as DataSource;
  return { ds, calls };
}

describe('introspect', () => {
  it('rejects an uninitialized DataSource', async () => {
    const { ds } = stubDataSource({}, false);
    try {
      await introspect(ds);
      throw new Error('expected INVALID_ARGUMENT');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.INVALID_ARGUMENT,
      );
    }
  });

  it('throws TimescaleError(TIMESCALEDB_MISSING) when the timescaledb extension is absent', async () => {
    // Regression for the raw-DB-error bug: against a plain Postgres database, the four catalog
    // queries below this check would otherwise throw an unhandled
    // `relation "timescaledb_information.hypertables" does not exist`.
    const { ds, calls } = stubDataSource({ extensionPresent: false });
    try {
      await introspect(ds);
      throw new Error('expected TIMESCALEDB_MISSING');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.TIMESCALEDB_MISSING,
      );
      expect((e as Error).message).toContain('CREATE EXTENSION timescaledb');
    }
    // The transaction must be rolled back and the connection released, not left dangling, even on
    // this early-exit path — proves the throw happens inside the existing try/finally, not before it.
    expect(calls.rollbackCalled).toBe(true);
    expect(calls.releaseCalled).toBe(true);
  });

  it('returns an empty SchemaStateIR when the extension is present but nothing is declared', async () => {
    const { ds, calls } = stubDataSource({ extensionPresent: true });
    const ir = await introspect(ds);
    expect(ir.hypertables).toEqual([]);
    expect(ir.continuousAggregates).toEqual([]);
    expect(ir.timescaledbVersion).toBe('2.18.0');
    // Read-only: still rolls back even though nothing failed.
    expect(calls.rollbackCalled).toBe(true);
    expect(calls.releaseCalled).toBe(true);
  });
});

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { introspect, TimescaleError, TimescaleErrorCode } from '../src/index.js';

interface StubState {
  /** Whether `pg_extension` reports `timescaledb` installed. Defaults to `true`. */
  extensionPresent?: boolean;
  /** Rows for `timescaledb_information.hypertables`. */
  hypertables?: Array<{ hypertable_schema: string; hypertable_name: string }>;
  /** Rows for `_timescaledb_catalog.compression_settings`. */
  columnstore?: Array<Record<string, unknown>>;
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
      // `compression_settings` FIRST: COLUMNSTORE_SQL joins timescaledb_information.hypertables, so
      // matching on the hypertables view first would hand the columnstore query the wrong rows.
      if (sql.includes('compression_settings')) return state.columnstore ?? [];
      if (sql.includes('timescaledb_information.hypertables')) return state.hypertables ?? [];
      // SET LOCAL and every other catalog query (dimensions/jobs/caggs).
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

  it('keeps two objects distinct when their schema/name would concatenate identically', async () => {
    // Regression. The (schema, name) Map key uses a `\0` separator precisely because a NUL cannot
    // occur in a PostgreSQL identifier. A space CAN — `CREATE SCHEMA "public a"` and
    // `CREATE TABLE public."a b"` both succeed, and both were created on a live server to confirm
    // it — so a space separator makes `("public a", "b")` and `("public", "a b")` collide into the
    // single key `public a b`.
    //
    // The consequence is silent and wrong rather than loud: columnstore config, and every policy
    // keyed the same way, gets attached to whichever object the lookup happens to find. This test
    // exists because a proposed change swapped the separator for a space, and the file was binary to
    // git at the time, so the change produced no reviewable diff at all.
    const { ds } = stubDataSource({
      hypertables: [
        { hypertable_schema: 'public a', hypertable_name: 'b' },
        { hypertable_schema: 'public', hypertable_name: 'a b' },
      ],
      // Only `public."a b"` is a columnstore. Under a space separator, `"public a".b` would find
      // this row too.
      columnstore: [
        {
          schema: 'public',
          name: 'a b',
          segmentby: ['device'],
          orderby: null,
          orderby_desc: null,
          orderby_nullsfirst: null,
        },
      ],
    });

    const ir = await introspect(ds);
    const collidingPair = ir.hypertables.filter(
      (h) => h.table === 'public a.b' || h.table === 'public.a b',
    );
    expect(collidingPair).toHaveLength(2);

    const withColumnstore = collidingPair.filter((h) => h.columnstore !== undefined);
    expect(withColumnstore.map((h) => h.table)).toEqual(['public.a b']);
  });
});

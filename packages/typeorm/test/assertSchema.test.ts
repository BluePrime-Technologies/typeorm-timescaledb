import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  assertSchema,
  createTimescale,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
  TimescaleError,
  TimescaleErrorCode,
} from '../src/index.js';

class Metric {}
Hypertable({
  chunkInterval: '1 day',
  columnstore: { segmentBy: ['symbol'], compressAfter: '7 days' },
  retention: { dropAfter: '90 days' },
})(Metric);
TimeColumn()(Metric.prototype, 'time');
HypertablePrimaryKey()(Metric.prototype, 'time');

interface CatalogState {
  hypertable: boolean;
  dims: string[];
  procs: string[];
}

function stubDataSource(
  state: CatalogState,
  initialized = true,
  columns: Array<{ propertyName: string; databaseName: string }> = [],
): DataSource {
  return {
    isInitialized: initialized,
    entityMetadatas: [{ target: Metric, tableName: 'metric', columns }],
    query: async (sql: string): Promise<unknown[]> => {
      if (sql.includes('timescaledb_information.hypertables')) {
        return state.hypertable ? [{ ok: 1 }] : [];
      }
      if (sql.includes('timescaledb_information.dimensions')) {
        return state.dims.map((column_name) => ({ column_name }));
      }
      if (sql.includes('timescaledb_information.jobs')) {
        return state.procs.map((proc_name) => ({ proc_name }));
      }
      return [];
    },
  } as unknown as DataSource;
}

const inSync: CatalogState = {
  hypertable: true,
  dims: ['time'],
  procs: ['policy_compression', 'policy_retention'],
};

describe('assertSchema', () => {
  it('returns no drift when the live schema matches', async () => {
    expect(await assertSchema(stubDataSource(inSync))).toEqual([]);
  });

  it('throws TimescaleError(SCHEMA_DRIFT) when the table is not a hypertable', async () => {
    const ds = stubDataSource({ hypertable: false, dims: [], procs: [] });
    try {
      await assertSchema(ds);
      throw new Error('expected SCHEMA_DRIFT');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(TimescaleErrorCode.SCHEMA_DRIFT);
      expect((e as Error).message).toContain('is not one');
    }
  });

  it('warn mode logs and returns drift instead of throwing', async () => {
    const ds = stubDataSource({ ...inSync, procs: ['policy_compression'] }); // retention missing
    const logged: string[] = [];
    const drift = await assertSchema(ds, { mode: 'warn', logger: (m) => logged.push(m) });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toBe('retention policy is missing');
    expect(logged[0]).toContain('retention policy is missing');
  });

  it('rejects an uninitialized DataSource', async () => {
    const ds = stubDataSource(inSync, false);
    try {
      await assertSchema(ds);
      throw new Error('expected INVALID_ARGUMENT');
    } catch (e) {
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.INVALID_ARGUMENT,
      );
    }
  });

  it('maps the entity property name to the physical column when checking dimensions', async () => {
    // @Column({ name: 'ts' }) on the `time` property → drift check must use 'ts', not 'time'
    const columns = [{ propertyName: 'time', databaseName: 'ts' }];
    // dimension is the physical column 'ts' → in sync
    expect(await assertSchema(stubDataSource({ ...inSync, dims: ['ts'] }, true, columns))).toEqual(
      [],
    );
    // dimension under the property name 'time' would only match if we (wrongly) skipped the rename
    await expect(
      assertSchema(stubDataSource({ ...inSync, dims: ['time'] }, true, columns)),
    ).rejects.toBeInstanceOf(TimescaleError);
  });

  it('is exposed on the createTimescale context', async () => {
    const ctx = createTimescale(stubDataSource(inSync));
    expect(typeof ctx.assertSchema).toBe('function');
    expect(await ctx.assertSchema()).toEqual([]);
  });
});

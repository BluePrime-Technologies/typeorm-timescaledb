import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Injectable, Module } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Hypertable, TimeColumn, HypertablePrimaryKey, TimescaleErrorCode } from '../src/index.js';
import {
  TimescaleModule,
  getTimescaleRepositoryToken,
  getTimescaleContextToken,
} from '../src/nestjs/index.js';
import { TimescaleBootstrap } from '../src/nestjs/timescale.module.js';
import { getTimescaleBootstrapToken } from '../src/nestjs/tokens.js';
import type { TimescaleContext } from '../src/index.js';

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
const inSync: CatalogState = {
  hypertable: true,
  dims: ['time'],
  procs: ['policy_compression', 'policy_retention'],
};

function stubDataSource(state: CatalogState): { ds: DataSource; queries: string[] } {
  const queries: string[] = [];
  const ds = {
    isInitialized: true,
    entityMetadatas: [{ target: Metric, tableName: 'metric', columns: [] }],
    getRepository: () => Object.create(Repository.prototype) as Repository<Metric>,
    query: async (sql: string): Promise<unknown[]> => {
      queries.push(sql);
      if (sql.includes('pg_extension')) return [{ x: 1 }];
      if (sql.includes('timescaledb_information.hypertables'))
        return state.hypertable ? [{ x: 1 }] : [];
      if (sql.includes('timescaledb_information.dimensions'))
        return state.dims.map((column_name) => ({ column_name }));
      if (sql.includes('timescaledb_information.jobs'))
        return state.procs.map((proc_name) => ({ proc_name }));
      return [];
    },
  } as unknown as DataSource;
  return { ds, queries };
}

async function buildModule(ds: DataSource, assert: 'assert' | 'warn' | false) {
  return Test.createTestingModule({
    imports: [
      TimescaleModule.forRoot({ dataSource: ds, assert, global: true }),
      TimescaleModule.forFeature([Metric]),
    ],
  }).compile();
}

describe('TimescaleModule', () => {
  it('forRoot provides the Timescale context', async () => {
    const { ds } = stubDataSource(inSync);
    const ref = await buildModule(ds, false);
    const ctx = ref.get<TimescaleContext>(getTimescaleContextToken(), { strict: false });
    expect(ctx.dataSource).toBe(ds);
    expect(typeof ctx.getRepository).toBe('function');
    expect(typeof ctx.assertSchema).toBe('function');
  });

  it('forFeature provides an augmented TimescaleRepository', async () => {
    const { ds } = stubDataSource(inSync);
    const ref = await buildModule(ds, false);
    const repo = ref.get(getTimescaleRepositoryToken(Metric), { strict: false });
    expect(repo).toBeInstanceOf(Repository);
    expect(
      (repo as { timescaleMetadata: { timeColumn: string } }).timescaleMetadata.timeColumn,
    ).toBe('time');
  });

  it('onApplicationBootstrap throws SCHEMA_DRIFT in assert mode when drifted', async () => {
    const { ds } = stubDataSource({ hypertable: false, dims: [], procs: [] });
    const ref = await buildModule(ds, 'assert');
    const boot = ref.get<TimescaleBootstrap>(getTimescaleBootstrapToken(), { strict: false });
    expect(boot).toBeInstanceOf(TimescaleBootstrap);
    await expect(boot.onApplicationBootstrap()).rejects.toMatchObject({
      code: TimescaleErrorCode.SCHEMA_DRIFT,
    });
  });

  it('warn mode does not throw on drift', async () => {
    const { ds } = stubDataSource({ ...inSync, procs: ['policy_compression'] }); // retention missing
    const ref = await buildModule(ds, 'warn');
    const boot = ref.get<TimescaleBootstrap>(getTimescaleBootstrapToken(), { strict: false });
    await expect(boot.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('assert:false skips the check entirely (no catalog queries)', async () => {
    const { ds, queries } = stubDataSource({ hypertable: false, dims: [], procs: [] });
    const ref = await buildModule(ds, false);
    const boot = ref.get<TimescaleBootstrap>(getTimescaleBootstrapToken(), { strict: false });
    await boot.onApplicationBootstrap();
    expect(queries).toHaveLength(0);
  });

  it('forFeature resolves from a separate module when forRoot is global', async () => {
    const { ds } = stubDataSource(inSync);
    @Module({ imports: [TimescaleModule.forFeature([Metric])] })
    class FeatureModule {}
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRoot({ dataSource: ds, assert: false, global: true }),
        FeatureModule,
      ],
    }).compile();
    const repo = ref.get(getTimescaleRepositoryToken(Metric), { strict: false });
    expect(repo).toBeInstanceOf(Repository);
  });

  it('binds each named context to its own DataSource (multi-DataSource)', async () => {
    const { ds: dsA } = stubDataSource(inSync);
    const { ds: dsB } = stubDataSource(inSync);
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRoot({ dataSource: dsA, name: 'a', assert: false, global: true }),
        TimescaleModule.forRoot({ dataSource: dsB, name: 'b', assert: false, global: true }),
        TimescaleModule.forFeature([Metric], 'a'),
        TimescaleModule.forFeature([Metric], 'b'),
      ],
    }).compile();

    const ctxA = ref.get<TimescaleContext>(getTimescaleContextToken('a'), { strict: false });
    const ctxB = ref.get<TimescaleContext>(getTimescaleContextToken('b'), { strict: false });
    expect(ctxA.dataSource).toBe(dsA);
    expect(ctxB.dataSource).toBe(dsB);

    // the same entity registers under distinct, non-colliding tokens per context
    expect(getTimescaleRepositoryToken(Metric, 'a')).not.toBe(
      getTimescaleRepositoryToken(Metric, 'b'),
    );
    expect(ref.get(getTimescaleRepositoryToken(Metric, 'a'), { strict: false })).toBeInstanceOf(
      Repository,
    );
    expect(ref.get(getTimescaleRepositoryToken(Metric, 'b'), { strict: false })).toBeInstanceOf(
      Repository,
    );
  });

  it('does not mutate DataSource.prototype (no global pollution)', async () => {
    const before = DataSource.prototype.initialize;
    const { ds } = stubDataSource(inSync);
    await buildModule(ds, false);
    expect(DataSource.prototype.initialize).toBe(before);
  });
});

describe('TimescaleModule.forRootAsync', () => {
  it('provides the Timescale context from a synchronous useFactory', async () => {
    const { ds } = stubDataSource(inSync);
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRootAsync({
          useFactory: () => ({ dataSource: ds, assert: false }),
          global: true,
        }),
        TimescaleModule.forFeature([Metric]),
      ],
    }).compile();
    const ctx = ref.get<TimescaleContext>(getTimescaleContextToken(), { strict: false });
    expect(ctx.dataSource).toBe(ds);
    const repo = ref.get(getTimescaleRepositoryToken(Metric), { strict: false });
    expect(repo).toBeInstanceOf(Repository);
  });

  it('provides the Timescale context from an async (Promise-returning) useFactory', async () => {
    const { ds } = stubDataSource(inSync);
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRootAsync({
          useFactory: async () => {
            await Promise.resolve();
            return { dataSource: ds, assert: false };
          },
        }),
      ],
    }).compile();
    const ctx = ref.get<TimescaleContext>(getTimescaleContextToken(), { strict: false });
    expect(ctx.dataSource).toBe(ds);
  });

  it('resolves useFactory args from inject + imports, keeping their real types', async () => {
    const { ds } = stubDataSource(inSync);

    @Injectable()
    class FakeConfigService {
      getDataSource(): DataSource {
        return ds;
      }
    }

    @Module({
      providers: [FakeConfigService],
      exports: [FakeConfigService],
    })
    class FakeConfigModule {}

    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRootAsync({
          imports: [FakeConfigModule],
          inject: [FakeConfigService],
          useFactory: (cfg: FakeConfigService) => ({
            dataSource: cfg.getDataSource(),
            assert: false,
          }),
        }),
      ],
    }).compile();
    const ctx = ref.get<TimescaleContext>(getTimescaleContextToken(), { strict: false });
    expect(ctx.dataSource).toBe(ds);
  });

  it('runs the boot-time drift check for an async-resolved context', async () => {
    const { ds } = stubDataSource({ hypertable: false, dims: [], procs: [] });
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRootAsync({ useFactory: () => ({ dataSource: ds, assert: 'assert' }) }),
      ],
    }).compile();
    const boot = ref.get<TimescaleBootstrap>(getTimescaleBootstrapToken(), { strict: false });
    await expect(boot.onApplicationBootstrap()).rejects.toMatchObject({
      code: TimescaleErrorCode.SCHEMA_DRIFT,
    });
  });

  it('registers a no-op context when useFactory resolves undefined, without failing bootstrap', async () => {
    const ref = await Test.createTestingModule({
      imports: [TimescaleModule.forRootAsync({ useFactory: () => undefined, global: true })],
    }).compile();

    expect(ref.get(getTimescaleContextToken(), { strict: false })).toBeUndefined();
    expect(ref.get(getTimescaleBootstrapToken(), { strict: false })).toBeUndefined();

    // the full application lifecycle (which calls onApplicationBootstrap on every
    // provider that implements it) must not throw when the bootstrap provider is nil
    await expect(ref.init()).resolves.not.toThrow();
    await ref.close();
  });

  it('forFeature resolves from a separate module when a global forRootAsync is used', async () => {
    const { ds } = stubDataSource(inSync);
    @Module({ imports: [TimescaleModule.forFeature([Metric])] })
    class FeatureModule {}
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRootAsync({
          useFactory: () => ({ dataSource: ds, assert: false }),
          global: true,
        }),
        FeatureModule,
      ],
    }).compile();
    const repo = ref.get(getTimescaleRepositoryToken(Metric), { strict: false });
    expect(repo).toBeInstanceOf(Repository);
  });

  it('binds a named async context to its own DataSource (multi-DataSource)', async () => {
    const { ds: dsA } = stubDataSource(inSync);
    const { ds: dsB } = stubDataSource(inSync);
    const ref = await Test.createTestingModule({
      imports: [
        TimescaleModule.forRootAsync({
          name: 'a',
          global: true,
          useFactory: () => ({ dataSource: dsA, name: 'a', assert: false }),
        }),
        TimescaleModule.forRootAsync({
          name: 'b',
          global: true,
          useFactory: () => ({ dataSource: dsB, name: 'b', assert: false }),
        }),
      ],
    }).compile();

    const ctxA = ref.get<TimescaleContext>(getTimescaleContextToken('a'), { strict: false });
    const ctxB = ref.get<TimescaleContext>(getTimescaleContextToken('b'), { strict: false });
    expect(ctxA.dataSource).toBe(dsA);
    expect(ctxB.dataSource).toBe(dsB);
  });
});

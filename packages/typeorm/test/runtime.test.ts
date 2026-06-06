import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { DataSource, Repository } from 'typeorm';
import type { DataSource as DataSourceType } from 'typeorm';

// Snapshot DataSource.prototype BEFORE our package is imported anywhere in this module.
const PROTO_BEFORE = {
  initialize: DataSource.prototype.initialize,
  runMigrations: DataSource.prototype.runMigrations,
  undoLastMigration: DataSource.prototype.undoLastMigration,
  synchronize: DataSource.prototype.synchronize,
  destroy: DataSource.prototype.destroy,
};

describe('no global mutation (the differentiator)', () => {
  it('importing the package does not patch DataSource.prototype', async () => {
    await import('../src/index.js');
    expect(DataSource.prototype.initialize).toBe(PROTO_BEFORE.initialize);
    expect(DataSource.prototype.runMigrations).toBe(PROTO_BEFORE.runMigrations);
    expect(DataSource.prototype.undoLastMigration).toBe(PROTO_BEFORE.undoLastMigration);
    expect(DataSource.prototype.synchronize).toBe(PROTO_BEFORE.synchronize);
    expect(DataSource.prototype.destroy).toBe(PROTO_BEFORE.destroy);
  });
});

describe('createTimescale', () => {
  it('is scoped to the passed DataSource', async () => {
    const { createTimescale } = await import('../src/index.js');
    const ds = {} as DataSourceType;
    const ctx = createTimescale(ds);
    expect(ctx.dataSource).toBe(ds);
    expect(typeof ctx.getRepository).toBe('function');
  });

  it('rejects a non-hypertable entity', async () => {
    const { createTimescale, TimescaleError, TimescaleErrorCode } = await import('../src/index.js');
    const ctx = createTimescale({} as DataSourceType);
    class Plain {}
    try {
      ctx.getRepository(Plain);
      throw new Error('expected getRepository to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TimescaleError);
      expect((e as InstanceType<typeof TimescaleError>).code).toBe(
        TimescaleErrorCode.NOT_A_HYPERTABLE,
      );
    }
  });

  it('rejects a non-class entity target (name/schema)', async () => {
    const { createTimescale, TimescaleErrorCode } = await import('../src/index.js');
    const ctx = createTimescale({} as DataSourceType);
    try {
      (ctx.getRepository as (e: unknown) => unknown)('trades');
      throw new Error('expected getRepository to throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(TimescaleErrorCode.NOT_A_HYPERTABLE);
    }
  });

  it('augments the repository PER INSTANCE, never Repository.prototype', async () => {
    const { createTimescale, Hypertable, TimeColumn, HypertablePrimaryKey } =
      await import('../src/index.js');
    class Trade {}
    Hypertable({ chunkInterval: '7 days' })(Trade);
    TimeColumn()(Trade.prototype, 'ts');
    HypertablePrimaryKey()(Trade.prototype, 'ts');

    // Stub a DataSource whose getRepository yields a bare Repository instance (no DB needed).
    const fakeRepo = Object.create(Repository.prototype) as Repository<Trade>;
    const ds = { getRepository: () => fakeRepo } as unknown as DataSourceType;

    const repo = createTimescale(ds).getRepository(Trade);
    expect(repo).toBe(fakeRepo); // same instance, just augmented
    expect(repo.timescaleMetadata.timeColumn).toBe('ts'); // metadata on the instance
    expect(Object.prototype.hasOwnProperty.call(Repository.prototype, 'timescaleMetadata')).toBe(
      false,
    ); // prototype untouched
  });
});

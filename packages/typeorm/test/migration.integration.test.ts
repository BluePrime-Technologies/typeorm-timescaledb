import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import {
  Column,
  DataSource,
  Entity,
  PrimaryColumn,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
  createTimescaleMigration,
  generateTimescaleMigration,
} from '../src/index.js';

const IMAGE = process.env.TIMESCALE_IMAGE;

// A real hypertable entity, decorated by direct invocation (explicit column types,
// since there is no compiler-emitted design:type without decorator syntax).
class Metric {}
Entity('metric')(Metric);
PrimaryColumn({ type: 'timestamptz' })(Metric.prototype, 'time');
Column({ type: 'text' })(Metric.prototype, 'symbol');
Column({ type: 'double precision' })(Metric.prototype, 'price');
Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['symbol'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})(Metric);
TimeColumn()(Metric.prototype, 'time');
HypertablePrimaryKey()(Metric.prototype, 'time');

const TS = 1700000000000;

describe.skipIf(!IMAGE)('TimescaleDB migration integration', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      // The image logs "ready to accept connections" twice (init bootstrap, then real
      // start); wait for the 2nd so we don't connect to the throwaway bootstrap instance.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
      entities: [Metric],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    // create the plain `metric` table (as TypeORM normally would) before converting it
    await ds.synchronize();
  }, 180_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  // Filter on schema + name, matching the predicates the builders' `inspect` SQL uses.
  const procNames = async (): Promise<string[]> => {
    const rows: Array<{ proc_name: string }> = await ds.query(
      `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    return rows.map((r) => r.proc_name);
  };

  const isHypertable = async (): Promise<boolean> => {
    const rows: unknown[] = await ds.query(
      `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    return rows.length === 1;
  };

  it('applies up (hypertable + policies), reverts non-destructively, and re-applies idempotently', async () => {
    const migration = createTimescaleMigration(generateTimescaleMigration(ds, { timestamp: TS }));
    const qr = ds.createQueryRunner();
    try {
      // --- up ---
      await migration.up(qr);
      expect(await isHypertable()).toBe(true);
      const afterUp = await procNames();
      // live-verifies the proc_name filters used by the builders' inspect queries
      expect(afterUp).toContain('policy_compression'); // columnstore policy
      expect(afterUp).toContain('policy_retention');

      // --- down (non-destructive): policies gone, hypertable stays ---
      await migration.down(qr);
      const afterDown = await procNames();
      expect(afterDown).not.toContain('policy_compression');
      expect(afterDown).not.toContain('policy_retention');
      expect(await isHypertable()).toBe(true); // conversion is intentionally not reverted

      // --- up again: idempotent, policies restored ---
      await migration.up(qr);
      const afterReUp = await procNames();
      expect(afterReUp).toContain('policy_compression');
      expect(afterReUp).toContain('policy_retention');
    } finally {
      await qr.release();
    }
  }, 120_000);
});

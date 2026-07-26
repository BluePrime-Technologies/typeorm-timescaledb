import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { TimescaleSchemaBuilder } from '../src/index.js';

// Env-gated (mirrors the other *.integration.test.ts): runs against both
// timescale/timescaledb:latest-pg17 AND timescale/timescaledb:2.18.0-pg16.
const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

// A plain table the builder will convert into a hypertable by hand.
@Entity('reading')
class Reading {
  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @Column({ type: 'text' })
  device!: string;

  @Column({ type: 'double precision' })
  value!: number;
}

async function policyProcNames(ds: DataSource): Promise<string[]> {
  const rows: Array<{ proc_name: string }> = await ds.query(
    `SELECT proc_name FROM timescaledb_information.jobs ` +
      `WHERE hypertable_schema = 'public' AND hypertable_name = 'reading'`,
  );
  return rows.map((r) => r.proc_name);
}

describe.skipIf(!IMAGE)('M4.3b TimescaleSchemaBuilder — live hand-authored migration', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
      entities: [Reading],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await ds.synchronize(); // create the plain `reading` table
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('runs a hand-authored up() then reverses it with down() (non-destructive)', async () => {
    const schema = new TimescaleSchemaBuilder()
      .createHypertable({ table: 'public.reading', timeColumn: 'time', chunkInterval: '1 day' })
      .addColumnstorePolicy({
        table: 'public.reading',
        segmentBy: ['device'],
        orderBy: [{ column: 'time', direction: 'DESC' }],
        after: '7 days',
      })
      .addRetentionPolicy({ table: 'public.reading', dropAfter: '90 days' });

    // up() converts the table + installs both policy jobs.
    const up = ds.createQueryRunner();
    try {
      await schema.up(up);
    } finally {
      await up.release();
    }

    // The hypertable exists...
    const ht: Array<{ hypertable_name: string }> = await ds.query(
      `SELECT hypertable_name FROM timescaledb_information.hypertables ` +
        `WHERE hypertable_schema = 'public' AND hypertable_name = 'reading'`,
    );
    expect(ht).toHaveLength(1);
    // ...with both background policy jobs present.
    const procs = await policyProcNames(ds);
    expect(procs).toContain('policy_retention');
    expect(procs).toContain('policy_compression');

    // down() removes the policies (reverse order) — non-destructive: the hypertable/table remain.
    const down = ds.createQueryRunner();
    try {
      await schema.down(down);
    } finally {
      await down.release();
    }
    const afterProcs = await policyProcNames(ds);
    expect(afterProcs).not.toContain('policy_retention');
    expect(afterProcs).not.toContain('policy_compression');

    // The table itself still exists (down never drops data).
    const stillThere: Array<{ count: string }> = await ds.query(
      `SELECT count(*)::text AS count FROM information_schema.tables ` +
        `WHERE table_schema = 'public' AND table_name = 'reading'`,
    );
    expect(stillThere[0]!.count).toBe('1');
  });
});

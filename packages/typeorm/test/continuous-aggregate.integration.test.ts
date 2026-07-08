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
  createTimescale,
  createContinuousAggregateSQL,
  createTimescaleMigration,
  generateTimescaleMigration,
  ContinuousAggregate,
  BucketColumn,
  GroupColumn,
  AggregateColumn,
} from '../src/index.js';

type EntityClass = new (...args: never[]) => object;

/**
 * M2.5a — continuous aggregates. CAGGs are core TimescaleDB (no toolkit needed), so
 * this runs on any TimescaleDB image (stock or toolkit).
 */
const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

// Reading(ts, sensor, value) hypertable — two hourly buckets for sensor s1:
// 00:00 → avg 15 (n=2), 01:00 → avg 40 (n=2).
class Reading {}
Entity('reading')(Reading);
PrimaryColumn({ type: 'timestamptz' })(Reading.prototype, 'ts');
Column({ type: 'text' })(Reading.prototype, 'sensor');
Column({ type: 'double precision' })(Reading.prototype, 'value');
Hypertable({ chunkInterval: '1 day' })(Reading);
TimeColumn()(Reading.prototype, 'ts');
HypertablePrimaryKey()(Reading.prototype, 'ts');

const ROWS: Array<[string, string, number]> = [
  ['2024-01-01T00:05:00Z', 's1', 10],
  ['2024-01-01T00:35:00Z', 's1', 20],
  ['2024-01-01T01:05:00Z', 's1', 30],
  ['2024-01-01T01:35:00Z', 's1', 50],
];

// M2.5b — the decorator-driven CAGG over Reading (a pure metadata class, NOT an @Entity).
class ReadingHourlyCagg {}
ContinuousAggregate({ name: 'reading_hourly_cagg', source: Reading, bucket: '1 hour' })(
  ReadingHourlyCagg,
);
BucketColumn()(ReadingHourlyCagg.prototype, 'bucket');
GroupColumn()(ReadingHourlyCagg.prototype, 'sensor');
AggregateColumn({ fn: 'avg', column: 'value' })(ReadingHourlyCagg.prototype, 'avg_v');
AggregateColumn({ fn: 'count' })(ReadingHourlyCagg.prototype, 'n');

async function boot(image: string): Promise<{ container: StartedTestContainer; ds: DataSource }> {
  const container = await new GenericContainer(image)
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const admin = new DataSource({
    type: 'postgres',
    host,
    port,
    username: 'postgres',
    password: 'test',
    database: 'test',
  });
  await admin.initialize();
  await admin.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  await admin.destroy();

  const ds = new DataSource({
    type: 'postgres',
    host,
    port,
    username: 'postgres',
    password: 'test',
    database: 'test',
    entities: [Reading as EntityClass],
    synchronize: false,
  });
  await ds.initialize();
  await ds.query('DROP TABLE IF EXISTS "reading" CASCADE');
  await ds.synchronize();
  const qr = ds.createQueryRunner();
  try {
    await createTimescaleMigration(generateTimescaleMigration(ds, { timestamp: 1700000000000 })).up(
      qr,
    );
  } finally {
    await qr.release();
  }
  for (const [ts, sensor, value] of ROWS) {
    await ds.query('INSERT INTO "reading"("ts","sensor","value") VALUES ($1,$2,$3)', [
      ts,
      sensor,
      value,
    ]);
  }
  return { container, ds };
}

describe.skipIf(!IMAGE)('M2.5a continuous aggregates', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    ({ container, ds } = await boot(IMAGE as string));
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('creates a CAGG inside a transaction, refreshes standalone, and returns exact buckets', async () => {
    const cagg = createContinuousAggregateSQL({
      view: 'reading_hourly',
      source: 'reading',
      timeColumn: 'ts',
      bucketInterval: '1 hour',
      groupBy: ['sensor'],
      aggregates: [
        { fn: 'avg', column: 'value', as: 'avg_v' },
        { fn: 'count', as: 'n' },
      ],
    });

    // CREATE ... WITH NO DATA must succeed INSIDE a transaction (the migration model).
    const qr = ds.createQueryRunner();
    await qr.startTransaction();
    try {
      for (const sql of cagg.up) await qr.query(sql);
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    // Refresh runs standalone (cannot run in a txn). (This CAGG is real-time —
    // materialized_only=false — so a query would already serve live-computed rows;
    // the empty-before-refresh guarantee is asserted on the materialized_only CAGG below.)
    await createTimescale(ds).refreshContinuousAggregate('reading_hourly');

    const rows = (await ds.query(
      'SELECT bucket, sensor, avg_v, n FROM reading_hourly ORDER BY bucket',
    )) as Array<{ bucket: string; sensor: string; avg_v: number; n: string }>;
    expect(rows).toHaveLength(2);
    expect(Number(rows[0]?.avg_v)).toBeCloseTo(15, 10);
    expect(Number(rows[0]?.n)).toBe(2);
    expect(Number(rows[1]?.avg_v)).toBeCloseTo(40, 10);
    expect(rows[1]?.sensor).toBe('s1');
  });

  it('a bounded refresh only materializes the requested window', async () => {
    // Fresh CAGG (materialized_only=true so we see ONLY what we refresh).
    const cagg = createContinuousAggregateSQL({
      view: 'reading_hourly_bounded',
      source: 'reading',
      timeColumn: 'ts',
      bucketInterval: '1 hour',
      groupBy: ['sensor'],
      aggregates: [{ fn: 'count', as: 'n' }],
      materializedOnly: true,
    });
    for (const sql of cagg.up) await ds.query(sql);
    const ts = createTimescale(ds);
    // materialized_only=true + WITH NO DATA → nothing until refreshed.
    const before = (await ds.query(
      'SELECT count(*)::int AS c FROM reading_hourly_bounded',
    )) as Array<{ c: number }>;
    expect(before[0]?.c).toBe(0);
    // Refresh only the 01:00 bucket window.
    await ts.refreshContinuousAggregate('reading_hourly_bounded', {
      start: '2024-01-01T01:00:00Z',
      end: '2024-01-01T02:00:00Z',
    });
    const rows = (await ds.query(
      'SELECT bucket FROM reading_hourly_bounded ORDER BY bucket',
    )) as Array<{ bucket: string }>;
    expect(rows).toHaveLength(1);
    for (const sql of cagg.down) await ds.query(sql);
  });

  it('down drops the continuous aggregate (idempotent)', async () => {
    await ds.query('DROP MATERIALIZED VIEW IF EXISTS reading_hourly');
    const rows = (await ds.query(
      "SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name = 'reading_hourly'",
    )) as unknown[];
    expect(rows).toHaveLength(0);
  });

  // ---- M2.5b: decorator-driven CAGG through the migration generator ----

  it('generates a CAGG migration from @ContinuousAggregate, runs it, refreshes, queries', async () => {
    // The generator emits the hypertable (idempotent, already applied in boot) + the CAGG.
    const gen = generateTimescaleMigration(ds, {
      timestamp: 1700000000001,
      continuousAggregates: [ReadingHourlyCagg],
    });
    const caggUp = gen.up.filter((s) => s.includes('reading_hourly_cagg'));
    expect(caggUp).toHaveLength(1);
    expect(caggUp[0]).toContain('CREATE MATERIALIZED VIEW "public"."reading_hourly_cagg"');
    expect(gen.down).toContain('DROP MATERIALIZED VIEW IF EXISTS "public"."reading_hourly_cagg";');

    // Run the generated CAGG DDL inside a transaction (the migration model).
    const qr = ds.createQueryRunner();
    await qr.startTransaction();
    try {
      for (const sql of caggUp) await qr.query(sql);
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    await createTimescale(ds).refreshContinuousAggregate('reading_hourly_cagg');
    const rows = (await ds.query(
      'SELECT bucket, sensor, avg_v, n FROM reading_hourly_cagg ORDER BY bucket',
    )) as Array<{ sensor: string; avg_v: number; n: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.sensor).toBe('s1');
    expect(Number(rows[0]?.avg_v)).toBeCloseTo(15, 10);
    expect(Number(rows[0]?.n)).toBe(2);
    expect(Number(rows[1]?.avg_v)).toBeCloseTo(40, 10);

    await ds.query('DROP MATERIALIZED VIEW IF EXISTS reading_hourly_cagg');
  });
});

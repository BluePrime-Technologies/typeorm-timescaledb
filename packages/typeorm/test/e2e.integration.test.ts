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
  createTimescaleMigration,
  generateTimescaleMigration,
  TimescaleError,
} from '../src/index.js';

type EntityClass = new (...args: never[]) => object;

/**
 * Deep end-to-end validation against a REAL TimescaleDB: every piece of SQL the
 * package generates is applied to a live database and verified against the catalog,
 * with real data, chunk creation, compression, and retention exercised — so we don't
 * ship bugs. Scope = M1 (hypertables, columnstore + retention policies, space
 * partitioning, migration generate/run/revert, repository access, drift). Hyperfunctions
 * / continuous aggregates are M2 and intentionally not covered here.
 */

const IMAGE = process.env.TIMESCALE_IMAGE;
const TS = 1700000000000;

// --- Entities (direct-invocation decorators; explicit column types) ---

// Full-featured: time PK + columnstore (segmentby/orderby + policy) + retention.
class Reading {}
Entity('reading')(Reading);
PrimaryColumn({ type: 'timestamptz' })(Reading.prototype, 'time');
Column({ type: 'text' })(Reading.prototype, 'sensorId');
Column({ type: 'double precision' })(Reading.prototype, 'value');
Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['sensorId'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '365 days' },
})(Reading);
TimeColumn()(Reading.prototype, 'time');
HypertablePrimaryKey()(Reading.prototype, 'time');

// Space partitioning (by_hash) + composite PK.
class Event {}
Entity('event')(Event);
PrimaryColumn({ type: 'timestamptz' })(Event.prototype, 'ts');
PrimaryColumn({ type: 'text' })(Event.prototype, 'tenant');
Column({ type: 'jsonb', nullable: true })(Event.prototype, 'payload');
Hypertable({
  chunkInterval: '1 hour',
  spacePartition: { column: 'tenant', partitions: 4 },
})(Event);
TimeColumn()(Event.prototype, 'ts');
HypertablePrimaryKey()(Event.prototype, 'ts');
HypertablePrimaryKey()(Event.prototype, 'tenant');

// @Column({ name }) rename: property names differ from physical columns.
class Sample {}
Entity('sample')(Sample);
PrimaryColumn({ type: 'timestamptz', name: 'measured_at' })(Sample.prototype, 'measuredAt');
Column({ type: 'text', name: 'device_id' })(Sample.prototype, 'deviceId');
Hypertable({
  chunkInterval: '1 day',
  columnstore: { segmentBy: ['deviceId'], compressAfter: '30 days' },
})(Sample);
TimeColumn()(Sample.prototype, 'measuredAt');
HypertablePrimaryKey()(Sample.prototype, 'measuredAt');

describe.skipIf(!IMAGE)('deep E2E against real TimescaleDB', () => {
  let container: StartedTestContainer;
  let host: string;
  let port: number;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    host = container.getHost();
    port = container.getMappedPort(5432);

    const boot = new DataSource({
      type: 'postgres',
      host,
      port,
      username: 'postgres',
      password: 'test',
      database: 'test',
    });
    await boot.initialize();
    await boot.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await boot.destroy();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  async function open(entities: EntityClass[]): Promise<DataSource> {
    const ds = new DataSource({
      type: 'postgres',
      host,
      port,
      username: 'postgres',
      password: 'test',
      database: 'test',
      entities,
      synchronize: false,
    });
    await ds.initialize();
    return ds;
  }

  /** Apply the generated migration's up statements via a query runner. */
  async function applyUp(ds: DataSource): Promise<void> {
    const qr = ds.createQueryRunner();
    try {
      await createTimescaleMigration(generateTimescaleMigration(ds, { timestamp: TS })).up(qr);
    } finally {
      await qr.release();
    }
  }

  it('full lifecycle: generate+apply, real data, chunks, compression, retention, queries', async () => {
    const ds = await open([Reading]);
    try {
      await ds.synchronize(); // creates the plain "reading" table
      await applyUp(ds);

      // --- catalog: hypertable + policies present ---
      const ht: unknown[] = await ds.query(
        `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'reading'`,
      );
      expect(ht).toHaveLength(1);
      const procs: Array<{ proc_name: string }> = await ds.query(
        `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );
      const procNames = procs.map((p) => p.proc_name);
      expect(procNames).toContain('policy_compression');
      expect(procNames).toContain('policy_retention');

      // columnstore was enabled with our segmentby/orderby
      const cs: unknown[] = await ds.query(
        `SELECT 1 FROM timescaledb_information.compression_settings WHERE hypertable_name = 'reading'`,
      );
      expect(cs.length).toBeGreaterThan(0);

      // --- real data spanning multiple daily chunks ---
      await ds.query(
        `INSERT INTO "reading" ("time","sensorId","value")
           SELECT ts, 'sensor-a', 1
           FROM generate_series('2020-01-01'::timestamptz, '2020-01-05'::timestamptz, '6 hours') ts`,
      );
      const totalRows: Array<{ n: string }> = await ds.query(
        `SELECT count(*)::text n FROM "reading"`,
      );
      const insertedCount = Number(totalRows[0]?.n);
      expect(insertedCount).toBeGreaterThan(10);

      const chunksBefore: Array<{ n: string }> = await ds.query(
        `SELECT count(*)::text n FROM timescaledb_information.chunks WHERE hypertable_name = 'reading'`,
      );
      expect(Number(chunksBefore[0]?.n)).toBeGreaterThan(1); // multiple chunks created

      // --- compress the oldest chunk, then query across compressed + uncompressed ---
      await ds.query(
        `SELECT compress_chunk(c) FROM (SELECT show_chunks('"reading"') c ORDER BY 1 LIMIT 1) s`,
      );
      const compressed: Array<{ n: string }> = await ds.query(
        `SELECT count(*)::text n FROM timescaledb_information.chunks WHERE hypertable_name = 'reading' AND is_compressed`,
      );
      expect(Number(compressed[0]?.n)).toBeGreaterThanOrEqual(1);

      // queries must return correct results across the compressed boundary
      const sum: Array<{ total: string; cnt: string }> = await ds.query(
        `SELECT sum(value)::text total, count(*)::text cnt FROM "reading"`,
      );
      expect(Number(sum[0]?.cnt)).toBe(insertedCount);
      expect(Number(sum[0]?.total)).toBe(insertedCount); // each value = 1

      // --- retention: drop old chunks, verify rows/chunks shrink ---
      await ds.query(`SELECT drop_chunks('"reading"', older_than => '2020-01-03'::timestamptz)`);
      const after: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM "reading"`);
      expect(Number(after[0]?.n)).toBeLessThan(insertedCount);

      // --- migration down is non-destructive: policies gone, hypertable + data stay ---
      const qr = ds.createQueryRunner();
      try {
        await createTimescaleMigration(generateTimescaleMigration(ds, { timestamp: TS })).down(qr);
      } finally {
        await qr.release();
      }
      const procsAfterDown: Array<{ proc_name: string }> = await ds.query(
        `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );
      expect(procsAfterDown.map((p) => p.proc_name)).not.toContain('policy_retention');
      const stillHt: unknown[] = await ds.query(
        `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'reading'`,
      );
      expect(stillHt).toHaveLength(1);
      const dataKept: Array<{ n: string }> = await ds.query(
        `SELECT count(*)::text n FROM "reading"`,
      );
      expect(Number(dataKept[0]?.n)).toBe(Number(after[0]?.n));

      // --- re-apply up is idempotent (policies restored, no error) ---
      await applyUp(ds);
      const procsReUp: Array<{ proc_name: string }> = await ds.query(
        `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );
      expect(procsReUp.map((p) => p.proc_name)).toContain('policy_retention');
    } finally {
      await ds.destroy();
    }
  }, 180_000);

  it('space partitioning: by_hash adds a second dimension', async () => {
    const ds = await open([Event]);
    try {
      await ds.synchronize();
      await applyUp(ds);
      const dims: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM timescaledb_information.dimensions WHERE hypertable_name = 'event' ORDER BY column_name`,
      );
      const cols = dims.map((d) => d.column_name);
      expect(cols).toContain('ts'); // time dimension
      expect(cols).toContain('tenant'); // space (hash) dimension
      expect(cols).toHaveLength(2);
    } finally {
      await ds.destroy();
    }
  }, 120_000);

  it('@Column({ name }) rename: generated DDL targets physical columns', async () => {
    const ds = await open([Sample]);
    try {
      await ds.synchronize();
      await applyUp(ds);
      // hypertable on the physical column measured_at
      const dims: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM timescaledb_information.dimensions WHERE hypertable_name = 'sample'`,
      );
      expect(dims.map((d) => d.column_name)).toContain('measured_at');
      // data round-trips on the physical schema
      await ds.query(
        `INSERT INTO "sample" ("measured_at","device_id") VALUES ('2021-01-01'::timestamptz, 'dev-1')`,
      );
      const rows: Array<{ n: string }> = await ds.query(`SELECT count(*)::text n FROM "sample"`);
      expect(Number(rows[0]?.n)).toBe(1);
    } finally {
      await ds.destroy();
    }
  }, 120_000);

  it('repository access + assertSchema (in-sync, then drift)', async () => {
    const ds = await open([Reading]);
    try {
      await ds.synchronize();
      await applyUp(ds);

      // repository from the Timescale context performs real CRUD on the hypertable
      const ctx = createTimescale(ds);
      const repo = ctx.getRepository(Reading);
      await repo.save({
        time: new Date('2022-06-01T00:00:00Z'),
        sensorId: 'sensor-z',
        value: 9,
      } as never);
      const found = (await repo.find({ where: { sensorId: 'sensor-z' } as never })) as unknown[];
      expect(found).toHaveLength(1);
      expect(repo.timescaleMetadata.timeColumn).toBe('time');

      // assertSchema: in sync
      expect(await ctx.assertSchema()).toEqual([]);

      // introduce drift → detected
      await ds.query(`SELECT remove_retention_policy('"reading"', if_exists => TRUE)`);
      await expect(ctx.assertSchema()).rejects.toBeInstanceOf(TimescaleError);
    } finally {
      await ds.destroy();
    }
  }, 120_000);
});

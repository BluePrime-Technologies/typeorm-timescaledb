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
Hypertable({ chunkInterval: '1 hour', spacePartition: { column: 'tenant', partitions: 4 } })(Event);
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

// Columnstore enabled WITHOUT a policy (compressAfter omitted) — distinct builder branch.
class Telemetry {}
Entity('telemetry')(Telemetry);
PrimaryColumn({ type: 'timestamptz' })(Telemetry.prototype, 'time');
Column({ type: 'text' })(Telemetry.prototype, 'host');
Hypertable({ chunkInterval: '1 day', columnstore: { segmentBy: ['host'] } })(Telemetry);
TimeColumn()(Telemetry.prototype, 'time');
HypertablePrimaryKey()(Telemetry.prototype, 'time');

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

  /** Open a DataSource for the given entities and drop their tables first (order-independent tests). */
  async function open(entities: EntityClass[], tables: string[]): Promise<DataSource> {
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
    for (const t of tables) await ds.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    await ds.synchronize(); // create the plain tables
    return ds;
  }

  async function applyUp(ds: DataSource): Promise<void> {
    const qr = ds.createQueryRunner();
    try {
      await createTimescaleMigration(generateTimescaleMigration(ds, { timestamp: TS })).up(qr);
    } finally {
      await qr.release();
    }
  }

  async function applyDown(ds: DataSource): Promise<void> {
    const qr = ds.createQueryRunner();
    try {
      await createTimescaleMigration(generateTimescaleMigration(ds, { timestamp: TS })).down(qr);
    } finally {
      await qr.release();
    }
  }

  const num = (rows: Array<Record<string, string>>, key = 'n'): number => Number(rows[0]?.[key]);

  it('full lifecycle: data, chunks, compression (correct cross-boundary queries), retention', async () => {
    const ds = await open([Reading], ['reading']);
    try {
      await applyUp(ds);

      // Pause this hypertable's policy background jobs so the MANUAL compress_chunk / drop_chunks
      // assertions below are deterministic. All data is from 2020, so every chunk is immediately
      // policy-eligible; if the scheduler fires policy_retention/policy_compression concurrently
      // with a manual op, a bgw dropping a chunk mid-compress raises 55P03 "chunk deleted by other
      // transaction" (a flaky failure). The jobs still exist in the catalog (asserted below) and
      // down() still removes them — we only stop them from running during the test.
      await ds.query(
        `SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );

      // hypertable + both policies recorded in the catalog
      expect(
        await ds.query(
          `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'reading'`,
        ),
      ).toHaveLength(1);
      const procs: Array<{ proc_name: string }> = await ds.query(
        `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );
      expect(procs.map((p) => p.proc_name).sort()).toEqual([
        'policy_compression',
        'policy_retention',
      ]);

      // the EXACT segmentby/orderby we configured actually landed
      const settings: Array<{
        attname: string;
        segmentby_column_index: number | null;
        orderby_column_index: number | null;
      }> = await ds.query(
        `SELECT attname, segmentby_column_index, orderby_column_index
             FROM timescaledb_information.compression_settings WHERE hypertable_name = 'reading'`,
      );
      const seg = settings.find((s) => s.attname === 'sensorId');
      const ord = settings.find((s) => s.attname === 'time');
      expect(seg?.segmentby_column_index).not.toBeNull();
      expect(ord?.orderby_column_index).not.toBeNull();

      // real data: 17 rows over 5 daily chunks
      await ds.query(
        `INSERT INTO "reading" ("time","sensorId","value")
         SELECT ts, 'sensor-a', 1
         FROM generate_series('2020-01-01'::timestamptz, '2020-01-05'::timestamptz, '6 hours') ts`,
      );
      expect(num(await ds.query(`SELECT count(*)::text n FROM "reading"`))).toBe(17);
      expect(
        num(
          await ds.query(
            `SELECT count(*)::text n FROM timescaledb_information.chunks WHERE hypertable_name = 'reading'`,
          ),
        ),
      ).toBeGreaterThanOrEqual(4);

      // compress exactly one chunk, then verify queries are correct across the boundary
      await ds.query(
        `SELECT compress_chunk(c) FROM (SELECT show_chunks('"reading"') c ORDER BY 1 LIMIT 1) s`,
      );
      expect(
        num(
          await ds.query(
            `SELECT count(*)::text n FROM timescaledb_information.chunks WHERE hypertable_name = 'reading' AND is_compressed`,
          ),
        ),
      ).toBe(1);
      const agg: Array<{ total: string; cnt: string }> = await ds.query(
        `SELECT sum(value)::text total, count(*)::text cnt FROM "reading"`,
      );
      expect(Number(agg[0]?.cnt)).toBe(17);
      expect(Number(agg[0]?.total)).toBe(17); // each value = 1, read across compressed + uncompressed

      // a time_bucket aggregation (the common real-world query shape) works on the hypertable
      const buckets: Array<{ bucket: string; c: string }> = await ds.query(
        `SELECT time_bucket('1 day', "time") bucket, count(*)::text c FROM "reading" GROUP BY 1 ORDER BY 1`,
      );
      expect(buckets.length).toBeGreaterThanOrEqual(4);
      expect(buckets.reduce((a, b) => a + Number(b.c), 0)).toBe(17);

      // retention: drop old chunks
      await ds.query(`SELECT drop_chunks('"reading"', older_than => '2020-01-03'::timestamptz)`);
      const afterDrop = num(await ds.query(`SELECT count(*)::text n FROM "reading"`));
      expect(afterDrop).toBeLessThan(17);

      // non-destructive down: BOTH policies removed, hypertable + remaining data stay
      await applyDown(ds);
      const procsDown: Array<{ proc_name: string }> = await ds.query(
        `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );
      expect(procsDown.map((p) => p.proc_name)).not.toContain('policy_retention');
      expect(procsDown.map((p) => p.proc_name)).not.toContain('policy_compression');
      expect(
        await ds.query(
          `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'reading'`,
        ),
      ).toHaveLength(1);
      expect(num(await ds.query(`SELECT count(*)::text n FROM "reading"`))).toBe(afterDrop); // data intact

      // idempotent re-up: policies restored
      await applyUp(ds);
      const procsReUp: Array<{ proc_name: string }> = await ds.query(
        `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'reading'`,
      );
      expect(procsReUp.map((p) => p.proc_name).sort()).toEqual([
        'policy_compression',
        'policy_retention',
      ]);
    } finally {
      await ds.destroy();
    }
  }, 180_000);

  it('space partitioning: by_hash adds a second dimension', async () => {
    const ds = await open([Event], ['event']);
    try {
      await applyUp(ds);
      const dims: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM timescaledb_information.dimensions WHERE hypertable_name = 'event' ORDER BY column_name`,
      );
      expect(dims.map((d) => d.column_name).sort()).toEqual(['tenant', 'ts']);
    } finally {
      await ds.destroy();
    }
  }, 120_000);

  it('@Column({ name }) rename: generated DDL targets physical columns', async () => {
    const ds = await open([Sample], ['sample']);
    try {
      await applyUp(ds);
      const dims: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM timescaledb_information.dimensions WHERE hypertable_name = 'sample'`,
      );
      expect(dims.map((d) => d.column_name)).toContain('measured_at');
      await ds.query(
        `INSERT INTO "sample" ("measured_at","device_id") VALUES ('2021-01-01'::timestamptz, 'dev-1')`,
      );
      expect(num(await ds.query(`SELECT count(*)::text n FROM "sample"`))).toBe(1);
    } finally {
      await ds.destroy();
    }
  }, 120_000);

  it('columnstore without a policy: enabled, no policy job, non-destructive down', async () => {
    const ds = await open([Telemetry], ['telemetry']);
    try {
      await applyUp(ds);
      // columnstore enabled (settings present) but NO compression policy job
      expect(
        num(
          await ds.query(
            `SELECT count(*)::text n FROM timescaledb_information.compression_settings WHERE hypertable_name = 'telemetry'`,
          ),
        ),
      ).toBeGreaterThanOrEqual(1);
      expect(
        num(
          await ds.query(
            `SELECT count(*)::text n FROM timescaledb_information.jobs WHERE hypertable_name = 'telemetry' AND proc_name = 'policy_compression'`,
          ),
        ),
      ).toBe(0);
      // down is a no-op (no policy to remove); hypertable stays
      await applyDown(ds);
      expect(
        await ds.query(
          `SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry'`,
        ),
      ).toHaveLength(1);
    } finally {
      await ds.destroy();
    }
  }, 120_000);

  it('multi-entity: one migration converts every hypertable on the DataSource', async () => {
    const ds = await open([Reading, Event, Sample], ['reading', 'event', 'sample']);
    try {
      await applyUp(ds);
      const hts: Array<{ hypertable_name: string }> = await ds.query(
        `SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY hypertable_name`,
      );
      const names = hts.map((h) => h.hypertable_name);
      expect(names).toContain('reading');
      expect(names).toContain('event');
      expect(names).toContain('sample');
      // per-table policies are correct: reading has retention, event (no columnstore/retention) has none
      expect(
        num(
          await ds.query(
            `SELECT count(*)::text n FROM timescaledb_information.jobs WHERE hypertable_name = 'reading' AND proc_name = 'policy_retention'`,
          ),
        ),
      ).toBe(1);
      expect(
        num(
          await ds.query(
            `SELECT count(*)::text n FROM timescaledb_information.jobs WHERE hypertable_name = 'event'`,
          ),
        ),
      ).toBe(0);
    } finally {
      await ds.destroy();
    }
  }, 180_000);

  it('repository access + assertSchema (in-sync, then drift)', async () => {
    const ds = await open([Reading], ['reading']);
    try {
      await applyUp(ds);
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

      expect(await ctx.assertSchema()).toEqual([]); // in sync
      await ds.query(`SELECT remove_retention_policy('"reading"', if_exists => TRUE)`);
      await expect(ctx.assertSchema()).rejects.toBeInstanceOf(TimescaleError);
    } finally {
      await ds.destroy();
    }
  }, 120_000);
});

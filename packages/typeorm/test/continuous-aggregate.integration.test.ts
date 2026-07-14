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
  addContinuousAggregatePolicySQL,
  createTimescaleMigration,
  generateTimescaleMigration,
  assertSchema,
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

// M2.5c — a decorator-driven CAGG carrying an automatic refresh policy.
class ReadingHourlyRefreshedCagg {}
ContinuousAggregate({
  name: 'reading_hourly_refreshed_cagg',
  source: Reading,
  bucket: '1 hour',
  refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '30 minutes' },
})(ReadingHourlyRefreshedCagg);
BucketColumn()(ReadingHourlyRefreshedCagg.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(ReadingHourlyRefreshedCagg.prototype, 'n');

// M2.5d — a hierarchical CAGG: a daily rollup built FROM an hourly CAGG. The child exposes
// sum + count so the daily parent can re-aggregate them (sum of sums, sum of counts).
class HourlyRollupCagg {}
ContinuousAggregate({ name: 'hourly_rollup_cagg', source: Reading, bucket: '1 hour' })(
  HourlyRollupCagg,
);
BucketColumn()(HourlyRollupCagg.prototype, 'bucket');
GroupColumn()(HourlyRollupCagg.prototype, 'sensor');
AggregateColumn({ fn: 'sum', column: 'value' })(HourlyRollupCagg.prototype, 'sum_v');
AggregateColumn({ fn: 'count' })(HourlyRollupCagg.prototype, 'n');

class DailyRollupCagg {}
ContinuousAggregate({ name: 'daily_rollup_cagg', source: HourlyRollupCagg, bucket: '1 day' })(
  DailyRollupCagg,
);
BucketColumn()(DailyRollupCagg.prototype, 'bucket');
GroupColumn()(DailyRollupCagg.prototype, 'sensor');
AggregateColumn({ fn: 'sum', column: 'sum_v' })(DailyRollupCagg.prototype, 'sum_v');
AggregateColumn({ fn: 'sum', column: 'n' })(DailyRollupCagg.prototype, 'n');

// M2.5e — a CAGG with a refresh policy, used to exercise assertSchema() drift detection.
class DriftCheckCagg {}
ContinuousAggregate({
  name: 'drift_check_cagg',
  source: Reading,
  bucket: '1 hour',
  refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
})(DriftCheckCagg);
BucketColumn()(DriftCheckCagg.prototype, 'bucket');
AggregateColumn({ fn: 'count' })(DriftCheckCagg.prototype, 'n');

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

  // ---- M2.5c: a CAGG refresh policy through the migration generator ----

  it('generates + applies a refresh policy, finds it via inspect, and removes it on down', async () => {
    const view = 'reading_hourly_refreshed_cagg';
    const gen = generateTimescaleMigration(ds, {
      timestamp: 1700000000002,
      continuousAggregates: [ReadingHourlyRefreshedCagg],
    });
    // The CAGG-scoped up = CREATE MATERIALIZED VIEW + add_continuous_aggregate_policy.
    const up = gen.up.filter((s) => s.includes(view));
    expect(up.some((s) => s.includes('CREATE MATERIALIZED VIEW'))).toBe(true);
    expect(up.some((s) => s.includes('add_continuous_aggregate_policy'))).toBe(true);

    // Both the create AND the add-policy must succeed inside a single transaction.
    const qr = ds.createQueryRunner();
    await qr.startTransaction();
    try {
      for (const sql of up) await qr.query(sql);
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    // The builder's own (version-robust) inspect must find exactly this policy.
    const inspect = addContinuousAggregatePolicySQL({
      view,
      startOffset: '1 month',
      endOffset: '1 hour',
      scheduleInterval: '30 minutes',
    }).inspect;
    const found = (await ds.query(inspect)) as Array<{
      schedule_interval: string;
      start_offset: string;
      end_offset: string;
    }>;
    expect(found).toHaveLength(1);
    expect(found[0]?.schedule_interval).toBe('00:30:00');
    expect(found[0]?.start_offset).toMatch(/mon/); // '1 month' → normalized '1 mon'
    expect(found[0]?.end_offset).toBe('01:00:00'); // '1 hour' → normalized '01:00:00'

    // down: remove the policy, then drop the view. After it, inspect finds nothing.
    const down = gen.down.filter((s) => s.includes(view));
    expect(down[0]).toContain('remove_continuous_aggregate_policy'); // removed before the DROP
    for (const sql of down) await ds.query(sql);
    const after = (await ds.query(inspect)) as unknown[];
    expect(after).toHaveLength(0);
  });

  // ---- M2.5d: a hierarchical CAGG (daily rollup of an hourly CAGG) ----

  it('generates + runs a hierarchical CAGG and rolls the child up correctly', async () => {
    // Pass the parent first to prove topological ordering creates the child (hourly) first.
    const gen = generateTimescaleMigration(ds, {
      timestamp: 1700000000003,
      continuousAggregates: [DailyRollupCagg, HourlyRollupCagg],
    });
    const childCreate = gen.up.findIndex((s) =>
      s.includes('CREATE MATERIALIZED VIEW "public"."hourly_rollup_cagg"'),
    );
    const parentCreate = gen.up.findIndex((s) =>
      s.includes('CREATE MATERIALIZED VIEW "public"."daily_rollup_cagg"'),
    );
    expect(childCreate).toBeGreaterThanOrEqual(0);
    expect(childCreate).toBeLessThan(parentCreate);
    // the parent selects FROM the child's view, not the hypertable
    expect(gen.up[parentCreate]).toContain('FROM "public"."hourly_rollup_cagg"');

    const caggUp = gen.up.filter((s) => s.includes('_rollup_cagg'));
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

    // Refresh order matters: child (hourly) before parent (daily).
    const ts = createTimescale(ds);
    await ts.refreshContinuousAggregate('hourly_rollup_cagg');
    await ts.refreshContinuousAggregate('daily_rollup_cagg');

    // ROWS for s1 on 2024-01-01: values 10,20,30,50 → daily sum_v = 110, n = 4.
    const rows = (await ds.query(
      'SELECT bucket, sensor, sum_v, n FROM daily_rollup_cagg ORDER BY bucket',
    )) as Array<{ sensor: string; sum_v: number; n: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sensor).toBe('s1');
    expect(Number(rows[0]?.sum_v)).toBeCloseTo(110, 10);
    expect(Number(rows[0]?.n)).toBe(4);

    await ds.query('DROP MATERIALIZED VIEW IF EXISTS daily_rollup_cagg');
    await ds.query('DROP MATERIALIZED VIEW IF EXISTS hourly_rollup_cagg');
  });

  // ---- M2.5e: assertSchema() drift detection for CAGGs + refresh policies ----

  it('detects continuous-aggregate drift: in-sync, then missing policy, then missing view', async () => {
    const gen = generateTimescaleMigration(ds, {
      timestamp: 1700000000004,
      continuousAggregates: [DriftCheckCagg],
    });
    const up = gen.up.filter((s) => s.includes('drift_check_cagg'));
    const qr = ds.createQueryRunner();
    await qr.startTransaction();
    try {
      for (const sql of up) await qr.query(sql);
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    // In sync (CAGG exists, real-time, refresh policy present) → no drift.
    expect(
      await assertSchema(ds, { mode: 'warn', continuousAggregates: [DriftCheckCagg] }),
    ).toEqual([]);

    // Flip materialized_only on the live view (decorator declares false) → mismatch drift.
    await ds.query(
      'ALTER MATERIALIZED VIEW drift_check_cagg SET (timescaledb.materialized_only = true)',
    );
    const dm = await assertSchema(ds, { mode: 'warn', continuousAggregates: [DriftCheckCagg] });
    expect(dm.some((d) => d.message.includes('materialized_only mismatch'))).toBe(true);
    // Restore in-sync so the next checks isolate a single drift each.
    await ds.query(
      'ALTER MATERIALIZED VIEW drift_check_cagg SET (timescaledb.materialized_only = false)',
    );
    expect(
      await assertSchema(ds, { mode: 'warn', continuousAggregates: [DriftCheckCagg] }),
    ).toEqual([]);

    // Remove the refresh policy → drift: policy missing.
    await ds.query(
      `SELECT remove_continuous_aggregate_policy('"public"."drift_check_cagg"', if_exists => TRUE)`,
    );
    const d1 = await assertSchema(ds, { mode: 'warn', continuousAggregates: [DriftCheckCagg] });
    expect(d1).toHaveLength(1);
    expect(d1[0]?.message).toContain('refresh policy is missing');

    // Drop the view → drift: does not exist.
    await ds.query('DROP MATERIALIZED VIEW IF EXISTS drift_check_cagg');
    const d2 = await assertSchema(ds, { mode: 'warn', continuousAggregates: [DriftCheckCagg] });
    expect(d2).toHaveLength(1);
    expect(d2[0]?.message).toContain('does not exist');

    // Default 'assert' mode throws SCHEMA_DRIFT on the same CAGG drift.
    await expect(assertSchema(ds, { continuousAggregates: [DriftCheckCagg] })).rejects.toThrow(
      /does not exist/,
    );
  });
});

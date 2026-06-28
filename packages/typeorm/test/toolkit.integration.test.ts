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
  TimescaleErrorCode,
} from '../src/index.js';

type EntityClass = new (...args: never[]) => object;

/**
 * M2.2 — timescaledb_toolkit features (candlesticks, approx_count_distinct) and
 * the toolkit-presence guard.
 *  - TIMESCALE_TOOLKIT_IMAGE (e.g. timescale/timescaledb-ha:pg17) → real OHLCV asserts.
 *  - TIMESCALE_IMAGE (stock, no toolkit) → asserts the clean TSDB_TOOLKIT_MISSING error.
 */
const TOOLKIT_IMAGE = process.env.TIMESCALE_TOOLKIT_IMAGE;
const STOCK_IMAGE = process.env.TIMESCALE_IMAGE;

// Trade(ts, price, vol) hypertable.
class Trade {}
Entity('trade')(Trade);
PrimaryColumn({ type: 'timestamptz' })(Trade.prototype, 'ts');
Column({ type: 'double precision' })(Trade.prototype, 'price');
Column({ type: 'double precision' })(Trade.prototype, 'vol');
Hypertable({ chunkInterval: '1 day' })(Trade);
TimeColumn()(Trade.prototype, 'ts');
HypertablePrimaryKey()(Trade.prototype, 'ts');

// Same dataset as the de-risk spike (known OHLCV per hourly bucket).
const ROWS: Array<[string, number, number]> = [
  ['2024-01-01T00:05:00Z', 10, 1],
  ['2024-01-01T00:15:00Z', 12, 2],
  ['2024-01-01T00:45:00Z', 8, 1],
  ['2024-01-01T00:55:00Z', 11, 3],
  ['2024-01-01T01:05:00Z', 20, 1],
  ['2024-01-01T01:30:00Z', 25, 2],
  ['2024-01-01T01:50:00Z', 22, 1],
];

// Reading(ts, x, y) hypertable for M2.3a stats/regression/percentiles.
class Reading {}
Entity('reading')(Reading);
PrimaryColumn({ type: 'timestamptz' })(Reading.prototype, 'ts');
Column({ type: 'double precision' })(Reading.prototype, 'x');
Column({ type: 'double precision' })(Reading.prototype, 'y');
Hypertable({ chunkInterval: '1 day' })(Reading);
TimeColumn()(Reading.prototype, 'ts');
HypertablePrimaryKey()(Reading.prototype, 'ts');

// A clean linear set: y = 2x + 1 → slope 2, intercept 1, corr 1, R² 1, x_intercept -0.5.
// x = [1..5]: sum 15, avg 3, sample variance 2.5 (stddev √2.5), population variance 2.
const READINGS: Array<[string, number, number]> = [
  ['2024-02-01T00:00:00Z', 1, 3],
  ['2024-02-01T01:00:00Z', 2, 5],
  ['2024-02-01T02:00:00Z', 3, 7],
  ['2024-02-01T03:00:00Z', 4, 9],
  ['2024-02-01T04:00:00Z', 5, 11],
];

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
    entities: [Trade as EntityClass, Reading as EntityClass],
    synchronize: false,
  });
  await ds.initialize();
  await ds.query('DROP TABLE IF EXISTS "trade" CASCADE');
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
  for (const [ts, price, vol] of ROWS) {
    await ds.query('INSERT INTO "trade"("ts","price","vol") VALUES ($1,$2,$3)', [ts, price, vol]);
  }
  for (const [ts, x, y] of READINGS) {
    await ds.query('INSERT INTO "reading"("ts","x","y") VALUES ($1,$2,$3)', [ts, x, y]);
  }
  return { container, ds };
}

describe.skipIf(!TOOLKIT_IMAGE)('M2.2 toolkit features (toolkit image)', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    ({ container, ds } = await boot(TOOLKIT_IMAGE as string));
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('getCandlesticks returns exact OHLCV per bucket', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const candles = await repo.getCandlesticks({
      interval: '1 hour',
      priceColumn: 'price',
      volumeColumn: 'vol',
      order: 'ASC',
    });
    expect(candles).toHaveLength(2);
    // bucket 00: open 10, high 12, low 8, close 11, volume 7, vwap ~10.714
    expect(candles[0]).toMatchObject({ open: 10, high: 12, low: 8, close: 11, volume: 7 });
    expect(candles[0]?.vwap).toBeCloseTo(10.714285, 4);
    expect(candles[0]?.bucket).toBeInstanceOf(Date);
    // bucket 01: open 20, high 25, low 20, close 22, volume 4, vwap 23
    expect(candles[1]).toMatchObject({
      open: 20,
      high: 25,
      low: 20,
      close: 22,
      volume: 4,
      vwap: 23,
    });
  });

  it('getCandlesticks honours a range filter', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const candles = await repo.getCandlesticks({
      interval: '1 hour',
      priceColumn: 'price',
      volumeColumn: 'vol',
      range: { from: '2024-01-01T01:00:00Z', to: '2024-01-01T02:00:00Z' },
    });
    expect(candles).toHaveLength(1);
    expect(candles[0]?.close).toBe(22);
  });

  it('approxCountDistinct estimates distinct cardinality (string, exact for small N)', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    // 7 distinct prices (10,12,8,11,20,25,22) — HLL is exact at this scale.
    expect(await repo.approxCountDistinct({ column: 'price' })).toBe('7');
  });

  it('approxCountDistinct honours a range filter', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    // bucket 01 window has 3 distinct prices (20, 25, 22).
    expect(
      await repo.approxCountDistinct({
        column: 'price',
        range: { from: '2024-01-01T01:00:00Z', to: '2024-01-01T02:00:00Z' },
      }),
    ).toBe('3');
  });

  // ---- M2.3a: stats_agg / percentile_agg ----

  it('getStats returns exact 1D statistics (sample method default)', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const s = await repo.getStats({ valueColumn: 'x' });
    expect(s).not.toBeNull();
    expect(s?.numVals).toBe(5);
    expect(s?.average).toBeCloseTo(3, 10);
    expect(s?.sum).toBeCloseTo(15, 10);
    // sample variance = 10/4 = 2.5; sample stddev = √2.5.
    expect(s?.variance).toBeCloseTo(2.5, 10);
    expect(s?.stddev).toBeCloseTo(Math.sqrt(2.5), 10);
    // symmetric set → skewness ~ 0.
    expect(s?.skewness).toBeCloseTo(0, 6);
  });

  it('getStats honours the population method and a range filter', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    // population variance over x = [1..5] is 2 (stddev √2).
    const pop = await repo.getStats({ valueColumn: 'x', method: 'population' });
    expect(pop?.variance).toBeCloseTo(2, 10);
    expect(pop?.stddev).toBeCloseTo(Math.sqrt(2), 10);
    // range [00:00, 02:00) → x = [1, 2]: avg 1.5, sum 3, numVals 2.
    const ranged = await repo.getStats({
      valueColumn: 'x',
      range: { from: '2024-02-01T00:00:00Z', to: '2024-02-01T02:00:00Z' },
    });
    expect(ranged?.numVals).toBe(2);
    expect(ranged?.average).toBeCloseTo(1.5, 10);
    expect(ranged?.sum).toBeCloseTo(3, 10);
  });

  it('getStats returns null for an empty set', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    expect(
      await repo.getStats({
        valueColumn: 'x',
        range: { from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' },
      }),
    ).toBeNull();
  });

  it('getRegression returns exact regression for y = 2x + 1', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const r = await repo.getRegression({ yColumn: 'y', xColumn: 'x' });
    expect(r).not.toBeNull();
    expect(r?.numVals).toBe(5);
    expect(r?.slope).toBeCloseTo(2, 10);
    expect(r?.intercept).toBeCloseTo(1, 10);
    expect(r?.xIntercept).toBeCloseTo(-0.5, 10);
    expect(r?.corr).toBeCloseTo(1, 10);
    expect(r?.determinationCoeff).toBeCloseTo(1, 10);
    expect(r?.averageX).toBeCloseTo(3, 10);
    expect(r?.averageY).toBeCloseTo(7, 10);
    expect(r?.sumX).toBeCloseTo(15, 10);
    expect(r?.sumY).toBeCloseTo(35, 10);
  });

  it('getPercentiles estimates percentiles + mean/error/count', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const p = await repo.getPercentiles({ valueColumn: 'x', percentiles: [0.25, 0.5, 0.75, 0.99] });
    expect(p).not.toBeNull();
    expect(p?.numVals).toBe(5);
    expect(p?.mean).toBeCloseTo(3, 6);
    expect(p?.error).toBeGreaterThanOrEqual(0);
    expect(p?.percentiles).toHaveLength(4);
    // uddsketch is approximate; assert tight monotone bands over x = [1..5].
    const [p25, p50, p75, p99] = p!.percentiles;
    expect(p25).toBeGreaterThanOrEqual(1);
    expect(p25).toBeLessThanOrEqual(p50);
    expect(p50).toBeCloseTo(3, 0);
    expect(p75).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeLessThanOrEqual(5);
    expect(p99).toBeGreaterThanOrEqual(p75);
  });

  it('getPercentileRanks estimates ranks (inverse of percentile)', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const ranks = await repo.getPercentileRanks({ valueColumn: 'x', values: [1, 3, 5] });
    expect(ranks).not.toBeNull();
    expect(ranks).toHaveLength(3);
    // x = [1..5]: ranks are monotone non-decreasing in [0,1]; the median value (3)
    // sits mid-distribution. approx_percentile_rank is approximate and its exact
    // tie convention varies, so assert a band around the middle rather than a point.
    const [r1, r3, r5] = ranks!;
    expect(r1).toBeGreaterThanOrEqual(0);
    expect(r1).toBeLessThanOrEqual(r3);
    expect(r3).toBeLessThanOrEqual(r5);
    expect(r5).toBeLessThanOrEqual(1);
    expect(r3).toBeGreaterThanOrEqual(0.4);
    expect(r3).toBeLessThanOrEqual(0.7);
  });

  it('getPercentiles rejects an empty percentile list', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    await expect(repo.getPercentiles({ valueColumn: 'x', percentiles: [] })).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
  });
});

describe.skipIf(!STOCK_IMAGE)('M2.2 toolkit guard (stock image, no toolkit)', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    ({ container, ds } = await boot(STOCK_IMAGE as string));
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('getCandlesticks throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    await expect(
      repo.getCandlesticks({ interval: '1 hour', priceColumn: 'price', volumeColumn: 'vol' }),
    ).rejects.toMatchObject({ code: TimescaleErrorCode.TOOLKIT_MISSING });
  });

  it('approxCountDistinct throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    await expect(repo.approxCountDistinct({ column: 'price' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getStats throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    await expect(repo.getStats({ valueColumn: 'x' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getRegression throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    await expect(repo.getRegression({ yColumn: 'y', xColumn: 'x' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getPercentiles throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    await expect(
      repo.getPercentiles({ valueColumn: 'x', percentiles: [0.5] }),
    ).rejects.toMatchObject({ code: TimescaleErrorCode.TOOLKIT_MISSING });
  });
});

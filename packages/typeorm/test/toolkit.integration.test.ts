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
    entities: [Trade as EntityClass],
    synchronize: false,
  });
  await ds.initialize();
  await ds.query('DROP TABLE IF EXISTS "trade" CASCADE');
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
    await expect(repo.approxCountDistinct({ column: 'price' })).rejects.toBeInstanceOf(
      TimescaleError,
    );
  });
});

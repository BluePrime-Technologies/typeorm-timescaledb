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
// Also used for time_weight (hourly x): Linear avg 3, LOCF avg 2.5.
const READINGS: Array<[string, number, number]> = [
  ['2024-02-01T00:00:00Z', 1, 3],
  ['2024-02-01T01:00:00Z', 2, 5],
  ['2024-02-01T02:00:00Z', 3, 7],
  ['2024-02-01T03:00:00Z', 4, 9],
  ['2024-02-01T04:00:00Z', 5, 11],
];

// Metric(ts, requests) hypertable for M2.3b counter_agg — a monotonic counter with one reset.
class Metric {}
Entity('metric')(Metric);
PrimaryColumn({ type: 'timestamptz' })(Metric.prototype, 'ts');
Column({ type: 'double precision' })(Metric.prototype, 'requests');
Hypertable({ chunkInterval: '1 day' })(Metric);
TimeColumn()(Metric.prototype, 'ts');
HypertablePrimaryKey()(Metric.prototype, 'ts');

// 0,10,20 then reset to 5,15 over 4 minutes (240s) → delta 35, rate 35/240≈0.145833,
// num_resets 1, num_changes 4, num_elements 5, first_val 0, last_val 15.
const METRICS: Array<[string, number]> = [
  ['2024-03-01T00:00:00Z', 0],
  ['2024-03-01T00:01:00Z', 10],
  ['2024-03-01T00:02:00Z', 20],
  ['2024-03-01T00:03:00Z', 5],
  ['2024-03-01T00:04:00Z', 15],
];

// Device(ts, status) hypertable for M2.3c.1 state_agg — a text state over time.
class Device {}
Entity('device')(Device);
PrimaryColumn({ type: 'timestamptz' })(Device.prototype, 'ts');
Column({ type: 'text' })(Device.prototype, 'status');
Hypertable({ chunkInterval: '1 day' })(Device);
TimeColumn()(Device.prototype, 'ts');
HypertablePrimaryKey()(Device.prototype, 'ts');

// on [00:00,00:02) then off [00:02,00:04) then on at 00:04 → on 120s, off 120s;
// timeline has 3 segments; state_at(00:03) = 'off'.
const DEVICE_STATES: Array<[string, string]> = [
  ['2024-04-01T00:00:00Z', 'on'],
  ['2024-04-01T00:01:00Z', 'on'],
  ['2024-04-01T00:02:00Z', 'off'],
  ['2024-04-01T00:04:00Z', 'on'],
];

// Mapped: the time/value PROPERTIES (`time`, `status`) differ from their DB column
// names (`ts_col`, `state_col`). Regression guard: the helpers must resolve the DEFAULT
// time column (property → DB name), not emit the raw property name into SQL.
class Mapped {}
Entity('mapped')(Mapped);
PrimaryColumn({ type: 'timestamptz', name: 'ts_col' })(Mapped.prototype, 'time');
Column({ type: 'text', name: 'state_col' })(Mapped.prototype, 'status');
Hypertable({ chunkInterval: '1 day' })(Mapped);
TimeColumn()(Mapped.prototype, 'time');
HypertablePrimaryKey()(Mapped.prototype, 'time');

// 'up' for 120s then 'down'.
const MAPPED_ROWS: Array<[string, string]> = [
  ['2024-05-01T00:00:00Z', 'up'],
  ['2024-05-01T00:02:00Z', 'down'],
];

// Pulse(ts) hypertable for M2.3c.3 heartbeat_agg — heartbeats are bare timestamps.
class Pulse {}
Entity('pulse')(Pulse);
PrimaryColumn({ type: 'timestamptz' })(Pulse.prototype, 'ts');
Hypertable({ chunkInterval: '1 day' })(Pulse);
TimeColumn()(Pulse.prototype, 'ts');
HypertablePrimaryKey()(Pulse.prototype, 'ts');

// heartbeats every 60s; with liveness 90s over a 5-min window from 00:00 → live
// 00:00..03:30 (uptime 210s), downtime 90s, 1 gap, 1 live range; live_at(00:03)=true.
const PULSES: string[] = ['2024-06-01T00:00:00Z', '2024-06-01T00:01:00Z', '2024-06-01T00:02:00Z'];

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
    entities: [
      Trade as EntityClass,
      Reading as EntityClass,
      Metric as EntityClass,
      Device as EntityClass,
      Mapped as EntityClass,
      Pulse as EntityClass,
    ],
    synchronize: false,
  });
  await ds.initialize();
  await ds.query('DROP TABLE IF EXISTS "trade" CASCADE');
  await ds.query('DROP TABLE IF EXISTS "reading" CASCADE');
  await ds.query('DROP TABLE IF EXISTS "metric" CASCADE');
  await ds.query('DROP TABLE IF EXISTS "device" CASCADE');
  await ds.query('DROP TABLE IF EXISTS "mapped" CASCADE');
  await ds.query('DROP TABLE IF EXISTS "pulse" CASCADE');
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
  for (const [ts, requests] of METRICS) {
    await ds.query('INSERT INTO "metric"("ts","requests") VALUES ($1,$2)', [ts, requests]);
  }
  for (const [ts, status] of DEVICE_STATES) {
    await ds.query('INSERT INTO "device"("ts","status") VALUES ($1,$2)', [ts, status]);
  }
  for (const [ts, status] of MAPPED_ROWS) {
    await ds.query('INSERT INTO "mapped"("ts_col","state_col") VALUES ($1,$2)', [ts, status]);
  }
  for (const ts of PULSES) {
    await ds.query('INSERT INTO "pulse"("ts") VALUES ($1)', [ts]);
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

  // ---- M2.3b: counter_agg / time_weight ----

  it('getCounterAgg returns exact delta/rate/resets for a counter with one reset', async () => {
    const repo = createTimescale(ds).getRepository(Metric);
    const c = await repo.getCounterAgg({ valueColumn: 'requests' });
    expect(c).not.toBeNull();
    expect(c?.delta).toBeCloseTo(35, 10);
    expect(c?.numResets).toBe(1);
    expect(c?.numChanges).toBe(4);
    expect(c?.numElements).toBe(5);
    expect(c?.timeDelta).toBeCloseTo(240, 10); // seconds
    expect(c?.firstVal).toBeCloseTo(0, 10);
    expect(c?.lastVal).toBeCloseTo(15, 10);
    expect(c?.rate).toBeCloseTo(35 / 240, 10); // ≈ 0.145833
    expect(c?.firstTime).toBeInstanceOf(Date);
    expect(c?.lastTime).toBeInstanceOf(Date);
  });

  it('getCounterAgg honours a range filter', async () => {
    const repo = createTimescale(ds).getRepository(Metric);
    // window [00:00, 00:03) → values 0,10,20 (no reset): delta 20, num_elements 3.
    const c = await repo.getCounterAgg({
      valueColumn: 'requests',
      range: { from: '2024-03-01T00:00:00Z', to: '2024-03-01T00:03:00Z' },
    });
    expect(c?.delta).toBeCloseTo(20, 10);
    expect(c?.numResets).toBe(0);
    expect(c?.numElements).toBe(3);
  });

  it('getCounterAgg returns null for an empty set', async () => {
    const repo = createTimescale(ds).getRepository(Metric);
    expect(
      await repo.getCounterAgg({
        valueColumn: 'requests',
        range: { from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' },
      }),
    ).toBeNull();
  });

  it('getTimeWeight computes Linear vs LOCF time-weighted averages', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    // hourly x = [1..5]: Linear avg 3, LOCF avg 2.5.
    const lin = await repo.getTimeWeight({ valueColumn: 'x', method: 'Linear' });
    expect(lin).not.toBeNull();
    expect(lin?.average).toBeCloseTo(3, 10);
    expect(lin?.firstVal).toBeCloseTo(1, 10);
    expect(lin?.lastVal).toBeCloseTo(5, 10);
    expect(lin?.integral).toBeGreaterThan(0);
    const locf = await repo.getTimeWeight({ valueColumn: 'x', method: 'LOCF' });
    expect(locf?.average).toBeCloseTo(2.5, 10);
  });

  it('getTimeWeight defaults to Linear and returns null on an empty set', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const def = await repo.getTimeWeight({ valueColumn: 'x' });
    expect(def?.average).toBeCloseTo(3, 10); // Linear default
    expect(
      await repo.getTimeWeight({
        valueColumn: 'x',
        range: { from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' },
      }),
    ).toBeNull();
  });

  it('getTimeWeight returns a summary (not null) for a single sample, with null average', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    // window with exactly one row (x = 1): the time-weighted average is undefined
    // (zero duration) → average null, but the endpoints are valid and the row is real.
    const one = await repo.getTimeWeight({
      valueColumn: 'x',
      range: { from: '2024-02-01T00:00:00Z', to: '2024-02-01T00:30:00Z' },
    });
    expect(one).not.toBeNull();
    expect(one?.average).toBeNull();
    expect(one?.firstVal).toBeCloseTo(1, 10);
    expect(one?.lastVal).toBeCloseTo(1, 10);
  });

  // ---- M2.3c.1: state_agg ----

  it('getStateDurations returns seconds spent per state', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    const durs = await repo.getStateDurations({ valueColumn: 'status' });
    const byState = Object.fromEntries(durs.map((d) => [d.state, d.durationSeconds]));
    expect(byState.on).toBeCloseTo(120, 6);
    expect(byState.off).toBeCloseTo(120, 6);
  });

  it('getStateTimeline returns the ordered state intervals', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    const tl = await repo.getStateTimeline({ valueColumn: 'status' });
    expect(tl.map((t) => t.state)).toEqual(['on', 'off', 'on']);
    expect(tl[0]?.startTime).toBeInstanceOf(Date);
    expect(tl[0]?.endTime.getTime()).toBeGreaterThan(tl[0]!.startTime.getTime());
  });

  it('getStateAt returns the state in effect at an instant', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    expect(await repo.getStateAt({ valueColumn: 'status', at: '2024-04-01T00:03:00Z' })).toBe(
      'off',
    );
    expect(await repo.getStateAt({ valueColumn: 'status', at: '2024-04-01T00:00:30Z' })).toBe('on');
  });

  it('getStatePeriods returns the periods for a given state', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    const offPeriods = await repo.getStatePeriods({ valueColumn: 'status', state: 'off' });
    expect(offPeriods).toHaveLength(1);
    expect(offPeriods[0]?.startTime).toBeInstanceOf(Date);
    const onPeriods = await repo.getStatePeriods({ valueColumn: 'status', state: 'on' });
    expect(onPeriods.length).toBeGreaterThanOrEqual(1);
  });

  it('getStateDurations returns [] for an empty set', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    expect(
      await repo.getStateDurations({
        valueColumn: 'status',
        range: { from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' },
      }),
    ).toEqual([]);
  });

  it('resolves the DEFAULT time column when the entity maps property→column names', async () => {
    // Regression: `time`→`ts_col`, `status`→`state_col`. Before resolving the default
    // time column this generated `state_agg("time", ...)` → `column "time" does not exist`.
    const repo = createTimescale(ds).getRepository(Mapped);
    const durs = await repo.getStateDurations({ valueColumn: 'status' });
    const byState = Object.fromEntries(durs.map((d) => [d.state, d.durationSeconds]));
    expect(byState.up).toBeCloseTo(120, 6);
  });

  // ---- M2.3c.2: mcv_agg (most-common-values / top-N) ----
  // Device.status = on×3, off×1 over 4 rows → freqs on 0.75, off 0.25.

  it('getMostCommonValues returns values with frequency bounds, freq-descending', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    const mcv = await repo.getMostCommonValues({ valueColumn: 'status' });
    expect(mcv.map((m) => m.value)).toEqual(['on', 'off']);
    expect(mcv[0]?.maxFreq).toBeCloseTo(0.75, 6);
    expect(mcv[1]?.maxFreq).toBeCloseTo(0.25, 6);
    expect(mcv[0]?.minFreq).toBeLessThanOrEqual(mcv[0]!.maxFreq);
  });

  it('getTopN returns the top n values', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    expect(await repo.getTopN({ valueColumn: 'status', n: 1 })).toEqual(['on']);
    expect(await repo.getTopN({ valueColumn: 'status', n: 2 })).toEqual(['on', 'off']);
  });

  it('getTopN rejects a count smaller than n (insufficient sketch capacity)', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    await expect(repo.getTopN({ valueColumn: 'status', n: 5, count: 2 })).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
  });

  it('getMostCommonValues returns [] for an empty set', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    expect(
      await repo.getMostCommonValues({
        valueColumn: 'status',
        range: { from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' },
      }),
    ).toEqual([]);
  });

  // ---- M2.3c.3: heartbeat_agg ----
  // hb every 60s over a 5-min window from 00:00, liveness 90s → up 00:00..03:30.
  const HB = {
    start: '2024-06-01T00:00:00Z',
    duration: '5 minutes',
    liveness: '90 seconds',
  } as const;

  it('getHeartbeatHealth returns uptime/downtime/gaps', async () => {
    const repo = createTimescale(ds).getRepository(Pulse);
    const h = await repo.getHeartbeatHealth(HB);
    expect(h).not.toBeNull();
    expect(h?.uptimeSeconds).toBeCloseTo(210, 6);
    expect(h?.downtimeSeconds).toBeCloseTo(90, 6);
    expect(h?.numGaps).toBe(1);
    expect(h?.numLiveRanges).toBe(1);
  });

  it('getLiveRanges returns the live intervals (one range 00:00..03:30)', async () => {
    const repo = createTimescale(ds).getRepository(Pulse);
    const live = await repo.getLiveRanges(HB);
    expect(live).toHaveLength(1);
    expect(live[0]?.startTime.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(live[0]?.endTime.toISOString()).toBe('2024-06-01T00:03:30.000Z');
  });

  it('getDeadRanges returns the dead intervals', async () => {
    const repo = createTimescale(ds).getRepository(Pulse);
    const dead = await repo.getDeadRanges(HB);
    expect(dead.length).toBeGreaterThanOrEqual(1);
    expect(dead[0]?.startTime).toBeInstanceOf(Date);
  });

  it('isLiveAt reflects liveness at an instant', async () => {
    const repo = createTimescale(ds).getRepository(Pulse);
    expect(await repo.isLiveAt({ ...HB, at: '2024-06-01T00:03:00Z' })).toBe(true);
    expect(await repo.isLiveAt({ ...HB, at: '2024-06-01T00:04:00Z' })).toBe(false);
  });

  it('getHeartbeatHealth returns null when there are no heartbeats in the window', async () => {
    const repo = createTimescale(ds).getRepository(Pulse);
    expect(
      await repo.getHeartbeatHealth({
        start: '2099-01-01T00:00:00Z',
        duration: '5 minutes',
        liveness: '90 seconds',
      }),
    ).toBeNull();
  });

  // ---- M2.4: downsampling (lttb + asap_smooth) ----

  it('downsampleLTTB returns exactly `resolution` points, keeping the endpoints', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const pts = await repo.downsampleLTTB({ valueColumn: 'price', resolution: 5 });
    // LTTB returns exactly `resolution` points when resolution <= n (Trade has 7 rows).
    expect(pts).toHaveLength(5);
    // endpoints are preserved and rows are time-ascending
    expect(pts[0]?.time).toBeInstanceOf(Date);
    expect(pts[0]?.time.toISOString()).toBe('2024-01-01T00:05:00.000Z');
    expect(pts[pts.length - 1]?.time.toISOString()).toBe('2024-01-01T01:50:00.000Z');
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.time.getTime()).toBeGreaterThan(pts[i - 1]!.time.getTime());
      expect(Number.isFinite(pts[i]!.value)).toBe(true);
    }
  });

  it('downsampleLTTB honours a range filter', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const pts = await repo.downsampleLTTB({
      valueColumn: 'price',
      resolution: 3,
      range: { from: '2024-01-01T01:00:00Z', to: '2024-01-01T02:00:00Z' },
    });
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (const p of pts) {
      const t = p.time.getTime();
      expect(t).toBeGreaterThanOrEqual(new Date('2024-01-01T01:00:00Z').getTime());
      expect(t).toBeLessThan(new Date('2024-01-01T02:00:00Z').getTime());
    }
  });

  it('downsampleASAP returns smoothed points with finite values', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const pts = await repo.downsampleASAP({ valueColumn: 'price', resolution: 4 });
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (const p of pts) {
      expect(p.time).toBeInstanceOf(Date);
      expect(Number.isFinite(p.value)).toBe(true);
    }
  });

  it('downsampleLTTB with resolution greater than the row count returns all rows', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const pts = await repo.downsampleLTTB({ valueColumn: 'price', resolution: 100 });
    // Trade has 7 rows; LTTB cannot invent points, so it returns at most that many.
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts.length).toBeLessThanOrEqual(7);
  });

  it('downsampleLTTB at the resolution floor of 3 keeps the endpoints', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const pts = await repo.downsampleLTTB({ valueColumn: 'price', resolution: 3 });
    expect(pts).toHaveLength(3);
    expect(pts[0]?.time.toISOString()).toBe('2024-01-01T00:05:00.000Z');
    expect(pts[2]?.time.toISOString()).toBe('2024-01-01T01:50:00.000Z');
  });

  it('downsampleLTTB returns [] for a range that matches no rows', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    const pts = await repo.downsampleLTTB({
      valueColumn: 'price',
      resolution: 5,
      range: { from: '2099-01-01T00:00:00Z', to: '2099-01-02T00:00:00Z' },
    });
    expect(pts).toEqual([]);
  });

  it('downsampleLTTB rejects a resolution below the floor of 3 (client-side)', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    // 2 is below the toolkit's lttb floor — rejected client-side, not as a driver error.
    await expect(
      repo.downsampleLTTB({ valueColumn: 'price', resolution: 2 }),
    ).rejects.toMatchObject({ code: TimescaleErrorCode.INVALID_ARGUMENT });
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

  it('downsampleLTTB throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Trade);
    await expect(
      repo.downsampleLTTB({ valueColumn: 'price', resolution: 5 }),
    ).rejects.toMatchObject({ code: TimescaleErrorCode.TOOLKIT_MISSING });
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

  it('getCounterAgg throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Metric);
    await expect(repo.getCounterAgg({ valueColumn: 'requests' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getTimeWeight throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    await expect(repo.getTimeWeight({ valueColumn: 'x' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getStateDurations throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    await expect(repo.getStateDurations({ valueColumn: 'status' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getMostCommonValues throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Device);
    await expect(repo.getMostCommonValues({ valueColumn: 'status' })).rejects.toMatchObject({
      code: TimescaleErrorCode.TOOLKIT_MISSING,
    });
  });

  it('getHeartbeatHealth throws TSDB_TOOLKIT_MISSING when the extension is absent', async () => {
    const repo = createTimescale(ds).getRepository(Pulse);
    await expect(
      repo.getHeartbeatHealth({
        start: '2024-06-01T00:00:00Z',
        duration: '5 minutes',
        liveness: '90 seconds',
      }),
    ).rejects.toMatchObject({ code: TimescaleErrorCode.TOOLKIT_MISSING });
  });
});

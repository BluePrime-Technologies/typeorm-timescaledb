import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Repository, SelectQueryBuilder } from 'typeorm';
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
  TimescaleQueryBuilder,
  toNumber,
  toBigIntString,
  toNumberArray,
} from '../src/index.js';

type EntityClass = new (...args: never[]) => object;

/**
 * M2.0 integration coverage: the base-extension hyperfunctions (`time_bucket`,
 * `first`/`last`, `histogram`, `approx_count_distinct`), the `TimescaleQueryBuilder`
 * wrapper, the `getTimeBucket` repository convenience, and the raw-result coercion
 * helpers — each executed against a REAL TimescaleDB and asserted on exact values.
 */

const IMAGE = process.env.TIMESCALE_IMAGE;

// Reading(time, sensorId, value) hypertable.
class Reading {}
Entity('reading')(Reading);
PrimaryColumn({ type: 'timestamptz' })(Reading.prototype, 'time');
Column({ type: 'text' })(Reading.prototype, 'sensorId');
Column({ type: 'double precision' })(Reading.prototype, 'value');
Hypertable({ chunkInterval: '1 day' })(Reading);
TimeColumn()(Reading.prototype, 'time');
HypertablePrimaryKey()(Reading.prototype, 'time');

// Known dataset across two hourly buckets and two sensors.
//   bucket 00:00 → (10,'a'),(20,'a'),(30,'b')   count 3 sum 60 avg 20 min 10 max 30 first 10 last 30
//   bucket 01:00 → (40,'a'),(50,'b')            count 2 sum 90 avg 45 min 40 max 50 first 40 last 50
const ROWS: Array<[string, string, number]> = [
  ['2024-01-01T00:10:00Z', 'a', 10],
  ['2024-01-01T00:30:00Z', 'a', 20],
  ['2024-01-01T00:50:00Z', 'b', 30],
  ['2024-01-01T01:10:00Z', 'a', 40],
  ['2024-01-01T01:40:00Z', 'b', 50],
];

describe.skipIf(!IMAGE)('M2.0 hyperfunctions against real TimescaleDB', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(5432);

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

    ds = new DataSource({
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
    await ds.query(`DROP TABLE IF EXISTS "reading" CASCADE`);
    await ds.synchronize();
    const qr = ds.createQueryRunner();
    try {
      await createTimescaleMigration(
        generateTimescaleMigration(ds, { timestamp: 1700000000000 }),
      ).up(qr);
    } finally {
      await qr.release();
    }
    for (const [time, sensorId, value] of ROWS) {
      await ds.query(`INSERT INTO "reading"("time","sensorId","value") VALUES ($1,$2,$3)`, [
        time,
        sensorId,
        value,
      ]);
    }
  }, 180_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('getTimeBucket: avg/sum/min/max/count/first/last per hour bucket (exact)', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const rows = await repo.getTimeBucket({
      interval: '1 hour',
      metrics: [
        { alias: 'n', fn: 'count' },
        { alias: 'total', fn: 'sum', column: 'value' },
        { alias: 'mean', fn: 'avg', column: 'value' },
        { alias: 'lo', fn: 'min', column: 'value' },
        { alias: 'hi', fn: 'max', column: 'value' },
        { alias: 'firstVal', fn: 'first', column: 'value' },
        { alias: 'lastVal', fn: 'last', column: 'value' },
      ],
      order: 'ASC',
    });

    expect(rows).toHaveLength(2);
    expect(toBigIntString(rows[0]?.n)).toBe('3');
    expect(toNumber(rows[0]?.total)).toBe(60);
    expect(toNumber(rows[0]?.mean)).toBe(20);
    expect(toNumber(rows[0]?.lo)).toBe(10);
    expect(toNumber(rows[0]?.hi)).toBe(30);
    expect(toNumber(rows[0]?.firstVal)).toBe(10);
    expect(toNumber(rows[0]?.lastVal)).toBe(30);

    expect(toBigIntString(rows[1]?.n)).toBe('2');
    expect(toNumber(rows[1]?.total)).toBe(90);
    expect(toNumber(rows[1]?.mean)).toBe(45);
    expect(toNumber(rows[1]?.firstVal)).toBe(40);
    expect(toNumber(rows[1]?.lastVal)).toBe(50);
  });

  it('getTimeBucket: range bounds filter buckets (bound as parameters)', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const rows = await repo.getTimeBucket({
      interval: '1 hour',
      metrics: [{ alias: 'n', fn: 'count' }],
      range: { from: '2024-01-01T01:00:00Z', to: '2024-01-01T02:00:00Z' },
      order: 'ASC',
    });
    expect(rows).toHaveLength(1);
    expect(toBigIntString(rows[0]?.n)).toBe('2');
  });

  it('TimescaleQueryBuilder: histogram + first per bucket (exact)', async () => {
    const ts = createTimescale(ds);
    const rows = await ts
      .getRepository(Reading)
      .timescaleQueryBuilder('r')
      .timeBucket({ interval: '1 hour', column: 'time' }, 'bucket', { order: 'ASC' })
      .histogram({ column: 'value', min: 0, max: 100, nbuckets: 5 }, 'hist')
      .first('value', 'time', 'firstVal')
      .getRawMany<{ bucket: unknown; hist: unknown; firstVal: unknown }>();

    expect(rows).toHaveLength(2);
    // nbuckets=5 → length 7 (underflow + 5 + overflow); width 20
    expect(toNumberArray(rows[0]?.hist)).toEqual([0, 1, 2, 0, 0, 0, 0]); // 10 | 20,30
    expect(toNumberArray(rows[1]?.hist)).toEqual([0, 0, 0, 2, 0, 0, 0]); // 40,50
    expect(toNumber(rows[0]?.firstVal)).toBe(10);
    expect(toNumber(rows[1]?.firstVal)).toBe(40);
  });

  it('timezone variant buckets by local calendar day', async () => {
    const ts = createTimescale(ds);
    const rows = await ts
      .getRepository(Reading)
      .timescaleQueryBuilder('r')
      .timeBucket({ interval: '1 day', column: 'time', timezone: 'UTC' }, 'bucket', {
        order: 'ASC',
      })
      .getRawMany<{ bucket: unknown }>();
    // all rows fall on one UTC day
    expect(rows).toHaveLength(1);
  });

  it('every time_bucket variant (origin/offset/timezone/NULL-placeholder) executes on real DB', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    const m = [{ alias: 'n', fn: 'count' as const }];
    // Each of these emits a distinct time_bucket overload — prove they're valid SQL,
    // not just string-asserted (catches bad positional args / the NULL placeholder).
    await expect(
      repo.getTimeBucket({ interval: '1 hour', metrics: m, origin: '2024-01-01' }),
    ).resolves.toBeDefined();
    await expect(
      repo.getTimeBucket({ interval: '1 hour', metrics: m, offset: '30 minutes' }),
    ).resolves.toBeDefined();
    await expect(
      repo.getTimeBucket({ interval: '1 day', metrics: m, timezone: 'UTC', offset: '6 hours' }),
    ).resolves.toBeDefined(); // NULL::timestamptz origin placeholder path
    await expect(
      repo.getTimeBucket({
        interval: '1 day',
        metrics: m,
        timezone: 'UTC',
        origin: '2024-01-01',
        offset: '6 hours',
      }),
    ).resolves.toBeDefined();
  });

  it('typed layer (getTimeBucket) rejects an unsafe metric column — injection guard', () => {
    const repo = createTimescale(ds).getRepository(Reading);
    expect(() =>
      repo.getTimeBucket({
        interval: '1 hour',
        metrics: [{ alias: 'x', fn: 'sum', column: 'value); DROP TABLE reading;--' }],
      }),
    ).toThrowError(TimescaleError);
  });

  it('isolation: no global prototype mutation AND the cached repo stays unpolluted', () => {
    const beforeQB = SelectQueryBuilder.prototype.getRawMany;
    const beforeRepoSave = Repository.prototype.save;

    const ts = createTimescale(ds);
    const tsRepo = ts.getRepository(Reading);
    expect(tsRepo.timescaleQueryBuilder('r')).toBeInstanceOf(TimescaleQueryBuilder);
    tsRepo.timescaleQueryBuilder('r').timeBucket({ interval: '1 hour', column: 'time' });

    // prototypes untouched
    expect(SelectQueryBuilder.prototype.getRawMany).toBe(beforeQB);
    expect(Repository.prototype.save).toBe(beforeRepoSave);
    expect('getTimeBucket' in Repository.prototype).toBe(false);

    // the TypeORM cached repo for the same entity is NOT polluted by augmentation
    const plain = ds.getRepository(Reading);
    expect('getTimeBucket' in plain).toBe(false);
    expect('timescaleMetadata' in plain).toBe(false);
  });

  it('gapfill + locf: empty buckets are created and carry the last value forward', async () => {
    const repo = createTimescale(ds).getRepository(Reading);
    // 4 hourly buckets 00:00–04:00; data only in 00 (avg 20) and 01 (avg 45) → 02,03 empty.
    const rows = await repo.getTimeBucket({
      interval: '1 hour',
      metrics: [{ alias: 'mean', fn: 'avg', column: 'value', fill: 'locf' }],
      gapfill: { start: '2024-01-01T00:00:00Z', finish: '2024-01-01T04:00:00Z' },
    });
    expect(rows).toHaveLength(4); // gapfill fabricated the two empty buckets
    expect(toNumber(rows[0]?.mean)).toBe(20);
    expect(toNumber(rows[1]?.mean)).toBe(45);
    expect(toNumber(rows[2]?.mean)).toBe(45); // locf carried 01's value forward
    expect(toNumber(rows[3]?.mean)).toBe(45);
  });

  it('TimescaleQueryBuilder gapfill + interpolate emits valid SQL that executes', async () => {
    const rows = await createTimescale(ds)
      .getRepository(Reading)
      .timescaleQueryBuilder('r')
      .timeBucketGapfill(
        {
          interval: '1 hour',
          column: 'time',
          start: '2024-01-01T00:00:00Z',
          finish: '2024-01-01T04:00:00Z',
        },
        'bucket',
        { order: 'ASC' },
      )
      .interpolate({ fn: 'avg', column: 'value' }, 'mean')
      .getRawMany<{ bucket: unknown; mean: unknown }>();
    expect(rows).toHaveLength(4);
  });

  it('gapfill validation: fill without gapfill, and gapfill without bounds, both throw', () => {
    const repo = createTimescale(ds).getRepository(Reading);
    expect(() =>
      repo.getTimeBucket({
        interval: '1 hour',
        metrics: [{ alias: 'm', fn: 'avg', column: 'value', fill: 'locf' }],
      }),
    ).toThrowError(TimescaleError);
    expect(() =>
      repo.getTimeBucket({
        interval: '1 hour',
        metrics: [{ alias: 'm', fn: 'avg', column: 'value' }],
        gapfill: {}, // no bounds (no gapfill.start/finish, no range)
      }),
    ).toThrowError(TimescaleError);
    // DESC ordering is incompatible with a forward-filling metric
    expect(() =>
      repo.getTimeBucket({
        interval: '1 hour',
        metrics: [{ alias: 'm', fn: 'avg', column: 'value', fill: 'locf' }],
        gapfill: { start: '2024-01-01T00:00:00Z', finish: '2024-01-01T04:00:00Z' },
        order: 'DESC',
      }),
    ).toThrowError(TimescaleError);
    // a lone gapfill.start (without finish) must not be silently dropped
    expect(() =>
      repo.getTimeBucket({
        interval: '1 hour',
        metrics: [{ alias: 'm', fn: 'avg', column: 'value' }],
        gapfill: { start: '2024-01-01T00:00:00Z' },
        range: { from: '2024-01-01T00:00:00Z', to: '2024-01-01T04:00:00Z' },
      }),
    ).toThrowError(TimescaleError);
  });
});

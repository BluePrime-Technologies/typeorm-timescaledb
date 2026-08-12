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
  ContinuousAggregate,
  BucketColumn,
  AggregateColumn,
  createTimescale,
  createTimescaleMigration,
  generateTimescaleMigration,
  TimescaleErrorCode,
} from '../src/index.js';

type EntityClass = new (...args: never[]) => object;

// M2.6 — informational views + jobs. Core TimescaleDB (no toolkit), so any image works.
const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

// A hypertable with columnstore + retention policies (→ background jobs) and data (→ chunks).
class Metric {}
Entity('metric')(Metric);
PrimaryColumn({ type: 'timestamptz' })(Metric.prototype, 'ts');
Column({ type: 'double precision' })(Metric.prototype, 'value');
Hypertable({
  chunkInterval: '1 day',
  columnstore: { orderBy: [{ column: 'ts', direction: 'DESC' }], compressAfter: '30 days' },
  retention: { dropAfter: '365 days' },
})(Metric);
TimeColumn()(Metric.prototype, 'ts');
HypertablePrimaryKey()(Metric.prototype, 'ts');

// A continuous aggregate (with a refresh policy) over Metric — appears in the CAGG + jobs views.
class MetricDaily {}
ContinuousAggregate({
  name: 'metric_daily',
  source: Metric,
  bucket: '1 day',
  refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '1 hour' },
})(MetricDaily);
BucketColumn()(MetricDaily.prototype, 'bucket');
AggregateColumn({ fn: 'avg', column: 'value' })(MetricDaily.prototype, 'avgValue');

async function boot(image: string): Promise<{ container: StartedTestContainer; ds: DataSource }> {
  const container = await new GenericContainer(image)
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const ds = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getMappedPort(5432),
    username: 'postgres',
    password: 'test',
    database: 'test',
    entities: [Metric as EntityClass],
    synchronize: false,
  });
  const admin = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getMappedPort(5432),
    username: 'postgres',
    password: 'test',
    database: 'test',
  });
  await admin.initialize();
  await admin.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  await admin.destroy();

  await ds.initialize();
  await ds.query('DROP TABLE IF EXISTS "metric" CASCADE');
  await ds.synchronize();
  const qr = ds.createQueryRunner();
  try {
    await createTimescaleMigration(
      generateTimescaleMigration(ds, {
        timestamp: 1700000000000,
        continuousAggregates: [MetricDaily],
      }),
    ).up(qr);
  } finally {
    await qr.release();
  }
  // Three days of hourly data → at least 3 daily chunks.
  await ds.query(
    `INSERT INTO "metric"("ts","value")
       SELECT g, extract(epoch from g)::int % 100
       FROM generate_series(now() - interval '3 days', now(), interval '1 hour') g`,
  );
  return { container, ds };
}

describe.skipIf(!IMAGE)('M2.6 informational views + jobs', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  beforeAll(async () => {
    ({ container, ds } = await boot(IMAGE as string));
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('listHypertables reports the hypertable with compression enabled', async () => {
    const hts = await createTimescale(ds).listHypertables();
    const m = hts.find((h) => h.name === 'metric');
    expect(m).toBeDefined();
    expect(m?.schema).toBe('public');
    expect(m?.numDimensions).toBeGreaterThanOrEqual(1);
    expect(m?.compressionEnabled).toBe(true);
  });

  it('listChunks returns chunks and honours the hypertable filter', async () => {
    const ts = createTimescale(ds);
    const all = await ts.listChunks();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const filtered = await ts.listChunks({ hypertable: 'metric' });
    expect(filtered.length).toBeGreaterThanOrEqual(3);
    expect(filtered.every((c) => c.hypertableName === 'metric')).toBe(true);
    expect(filtered[0]?.rangeStart).toBeInstanceOf(Date);
    // schema-qualified filter exercises the `AND hypertable_schema = $2` branch
    const qualified = await ts.listChunks({ hypertable: 'public.metric' });
    expect(qualified.length).toBeGreaterThanOrEqual(3);
    expect(qualified.every((c) => c.hypertableName === 'metric')).toBe(true);
    // a non-existent hypertable — and a wrong schema — yield no chunks
    expect(await ts.listChunks({ hypertable: 'nope' })).toEqual([]);
    expect(await ts.listChunks({ hypertable: 'nope.metric' })).toEqual([]);
  });

  it('listContinuousAggregates includes the CAGG', async () => {
    const caggs = await createTimescale(ds).listContinuousAggregates();
    const c = caggs.find((x) => x.viewName === 'metric_daily');
    expect(c).toBeDefined();
    expect(c?.viewSchema).toBe('public');
  });

  it('listJobs lists policy jobs and honours the hypertable filter', async () => {
    const ts = createTimescale(ds);
    const jobs = await ts.listJobs();
    const procs = jobs.map((j) => j.procName);
    // columnstore/compression + retention + CAGG refresh policies each register a job
    expect(procs).toContain('policy_retention');
    expect(procs.some((p) => p === 'policy_compression' || p === 'policy_columnstore')).toBe(true);
    expect(procs).toContain('policy_refresh_continuous_aggregate');
    const metricJobs = await ts.listJobs({ hypertable: 'metric' });
    expect(metricJobs.length).toBeGreaterThanOrEqual(2);
    expect(metricJobs.every((j) => j.hypertableName === 'metric')).toBe(true);
    expect(metricJobs[0]?.jobId).toBeGreaterThan(0);
  });

  it("listJobs finds a CONTINUOUS AGGREGATE's refresh job by its user-facing view name", async () => {
    // The bug this pins: `jobs.hypertable_name` is the user-facing view on 2.28+ but the INTERNAL
    // materialization hypertable on 2.18. Filtering on the user name alone returned an EMPTY array
    // for a CAGG on 2.18 and the refresh job on 2.29 — no error, no warning, a different answer per
    // server. A user asking "does my aggregate have a refresh policy?" got "no" on 2.18 and could
    // add a duplicate or conclude it was unmanaged. Passing the internal name instead is not an
    // option: `_timescaledb_internal._materialized_hypertable_N` is not a name this API exposes.
    //
    // Nothing covered this before — the only filter test used a plain hypertable, which works on
    // every version, so the whole suite stayed green while the CAGG case was wrong.
    const ts = createTimescale(ds);
    const caggJobs = await ts.listJobs({ hypertable: 'metric_daily' });
    expect(caggJobs.map((j) => j.procName)).toContain('policy_refresh_continuous_aggregate');

    // The filter must still be a filter: an unrelated name returns nothing.
    expect(await ts.listJobs({ hypertable: 'no_such_relation' })).toEqual([]);

    // And it must not have become a pass-through that returns every job regardless.
    const all = await ts.listJobs();
    expect(caggJobs.length).toBeLessThan(all.length);
  });

  it('getJobStats returns a typed row (when present) and null for an unknown job', async () => {
    const ts = createTimescale(ds);
    const retention = (await ts.listJobs()).find((j) => j.procName === 'policy_retention');
    expect(retention).toBeDefined();
    // job_stats may lack a row for a never-run job (2.18 omits it; newer servers show zeros).
    // Either is valid — if a row exists it must be well-formed; a bogus id is always null.
    const stats = await ts.getJobStats(retention!.jobId);
    if (stats !== null) {
      expect(stats.jobId).toBe(retention!.jobId);
      expect(stats.totalRuns).toBeGreaterThanOrEqual(0);
    }
    expect(await ts.getJobStats(999_999)).toBeNull();
  });

  it('runJob triggers a job without error', async () => {
    const ts = createTimescale(ds);
    const retention = (await ts.listJobs()).find((j) => j.procName === 'policy_retention');
    // run_job executes the job in-session; assert the trigger succeeds (no throw). Its
    // job_stats side effects are TimescaleDB's async bookkeeping, not this package's.
    await expect(ts.runJob(retention!.jobId)).resolves.toBeUndefined();
  });

  it('runJob / getJobStats reject a non-positive job id', async () => {
    const ts = createTimescale(ds);
    await expect(ts.runJob(0)).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
    await expect(ts.getJobStats(-1)).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
    // a non-integer id is also rejected before it reaches SQL
    await expect(ts.getJobStats(1.5)).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
  });

  // ---- user-defined action jobs: add / alter / delete ----

  it('addJob registers an action job; alterJob changes fields (config survives an omitted-field alter); deleteJob removes it', async () => {
    const ts = createTimescale(ds);
    await ds.query(
      `CREATE OR REPLACE PROCEDURE noop_action(job_id int, config jsonb) LANGUAGE plpgsql AS $$ BEGIN END $$`,
    );

    // exercises the config + initialStart + fixedSchedule add_job branches
    const jobId = await ts.addJob('noop_action', {
      scheduleInterval: '1 hour',
      config: { k: 1 },
      initialStart: '2024-01-01T00:00:00Z',
      fixedSchedule: true,
    });
    expect(jobId).toBeGreaterThan(0);
    let job = (await ts.listJobs()).find((j) => j.jobId === jobId);
    expect(job?.procName).toBe('noop_action');
    expect(job?.config).toMatchObject({ k: 1 });

    // alter only the schedule → config must survive (verified 2.18 + latest)
    await ts.alterJob(jobId, { scheduleInterval: '30 minutes' });
    job = (await ts.listJobs()).find((j) => j.jobId === jobId);
    expect(job?.scheduleInterval).toBe('00:30:00');
    expect(job?.config).toMatchObject({ k: 1 });

    // config, when set, replaces wholesale
    await ts.alterJob(jobId, { config: { k: 2 }, scheduled: false });
    job = (await ts.listJobs()).find((j) => j.jobId === jobId);
    expect(job?.config).toMatchObject({ k: 2 });
    expect(job?.scheduled).toBe(false);

    // exercises the max_runtime / max_retries / retry_period alter branches
    await ts.alterJob(jobId, { maxRuntime: '5 minutes', maxRetries: 3, retryPeriod: '1 minute' });
    const raw: Array<{ max_retries: unknown }> = await ds.query(
      'SELECT max_retries FROM timescaledb_information.jobs WHERE job_id = $1',
      [jobId],
    );
    expect(Number(raw[0]?.max_retries)).toBe(3);
    // a negative maxRetries is rejected client-side
    await expect(ts.alterJob(jobId, { maxRetries: -1 })).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });

    await ts.deleteJob(jobId);
    expect((await ts.listJobs()).some((j) => j.jobId === jobId)).toBe(false);
  });

  it('alterJob with no changes, and addJob with an empty proc name, are rejected', async () => {
    const ts = createTimescale(ds);
    await expect(ts.alterJob(1000, {})).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
    await expect(ts.addJob('  ', { scheduleInterval: '1 hour' })).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
    await expect(ts.deleteJob(0)).rejects.toMatchObject({
      code: TimescaleErrorCode.INVALID_ARGUMENT,
    });
  });
});

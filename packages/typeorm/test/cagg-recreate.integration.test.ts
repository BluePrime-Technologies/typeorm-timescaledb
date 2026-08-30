import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import {
  AggregateColumn,
  BucketColumn,
  ContinuousAggregate,
  GroupColumn,
  Hypertable,
  HypertablePrimaryKey,
  TimeColumn,
  pushSchema,
} from '../src/index.js';

const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

/**
 * The RECREATE path (#216 step 3), against a real TimescaleDB.
 *
 * This is the one destructive operation the package can emit, and until this file the whole
 * `DROP` + `CREATE` sequence was exercised only against a stubbed `QueryRunner` that records SQL
 * strings and executes none of them. A recorder cannot tell you whether PostgreSQL accepts the
 * statements, whether they survive `applyDirect`'s single transaction, or — the finding that made
 * the #230 review blocking — whether the refresh policy actually comes back, because dropping a
 * continuous aggregate drops its policy job with it.
 *
 * It lives in its OWN file rather than being appended to `cagg-desired-state.integration.test.ts`
 * deliberately. That file runs sequentially against one container and its later cases depend on the
 * state earlier ones leave behind, so inserting a destructive recreate mid-way would couple this
 * test to that ordering. Every integration file here builds its own container, so a new file has no
 * such dependency.
 */
@Entity('readings')
class Reading {
  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @PrimaryColumn({ type: 'text', name: 'sensor_id' })
  sensorId!: string;

  @Column({ type: 'double precision', nullable: true })
  value!: number | null;
}
Hypertable({ chunkInterval: '1 day' })(Reading);
TimeColumn()(Reading.prototype, 'time');
HypertablePrimaryKey()(Reading.prototype, 'time');
HypertablePrimaryKey()(Reading.prototype, 'sensorId');

/** The DECLARED aggregate: a 1-DAY bucket, with a refresh policy. */
class ReadingDaily {}
ContinuousAggregate({
  name: 'reading_rollup',
  source: Reading,
  bucket: '1 day',
  refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '30 minutes' },
})(ReadingDaily);
BucketColumn()(ReadingDaily.prototype, 'bucket');
GroupColumn()(ReadingDaily.prototype, 'sensorId');
AggregateColumn({ fn: 'avg', column: 'value' })(ReadingDaily.prototype, 'avgValue');

const BASE_DDL = `
  CREATE TABLE IF NOT EXISTS readings (
    time      TIMESTAMPTZ NOT NULL,
    sensor_id TEXT        NOT NULL,
    value     DOUBLE PRECISION,
    PRIMARY KEY (time, sensor_id)
  );
`;

// The aggregate as it exists in the DATABASE: an HOURLY bucket. Same name, different grain — the
// drift the recreate exists to converge.
const EXISTING_HOURLY = `
  CREATE MATERIALIZED VIEW reading_rollup
    WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
    SELECT time_bucket(INTERVAL '1 hour', "time") AS bucket,
           sensor_id,
           avg(value) AS avg_value
      FROM readings
     GROUP BY 1, 2
    WITH NO DATA;
`;

describe.skipIf(!IMAGE)('CAGG recreate — live DROP + CREATE', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  const caggs = { continuousAggregates: [ReadingDaily] };

  /** Read the aggregate's bucket width straight from the catalog. */
  const storedDefinition = async (): Promise<string> => {
    const rows: { view_definition: string }[] = await ds.query(
      `SELECT view_definition FROM timescaledb_information.continuous_aggregates
        WHERE view_name = 'reading_rollup'`,
    );
    return rows[0]?.view_definition ?? '';
  };

  /** Count the refresh jobs attached to the aggregate — the policy the DROP takes with it. */
  const refreshJobCount = async (): Promise<number> => {
    // `jobs.hypertable_name` means DIFFERENT things across the support matrix, so this matches
    // either. Measured, not guessed:
    //
    //   2.18.0-pg16 -> `_materialized_hypertable_2`  (the materialization hypertable)
    //   latest-pg17 -> `reading_rollup`              (the user-facing view)
    //
    // The first draft used only the materialization form and passed nothing on latest; "fixing" it
    // to the view name then failed every 2.18 and 2.19 leg in CI. Pinning either one is a test that
    // silently measures nothing on half the matrix — which is worse than a red build, because the
    // assertion it guards is the blocking finding this file exists to cover.
    const rows: { n: string }[] = await ds.query(
      `SELECT count(*)::text AS n
         FROM timescaledb_information.jobs j
        WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
          AND (
            j.hypertable_name = 'reading_rollup'
            OR j.hypertable_name IN (
              SELECT c.materialization_hypertable_name
                FROM timescaledb_information.continuous_aggregates c
               WHERE c.view_name = 'reading_rollup')
          )`,
    );
    return Number(rows[0]?.n ?? '0');
  };

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
    await ds.query(BASE_DDL);
    await ds.query("SELECT create_hypertable('readings', 'time', if_not_exists => TRUE)");
    await ds.query(EXISTING_HOURLY);
    await ds.query(
      "SELECT add_continuous_aggregate_policy('reading_rollup', start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes')",
    );
  }, 300_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('starts from a genuinely drifted aggregate WITH a refresh policy', async () => {
    // Guards the fixture itself. If the seed stopped producing drift, every assertion below would
    // pass vacuously.
    expect(await storedDefinition()).toMatch(/01:00:00|1 hour/);
    expect(await refreshJobCount()).toBe(1);
  });

  it("'advise' (the default) reports the drift and changes NOTHING", async () => {
    const result = await pushSchema(ds, { ...caggs, apply: true });

    expect(result.plan.advisories?.some((a) => a.kind === 'not-expressible')).toBe(true);
    expect(result.plan.steps.some((s) => s.operation.kind === 'recreateContinuousAggregate')).toBe(
      false,
    );
    // Untouched: still hourly, still one policy.
    expect(await storedDefinition()).toMatch(/01:00:00|1 hour/);
    expect(await refreshJobCount()).toBe(1);
  });

  it("'apply' WITHOUT allowRefused refuses before touching the database", async () => {
    await expect(
      pushSchema(ds, { ...caggs, apply: true, continuousAggregateRecreate: 'apply' }),
    ).rejects.toThrow(/continuousAggregateRecreate: 'apply'/);

    expect(await storedDefinition()).toMatch(/01:00:00|1 hour/);
    expect(await refreshJobCount()).toBe(1);
  });

  it("'plan' shows the step, holds it back, and leaves the aggregate alone", async () => {
    const result = await pushSchema(ds, {
      ...caggs,
      apply: true,
      continuousAggregateRecreate: 'plan',
    });

    expect(result.heldBack).toHaveLength(1);
    expect(result.heldBack[0]?.step.operation.kind).toBe('recreateContinuousAggregate');
    // Still hourly — `plan` never runs it, under any flag.
    expect(await storedDefinition()).toMatch(/01:00:00|1 hour/);
    expect(await refreshJobCount()).toBe(1);
  });

  it("'apply' + allowRefused converges it AND re-attaches the refresh policy", async () => {
    // The blocking finding from the #230 review, against a real catalog: dropping the aggregate
    // drops its policy job with it, so without re-attachment the view comes back not merely empty
    // but UNMAINTAINED — and with materialized_only = FALSE that is invisible, because real-time
    // aggregation keeps answering correctly until retention removes the source chunks.
    const result = await pushSchema(ds, {
      ...caggs,
      apply: true,
      continuousAggregateRecreate: 'apply',
      allowRefused: true,
    });

    expect(result.applied).toBe(true);
    expect(result.heldBack).toEqual([]);

    // Converged: the stored definition is now the DECLARED daily bucket.
    const after = await storedDefinition();
    expect(after).toMatch(/1 day|24:00:00/);
    expect(after).not.toMatch(/01:00:00/);

    // And the job is back. This is the assertion a stubbed QueryRunner cannot make.
    expect(await refreshJobCount()).toBe(1);
  });

  it('is idempotent — a converged database reports no drift and no advisory', async () => {
    const result = await pushSchema(ds, {
      ...caggs,
      continuousAggregateRecreate: 'apply',
    });

    expect(result.plan.steps).toEqual([]);
    expect(result.plan.advisories ?? []).toEqual([]);
  });
});

import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { pushCommand } from '../src/cli/index.js';
import {
  AggregateColumn,
  BucketColumn,
  ContinuousAggregate,
  GroupColumn,
  Hypertable,
  HypertablePrimaryKey,
  TimeColumn,
  compileDesiredState,
  introspect,
  pushSchema,
} from '../src/index.js';

const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

/**
 * The CAGG desired-state slice, against a real TimescaleDB.
 *
 * Unit tests cannot reach the thing that matters here. Both defects this slice was built around —
 * the catalog's parse-tree deparse of `view_definition`, and its re-rendering of intervals
 * (`1 month` → `1 mon`, `1 hour` → `01:00:00`) — only exist on the READ-BACK path, and every unit
 * fixture is hand-written IR that round-trips unchanged by construction. That is exactly how the
 * `pull` interval bug shipped green through 645 unit tests. So the assertions below deliberately go
 * through introspect() on a live database.
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

class ReadingHourly {}
ContinuousAggregate({
  name: 'reading_hourly',
  source: Reading,
  bucket: '1 hour',
  // A MONTH-based offset on purpose: the catalog reports it as '1 mon', the exact rendering that
  // made `pull` throw. If the diff compared raw strings, this would be permanent false drift.
  refresh: { startOffset: '1 month', endOffset: '1 hour', scheduleInterval: '30 minutes' },
})(ReadingHourly);
BucketColumn()(ReadingHourly.prototype, 'bucket');
GroupColumn()(ReadingHourly.prototype, 'sensorId');
AggregateColumn({ fn: 'avg', column: 'value' })(ReadingHourly.prototype, 'avgValue');
AggregateColumn({ fn: 'count' })(ReadingHourly.prototype, 'samples');

const BASE_DDL = `
  CREATE TABLE IF NOT EXISTS readings (
    time      TIMESTAMPTZ NOT NULL,
    sensor_id TEXT        NOT NULL,
    value     DOUBLE PRECISION,
    PRIMARY KEY (time, sensor_id)
  );
`;

describe.skipIf(!IMAGE)('CAGG desired state — live check/push', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

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
  }, 300_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('reports the missing CAGG as drift, converges it, then reports clean', async () => {
    // 1. The hypertable and the CAGG are both missing → both must appear in the plan. Before this
    //    slice the CAGG was simply absent from it, and a CAGG-only difference reported "no drift".
    const before = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });
    const kinds = before.plan.steps.map((s) => s.operation.kind);
    expect(kinds).toContain('createContinuousAggregateRaw');
    expect(kinds).toContain('addContinuousAggregatePolicy');
    // The CAGG is created after the hypertable it reads from.
    expect(kinds.indexOf('createHypertable')).toBeLessThan(
      kinds.indexOf('createContinuousAggregateRaw'),
    );

    // 2. Apply. This is the part no unit test can stand in for: the generated SQL has to be accepted
    //    by a real TimescaleDB.
    const applied = await pushSchema(ds, { continuousAggregates: [ReadingHourly], apply: true });
    expect(applied.applied).toBe(true);

    const live = await introspect(ds);
    const cagg = live.continuousAggregates.find((c) => c.viewName === 'public.reading_hourly');
    expect(cagg).toBeDefined();
    expect(cagg?.source).toBe('public.readings');
    expect(cagg?.refresh?.kind).toBe('refresh');

    // 3. Re-check must be CLEAN. This is the assertion that fails if desired-state names are not
    //    qualified the way introspect() reports them, or if the refresh offsets are compared as raw
    //    text — the catalog returns '1 mon' for the declared '1 month'.
    const after = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });
    expect(after.plan.steps).toEqual([]);
    expect(after.plan.advisories?.filter((a) => a.kind === 'not-expressible')).toEqual([]);
  }, 300_000);

  it('names the existing CAGG as not-compared rather than implying it was verified', async () => {
    const { plan } = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });
    expect(plan.advisories).toContainEqual(
      expect.objectContaining({ kind: 'not-compared', object: 'public.reading_hourly' }),
    );
  }, 120_000);

  it('warns that nothing was compared when the CAGG list is omitted', async () => {
    const { plan } = await pushSchema(ds);
    expect(plan.steps).toEqual([]);
    expect(plan.advisories).toContainEqual(
      expect.objectContaining({ object: '(all continuous aggregates)' }),
    );
  }, 120_000);

  it('does NOT report drift when the definition is changed out-of-band — the documented limit', async () => {
    // Locks in the limitation so nobody later mistakes it for a bug. Structural comparison needs the
    // IR enriched with parsed facets; until then presence is all that is honest, and the advisory
    // above is what tells the user so. Verified here against a REAL altered view, not a stub.
    await ds.query('DROP MATERIALIZED VIEW reading_hourly');
    await ds.query(`
      CREATE MATERIALIZED VIEW reading_hourly
        WITH (timescaledb.continuous) AS
        SELECT time_bucket('1 hour', time) AS bucket, sensor_id, max(value) AS avg_value,
               count(*) AS samples
        FROM readings GROUP BY 1, 2 WITH NO DATA
    `);

    const { plan } = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });
    // avg() became max() — genuinely different, and deliberately NOT detected.
    expect(plan.steps.map((s) => s.operation.kind)).not.toContain('createContinuousAggregateRaw');
    expect(plan.advisories).toContainEqual(
      expect.objectContaining({ kind: 'not-compared', object: 'public.reading_hourly' }),
    );
  }, 300_000);

  it('attaches a declared refresh policy to an existing CAGG that lacks one', async () => {
    // The recreate above dropped the policy along with the view, so this is the real
    // "aggregate exists, job missing" case rather than a contrived one.
    const beforeIr = await introspect(ds);
    expect(
      beforeIr.continuousAggregates.find((c) => c.viewName === 'public.reading_hourly')?.refresh,
    ).toBeUndefined();

    const { plan } = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });
    expect(plan.steps.map((s) => s.operation.kind)).toEqual(['addContinuousAggregatePolicy']);

    await pushSchema(ds, { continuousAggregates: [ReadingHourly], apply: true });
    const afterIr = await introspect(ds);
    expect(
      afterIr.continuousAggregates.find((c) => c.viewName === 'public.reading_hourly')?.refresh
        ?.kind,
    ).toBe('refresh');
  }, 300_000);

  it('does NOT let `push` report "no drift" when the only divergence is unconvergeable', async () => {
    // Found by review: `push` had its own empty-plan branch, so the advisory handling added to
    // reportPlan for `check` did not cover it — a changed refresh threshold produced zero steps,
    // printed "No drift detected", and exited 0. Provoked here against a real database by moving
    // the policy out-of-band rather than by stubbing the catalog.
    await ds.query(
      "SELECT remove_continuous_aggregate_policy('reading_hourly', if_exists => TRUE)",
    );
    await ds.query(
      "SELECT add_continuous_aggregate_policy('reading_hourly', start_offset => INTERVAL '3 months', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes')",
    );

    const lines: string[] = [];
    const logger = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const outcome = await pushCommand(ds, logger, { continuousAggregates: [ReadingHourly] });

    expect(outcome).not.toBe('no-drift'); // 'no-drift' maps to exit 0
    const out = lines.join('\n');
    expect(out).not.toMatch(/No drift detected/);
    expect(out).toMatch(/Not auto-converged:/);
    expect(out).toMatch(/refresh policy differs/);

    // Restore the declared policy so the following test sees a converged starting point.
    await ds.query(
      "SELECT remove_continuous_aggregate_policy('reading_hourly', if_exists => TRUE)",
    );
    await pushSchema(ds, { continuousAggregates: [ReadingHourly], apply: true });
  }, 300_000);

  it('never drops a CAGG the entities no longer declare, even with allowDrops', async () => {
    const { plan } = await pushSchema(ds, { continuousAggregates: [], allowDrops: true });
    // Assert on the OPERATIONS, not the serialized plan: the advisory legitimately says the
    // aggregate "will never be dropped", which a naive /drop/i over the whole JSON matches.
    expect(plan.steps.map((s) => s.operation.kind)).toEqual([]);
    // The undeclared live aggregate is named rather than silently ignored.
    expect(plan.advisories).toContainEqual(
      expect.objectContaining({ kind: 'not-compared', object: 'public.reading_hourly' }),
    );

    await pushSchema(ds, { continuousAggregates: [], allowDrops: true, apply: true });
    const live = await introspect(ds);
    expect(live.continuousAggregates.map((c) => c.viewName)).toContain('public.reading_hourly');
  }, 300_000);

  it("compiles a desired IR whose CAGG names match introspect()'s exactly", async () => {
    // The defect the unit suite caught, re-verified against the real catalog rather than against my
    // own belief about what the catalog reports.
    const desired = compileDesiredState(ds, { continuousAggregates: [ReadingHourly] });
    const live = await introspect(ds);
    const desiredNames = desired.continuousAggregates.map((c) => c.viewName);
    const liveNames = live.continuousAggregates.map((c) => c.viewName);
    expect(liveNames).toEqual(expect.arrayContaining(desiredNames));
    expect(desired.continuousAggregates[0]?.source).toBe('public.readings');
  }, 120_000);
});

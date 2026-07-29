import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { isEmptyPlan, diffSchemaState } from '@blueprime/timescaledb-core';
import {
  pushSchema,
  introspect,
  compileDesiredState,
  Hypertable,
  TimeColumn,
  HypertablePrimaryKey,
} from '../src/index.js';

const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

@Entity('pushed')
class Pushed {
  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @Column({ type: 'double precision' })
  value!: number;
}
Hypertable({ chunkInterval: '1 day', retention: { dropAfter: '90 days' } })(Pushed);
TimeColumn()(Pushed.prototype, 'time');
HypertablePrimaryKey()(Pushed.prototype, 'time');

describe.skipIf(!IMAGE)('M4.4a push — live convergence', () => {
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
      entities: [Pushed],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await ds.synchronize(); // plain table only — the TimescaleDB layer is what push converges
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  const isHypertable = async (): Promise<boolean> => {
    const r: Array<{ n: string }> = await ds.query(
      `SELECT count(*)::text AS n FROM timescaledb_information.hypertables
        WHERE hypertable_schema='public' AND hypertable_name='pushed'`,
    );
    return r[0]!.n === '1';
  };

  it('previews drift WITHOUT touching the database', async () => {
    const result = await pushSchema(ds);
    expect(isEmptyPlan(result.plan)).toBe(false); // there is drift
    expect(result.applied).toBe(false);
    // the decisive assertion: the live database is unchanged after a preview
    expect(await isHypertable()).toBe(false);
  });

  it('converges the database when apply is requested', async () => {
    const result = await pushSchema(ds, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.statements.length).toBeGreaterThan(0);
    expect(await isHypertable()).toBe(true);

    const jobs: Array<{ proc_name: string }> = await ds.query(
      `SELECT proc_name FROM timescaledb_information.jobs
        WHERE hypertable_schema='public' AND hypertable_name='pushed'`,
    );
    expect(jobs.map((j) => j.proc_name)).toContain('policy_retention');
  });

  it('is idempotent: a second push reports no drift and applies nothing', async () => {
    const result = await pushSchema(ds, { apply: true });
    expect(isEmptyPlan(result.plan)).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.statements).toEqual([]);
  });

  it('detects an out-of-band threshold change as an ALTER and converges it', async () => {
    // NOTE: `add_retention_policy(..., if_not_exists => TRUE)` on an EXISTING policy does NOT
    // replace it — TimescaleDB warns "a policy already exists with different arguments", returns
    // -1, and leaves the old threshold. Verified on 2.18. The policy must be REMOVED first, or
    // this test asserts a state it never reaches.
    await ds.query(`SELECT remove_retention_policy('public.pushed', if_exists => TRUE)`);
    await ds.query(`SELECT add_retention_policy('public.pushed', INTERVAL '30 days')`);

    const live = async (): Promise<string> => {
      const r: Array<{ v: string }> = await ds.query(
        `SELECT config->>'drop_after' AS v FROM timescaledb_information.jobs
          WHERE proc_name='policy_retention' AND hypertable_name='pushed'`,
      );
      return r[0]!.v;
    };
    expect(await live()).toBe('30 days'); // the drift is real before we start

    // The entity declares 90 days, so this is an ALTER — never a drop.
    const preview = await pushSchema(ds);
    expect(preview.plan.steps.map((s) => s.operation.kind)).toEqual(['alterRetentionPolicy']);
    expect(preview.applied).toBe(false);
    expect(await live()).toBe('30 days'); // preview really did not touch it

    const applied = await pushSchema(ds, { apply: true });
    expect(applied.applied).toBe(true);
    expect(await live()).toBe('90 days'); // converged to the declared value
  });

  it('emits a policy removal ONLY when drops are opted into', async () => {
    // A hypertable the entity set does not declare retention for, while the database has one.
    await ds.query(`CREATE TABLE dropme(time timestamptz NOT NULL, value double precision)`);
    await ds.query(`SELECT create_hypertable('public.dropme','time')`);
    await ds.query(`SELECT add_retention_policy('public.dropme', INTERVAL '30 days')`);

    const ir = await introspect(ds);
    const desired = compileDesiredState(ds);
    const liveDropme = ir.hypertables.find((h) => h.table === 'public.dropme')!;
    const desiredPlus = {
      ...desired,
      hypertables: [
        ...desired.hypertables,
        { table: liveDropme.table, dimensions: liveDropme.dimensions },
      ],
    };

    expect(
      diffSchemaState(ir, desiredPlus).steps.some(
        (s) => s.operation.kind === 'removeRetentionPolicy',
      ),
    ).toBe(false);
    expect(
      diffSchemaState(ir, desiredPlus, { allowDrops: true }).steps.some(
        (s) => s.operation.kind === 'removeRetentionPolicy',
      ),
    ).toBe(true);
  });
});

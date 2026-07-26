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
  compileDesiredState,
  generateTimescaleMigration,
  introspect,
} from '../src/index.js';
import { compileOperations, diffSchemaState, isEmptyPlan } from '@blueprime/timescaledb-core';

// Env-gated (mirrors the other *.integration.test.ts): runs against both
// timescale/timescaledb:latest-pg17 (2.28.x) AND timescale/timescaledb:2.18.0-pg16.
const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

// A full hypertable entity: time dim + columnstore (segmentby/orderby + compression) + retention.
class Metric {}
Entity('metric')(Metric);
PrimaryColumn({ type: 'timestamptz' })(Metric.prototype, 'time');
Column({ type: 'text' })(Metric.prototype, 'symbol');
Column({ type: 'double precision' })(Metric.prototype, 'price');
Hypertable({
  chunkInterval: '1 day',
  columnstore: {
    segmentBy: ['symbol'],
    orderBy: [{ column: 'time', direction: 'DESC' }],
    compressAfter: '7 days',
  },
  retention: { dropAfter: '90 days' },
})(Metric);
TimeColumn()(Metric.prototype, 'time');
HypertablePrimaryKey()(Metric.prototype, 'time');

async function runAll(ds: DataSource, statements: readonly string[]): Promise<void> {
  const qr = ds.createQueryRunner();
  try {
    for (const sql of statements) await qr.query(sql);
  } finally {
    await qr.release();
  }
}

describe.skipIf(!IMAGE)('M4.2 diffSchemaState — live-DB additive diff + convergence', () => {
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
      entities: [Metric],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await ds.synchronize(); // create the plain `metric` table

    // Apply the generated migration EXCEPT the retention policy — so the live DB has the hypertable +
    // columnstore + compression but is MISSING the retention the decorators declare. This sets up a
    // real, single-facet drift for the additive diff to detect.
    const gen = generateTimescaleMigration(ds);
    await runAll(
      ds,
      gen.up.filter((s) => !s.includes('add_retention_policy')),
    );
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('detects exactly the missing retention policy (nothing else drifts)', async () => {
    const current = await introspect(ds);
    const desired = compileDesiredState(ds);
    const plan = diffSchemaState(current, desired);
    // The hypertable, columnstore, and compression policy are all present → no drift for them.
    // Only the declared-but-unapplied retention policy is missing.
    expect(plan.operations).toEqual([
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '90 days' },
    ]);
  });

  it('converges to an EMPTY diff after applying the plan, and stays empty (idempotent)', async () => {
    // Compile the plan through the M4.1 choke point and apply it to the live DB.
    const before = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    await runAll(
      ds,
      compileOperations(before.operations).flatMap((s) => [...s.up]),
    );

    // Re-introspect: desired == current now → empty plan.
    const afterPlan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(afterPlan.operations).toEqual([]);
    expect(isEmptyPlan(afterPlan)).toBe(true);

    // The retention job really exists in the catalog now.
    const jobs: Array<{ proc_name: string }> = await ds.query(
      `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    expect(jobs.map((j) => j.proc_name)).toContain('policy_retention');

    // Diffing again changes nothing (a no-op plan applied twice stays a no-op).
    const again = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(again.operations).toEqual([]);
  });

  it('a fully round-tripped schema (generate → introspect) diffs to empty vs desired', async () => {
    // The whole point of the diff: current (introspected) == desired (decorators) for an unchanged
    // schema, across the M4.0 normalizers — no false drift from system-filled defaults.
    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(isEmptyPlan(plan)).toBe(true);
  });
});

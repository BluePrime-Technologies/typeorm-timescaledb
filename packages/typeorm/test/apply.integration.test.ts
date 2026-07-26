import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { classifyOperation, type Operation, type Plan } from '@blueprime/timescaledb-core';
import { applyDirect } from '../src/index.js';

// Env-gated (mirrors the other *.integration.test.ts): runs against both
// timescale/timescaledb:latest-pg17 AND timescale/timescaledb:2.18.0-pg16.
const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

@Entity('sample')
class Sample {
  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @Column({ type: 'double precision' })
  value!: number;
}

const planOf = (...ops: Operation[]): Plan => ({
  steps: ops.map((operation) => ({ operation, ...classifyOperation(operation) })),
});

async function policyProcNames(ds: DataSource): Promise<string[]> {
  const rows: Array<{ proc_name: string }> = await ds.query(
    `SELECT proc_name FROM timescaledb_information.jobs ` +
      `WHERE hypertable_schema = 'public' AND hypertable_name = 'sample'`,
  );
  return rows.map((r) => r.proc_name);
}

async function isHypertable(ds: DataSource): Promise<boolean> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT count(*)::text AS n FROM timescaledb_information.hypertables ` +
      `WHERE hypertable_schema = 'public' AND hypertable_name = 'sample'`,
  );
  return rows[0]!.n === '1';
}

describe.skipIf(!IMAGE)('M4.3c applyDirect — live direct sync', () => {
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
      entities: [Sample],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await ds.synchronize(); // create the plain `sample` table
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('applies up (converts + adds retention) then reverts with down (non-destructive)', async () => {
    const plan = planOf(
      {
        kind: 'createHypertable',
        table: 'public.sample',
        timeColumn: 'time',
        chunkInterval: '1 day',
      },
      { kind: 'addRetentionPolicy', table: 'public.sample', dropAfter: '90 days' },
    );

    const up = await applyDirect(ds, plan);
    expect(up.direction).toBe('up');
    expect(up.stepCount).toBe(2);
    expect(await isHypertable(ds)).toBe(true);
    expect(await policyProcNames(ds)).toContain('policy_retention');

    // down removes the retention policy (non-destructive) — the hypertable/table remain.
    await applyDirect(ds, plan, { direction: 'down' });
    expect(await policyProcNames(ds)).not.toContain('policy_retention');
    expect(await isHypertable(ds)).toBe(true);
  });

  it('rolls back atomically when a later statement in the batch fails', async () => {
    // Precondition (from the prior test): `sample` IS a hypertable with no retention policy, so the
    // FIRST statement below genuinely SUCCEEDS and only the second fails — otherwise this test could
    // pass vacuously (first statement failing on a non-hypertable would also leave no policy).
    expect(await isHypertable(ds)).toBe(true);
    expect(await policyProcNames(ds)).not.toContain('policy_retention');

    // A valid retention add followed by an add on a NON-existent hypertable → the second statement
    // errors, so in one transaction the first must roll back too (no policy left behind).
    const plan = planOf(
      { kind: 'addRetentionPolicy', table: 'public.sample', dropAfter: '30 days' },
      { kind: 'addRetentionPolicy', table: 'public.does_not_exist', dropAfter: '30 days' },
    );

    let threw = false;
    try {
      await applyDirect(ds, plan);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // The first statement's retention policy must NOT have been committed (atomic rollback).
    expect(await policyProcNames(ds)).not.toContain('policy_retention');
  });
});

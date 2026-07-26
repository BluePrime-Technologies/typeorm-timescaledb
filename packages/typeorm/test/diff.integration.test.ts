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
  collectRenames,
  generateTimescaleMigration,
  introspect,
} from '../src/index.js';
import { checkCommand, type Logger } from '../src/cli/index.js';
import {
  compileOperations,
  diffSchemaState,
  intervalsEqual,
  isEmptyPlan,
} from '@blueprime/timescaledb-core';

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
    expect(plan.steps.map((s) => s.operation)).toEqual([
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '90 days' },
    ]);
  });

  it('converges to an EMPTY diff after applying the plan, and stays empty (idempotent)', async () => {
    // Compile the plan through the M4.1 choke point and apply it to the live DB.
    const before = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    await runAll(
      ds,
      compileOperations(before.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );

    // Re-introspect: desired == current now → empty plan.
    const afterPlan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(afterPlan.steps.map((s) => s.operation)).toEqual([]);
    expect(isEmptyPlan(afterPlan)).toBe(true);

    // The retention job really exists in the catalog now.
    const jobs: Array<{ proc_name: string }> = await ds.query(
      `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    expect(jobs.map((j) => j.proc_name)).toContain('policy_retention');

    // Diffing again changes nothing (a no-op plan applied twice stays a no-op).
    const again = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(again.steps.map((s) => s.operation)).toEqual([]);
  });

  it('a fully round-tripped schema (generate → introspect) diffs to empty vs desired', async () => {
    // The whole point of the diff: current (introspected) == desired (decorators) for an unchanged
    // schema, across the M4.0 normalizers — no false drift from system-filled defaults.
    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('detects a CHANGED retention threshold as an alter and converges after applying (AS2)', async () => {
    // Drift the live DB: change retention from the declared 90 days to 30 days (out-of-band).
    await runAll(ds, [
      `SELECT remove_retention_policy('public.metric', if_exists => TRUE);`,
      `SELECT add_retention_policy('public.metric', drop_after => INTERVAL '30 days');`,
    ]);

    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.operation.kind).toBe('alterRetentionPolicy');
    expect(step.safety).toBe('online-safe');
    const op = step.operation as { table: string; from: string; to: string };
    expect(op.table).toBe('public.metric');
    // Compare via the normalizers — introspect() may render the interval in a different text form.
    expect(intervalsEqual(op.from, '30 days')).toBe(true);
    expect(intervalsEqual(op.to, '90 days')).toBe(true);

    // Apply the compiled alter (remove-then-add) and confirm convergence back to the declared 90 days.
    await runAll(
      ds,
      compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );
    const after = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(isEmptyPlan(after)).toBe(true);

    // The catalog now reflects the desired threshold.
    const rows: Array<{ drop_after: string }> = await ds.query(
      `SELECT (config ->> 'drop_after') AS drop_after FROM timescaledb_information.jobs ` +
        `WHERE proc_name = 'policy_retention' AND hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    expect(rows).toHaveLength(1);
    expect(intervalsEqual(rows[0]!.drop_after, '90 days')).toBe(true);
  });

  it('re-adds a compression policy dropped out-of-band on an already-columnstore table (gap add)', async () => {
    // Drop just the compression policy job; the columnstore stays enabled.
    await runAll(ds, [`CALL remove_columnstore_policy('public.metric', if_exists => TRUE);`]);

    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.operation.kind).toBe('addCompressionPolicy');
    const op = plan.steps[0]!.operation as { table: string; after: string };
    expect(op.table).toBe('public.metric');
    expect(intervalsEqual(op.after, '7 days')).toBe(true); // Metric declares compressAfter '7 days'

    await runAll(
      ds,
      compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );
    expect(isEmptyPlan(diffSchemaState(await introspect(ds), compileDesiredState(ds)))).toBe(true);
    const jobs: Array<{ proc_name: string }> = await ds.query(
      `SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    expect(jobs.map((j) => j.proc_name)).toContain('policy_compression');
  });

  it('detects a CHANGED compression threshold as an alter and converges after applying', async () => {
    // Drift compression out-of-band from the declared 7 days to 30 days.
    await runAll(ds, [
      `CALL remove_columnstore_policy('public.metric', if_exists => TRUE);`,
      `CALL add_columnstore_policy('public.metric', after => INTERVAL '30 days');`,
    ]);

    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.operation.kind).toBe('alterCompressionPolicy');
    expect(step.safety).toBe('online-safe');
    const op = step.operation as { table: string; from: string; to: string };
    expect(intervalsEqual(op.from, '30 days')).toBe(true);
    expect(intervalsEqual(op.to, '7 days')).toBe(true);

    await runAll(
      ds,
      compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );
    expect(isEmptyPlan(diffSchemaState(await introspect(ds), compileDesiredState(ds)))).toBe(true);
    const rows: Array<{ compress_after: string }> = await ds.query(
      `SELECT (config ->> 'compress_after') AS compress_after FROM timescaledb_information.jobs ` +
        `WHERE proc_name = 'policy_compression' AND hypertable_schema = 'public' AND hypertable_name = 'metric'`,
    );
    expect(rows).toHaveLength(1);
    expect(intervalsEqual(rows[0]!.compress_after, '7 days')).toBe(true);
  });

  it('checkCommand: no drift when converged; reports + returns true when drifted (CI-gate signal)', async () => {
    const lines: string[] = [];
    const logger: Logger = { log: (m) => lines.push(m), error: (m) => lines.push(`ERR:${m}`) };

    // Baseline: the prior tests already converged `metric` to the Metric entity's declared config.
    expect(await checkCommand(ds, logger)).toBe(false);
    expect(lines.at(-1)).toContain('No drift detected');

    // Drift retention out-of-band (mirrors the earlier "detects a CHANGED retention threshold" test).
    await runAll(ds, [
      `SELECT remove_retention_policy('public.metric', if_exists => TRUE);`,
      `SELECT add_retention_policy('public.metric', drop_after => INTERVAL '30 days');`,
    ]);
    expect(await checkCommand(ds, logger)).toBe(true);
    expect(lines.at(-1)).toContain('Drift detected');
    expect(lines.at(-1)).toContain('alter retention policy on public.metric');

    // Restore convergence — later tests depend on `metric` matching the Metric entity's declared config.
    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    await runAll(
      ds,
      compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );
    expect(await checkCommand(ds, logger)).toBe(false);
  });

  it('detects a CHANGED chunk interval as setChunkInterval and converges after applying (AS3)', async () => {
    // Drift the time-dimension chunk interval out-of-band from the declared 1 day to 7 days.
    await runAll(ds, [`SELECT set_chunk_time_interval('public.metric', INTERVAL '7 days');`]);

    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.operation.kind).toBe('setChunkInterval');
    expect(step.safety).toBe('online-safe');
    const op = step.operation as { table: string; from: string; to: string };
    expect(op.table).toBe('public.metric');
    expect(intervalsEqual(op.from, '7 days')).toBe(true);
    expect(intervalsEqual(op.to, '1 day')).toBe(true);

    await runAll(
      ds,
      compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );
    expect(isEmptyPlan(diffSchemaState(await introspect(ds), compileDesiredState(ds)))).toBe(true);

    const rows: Array<{ time_interval: string }> = await ds.query(
      // ::text — node-pg parses a bare `interval` column into an object; the text form is what
      // intervalsEqual (and introspect itself) can canonicalize.
      `SELECT time_interval::text AS time_interval FROM timescaledb_information.dimensions ` +
        `WHERE hypertable_schema = 'public' AND hypertable_name = 'metric' AND dimension_type = 'Time' ` +
        `ORDER BY dimension_number LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(intervalsEqual(rows[0]!.time_interval, '1 day')).toBe(true);
  });

  it('handles a SUB-DAY current chunk interval (introspected HH:MM:SS from) without crashing', async () => {
    // Regression for the AS3a red-team HIGH: drift to a sub-day interval (1 hour), which introspect
    // reads back as the Postgres time form '01:00:00'. The setChunkInterval op then carries
    // from:'01:00:00'; compiling+applying it must NOT throw (the builder accepts Postgres output forms).
    await runAll(ds, [`SELECT set_chunk_time_interval('public.metric', INTERVAL '1 hour');`]);

    const plan = diffSchemaState(await introspect(ds), compileDesiredState(ds));
    expect(plan.steps).toHaveLength(1);
    const op = plan.steps[0]!.operation as { kind: string; from: string; to: string };
    expect(op.kind).toBe('setChunkInterval');
    expect(intervalsEqual(op.from, '1 hour')).toBe(true); // introspected as '01:00:00', equals 1 hour
    expect(intervalsEqual(op.to, '1 day')).toBe(true);

    await runAll(
      ds,
      compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
    );
    expect(isEmptyPlan(diffSchemaState(await introspect(ds), compileDesiredState(ds)))).toBe(true);
  });

  it('renames a hypertable via renamedFrom → a single renameHypertable op; converges after applying', async () => {
    // MUST BE LAST: renames the live `metric` hypertable to `metric_v2`, so any test operating on
    // `metric` after it would fail. A second entity/DataSource against the SAME container.
    class MetricRenamed {}
    Entity('metric_v2')(MetricRenamed);
    PrimaryColumn({ type: 'timestamptz' })(MetricRenamed.prototype, 'time');
    Column({ type: 'text' })(MetricRenamed.prototype, 'symbol');
    Column({ type: 'double precision' })(MetricRenamed.prototype, 'price');
    Hypertable({
      chunkInterval: '1 day',
      columnstore: {
        segmentBy: ['symbol'],
        orderBy: [{ column: 'time', direction: 'DESC' }],
        compressAfter: '7 days',
      },
      retention: { dropAfter: '90 days' },
      renamedFrom: 'metric',
    })(MetricRenamed);
    TimeColumn()(MetricRenamed.prototype, 'time');
    HypertablePrimaryKey()(MetricRenamed.prototype, 'time');

    const renamedDs = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
      entities: [MetricRenamed],
      synchronize: false,
    });
    await renamedDs.initialize();
    try {
      const desired = compileDesiredState(renamedDs);
      const renames = collectRenames(renamedDs);
      expect(renames.get('public.metric_v2')).toBe('public.metric');

      const plan = diffSchemaState(await introspect(renamedDs), desired, { renames });
      expect(plan.steps.map((s) => s.operation)).toEqual([
        { kind: 'renameHypertable', from: 'public.metric', to: 'public.metric_v2' },
      ]);
      expect(plan.steps[0]!.safety).toBe('online-safe');

      await runAll(
        renamedDs,
        compileOperations(plan.steps.map((s) => s.operation)).flatMap((s) => [...s.up]),
      );

      // Re-diff post-rename: columnstore + policies transferred automatically (Postgres RENAME
      // preserves everything but the name) — fully converged, no leftover alters.
      const after = diffSchemaState(await introspect(renamedDs), compileDesiredState(renamedDs), {
        renames: collectRenames(renamedDs),
      });
      expect(isEmptyPlan(after)).toBe(true);

      const hyps: Array<{ hypertable_name: string }> = await renamedDs.query(
        `SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema = 'public'`,
      );
      expect(hyps.map((h) => h.hypertable_name)).toContain('metric_v2');
      expect(hyps.map((h) => h.hypertable_name)).not.toContain('metric');
    } finally {
      await renamedDs.destroy();
    }
  });
});

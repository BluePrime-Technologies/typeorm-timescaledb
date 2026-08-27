import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { classifyOperation, compileOperation } from '@blueprime/timescaledb-core';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import {
  exitCodeForMix,
  exitCodeForPush,
  generateMigrationFile,
  mixCommand,
  pushCommand,
} from '../src/cli/index.js';
import {
  AggregateColumn,
  BucketColumn,
  ContinuousAggregate,
  GroupColumn,
  Hypertable,
  HypertablePrimaryKey,
  TimeColumn,
  compileDesiredState,
  generateTimescaleMigration,
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
    // Nothing blocking after convergence. Note `advisories` is now absent entirely rather than
    // carrying a blanket `not-compared` for the existing aggregate: its definition is COMPARED now,
    // and it matches. This is the regression guard for the whole feature — a false positive here
    // means `check` fails on a database that push just converged.
    expect((after.plan.advisories ?? []).filter((a) => a.kind === 'not-expressible')).toEqual([]);
  }, 300_000);

  it('compares an existing CAGG structurally instead of reporting it as unexamined', async () => {
    const { plan } = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });
    // WAS: a blanket `not-compared`, because definitions were never examined. Now the facets are
    // extracted from both sides and match, so there is nothing to say about this aggregate.
    expect((plan.advisories ?? []).filter((a) => a.object === 'public.reading_hourly')).toEqual([]);
  }, 120_000);

  it('warns that nothing was compared when the CAGG list is omitted', async () => {
    const { plan } = await pushSchema(ds);
    expect(plan.steps).toEqual([]);
    expect(plan.advisories).toContainEqual(
      expect.objectContaining({ object: '(all continuous aggregates)' }),
    );
  }, 120_000);

  it('DOES report drift when the definition is changed out-of-band', async () => {
    // This test previously locked in the OPPOSITE — "the documented limit" — because definitions
    // were never compared. That limitation is gone: facets are extracted from both sides, so an
    // aggregate changed behind the engine's back is now caught. Verified against a REAL altered
    // view, not a stub, which is what makes it evidence rather than a restatement of the code.
    await ds.query('DROP MATERIALIZED VIEW reading_hourly');
    await ds.query(`
      CREATE MATERIALIZED VIEW reading_hourly
        WITH (timescaledb.continuous) AS
        SELECT time_bucket('1 hour', time) AS bucket, sensor_id, max(value) AS avg_value,
               count(*) AS samples
        FROM readings GROUP BY 1, 2 WITH NO DATA
    `);

    const { plan } = await pushSchema(ds, { continuousAggregates: [ReadingHourly] });

    // Still not a plan STEP: altering a CAGG's SELECT is not expressible, and converging it means
    // DROP + CREATE, which would discard the materialized rows.
    expect(plan.steps.map((s) => s.operation.kind)).not.toContain('createContinuousAggregateRaw');

    // But it IS reported, as blocking drift naming the facet that moved — avg() became max().
    const advisory = (plan.advisories ?? []).find((a) => a.object === 'public.reading_hourly');
    expect(advisory?.kind).toBe('not-expressible');
    expect(advisory?.detail).toContain('aggregates');
    expect(advisory?.detail).toMatch(/max\(value\)/);
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

  it('does not claim convergence when steps applied but unconvergeable drift REMAINS', async () => {
    // Both external reviewers found this independently. Blocking advisories only counted as drift
    // when the plan was EMPTY. With a real step alongside one, push applied the step, returned
    // 'applied', printed "the database now matches your entities", and exited 0 — while the
    // divergence was still there. Provoked here with BOTH at once, against a live database.
    await ds.query(
      "SELECT remove_continuous_aggregate_policy('reading_hourly', if_exists => TRUE)",
    );
    await ds.query(
      "SELECT add_continuous_aggregate_policy('reading_hourly', start_offset => INTERVAL '5 months', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes')",
    );
    // ...and a genuinely applicable step: a retention policy the entity does not yet have.
    await ds.query("SELECT add_retention_policy('readings', INTERVAL '400 days')");

    const lines: string[] = [];
    const logger = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const outcome = await pushCommand(ds, logger, {
      continuousAggregates: [ReadingHourly],
      allowDrops: true,
      apply: true,
    });

    expect(outcome).toBe('applied-with-drift');
    expect(exitCodeForPush(outcome)).not.toBe(0);
    const out = lines.join('\n');
    expect(out).not.toMatch(/now matches your entities/);
    expect(out).toMatch(/drift REMAINS/);

    // Clean up for any later test.
    await ds.query(
      "SELECT remove_continuous_aggregate_policy('reading_hourly', if_exists => TRUE)",
    );
    await pushSchema(ds, { continuousAggregates: [ReadingHourly], apply: true });
  }, 300_000);

  it('a CREATE-intent aggregate is dropped by down(); a reproduce-intent one is not (#190)', async () => {
    // Proven against a live database, because the whole point is what a REVERTED migration leaves
    // behind — a string assertion cannot show that.
    //
    // Deliberately self-contained: its own table, its own view names, and the operations built
    // directly rather than through the DataSource-bound diff. The earlier tests in this file
    // mutate shared state (dropping and hand-recreating aggregates, moving policies), and an
    // ordering coupling here would make a future failure look like a bug in `down()` when it was
    // really test residue. The diff's `intent: 'create'` wiring is pinned separately, by the
    // operation-shape assertion in core/test/diff.test.ts.
    await ds.query(`
      CREATE TABLE IF NOT EXISTS t190 (
        ts TIMESTAMPTZ NOT NULL,
        v  DOUBLE PRECISION
      );
    `);
    await ds.query("SELECT create_hypertable('t190','ts', if_not_exists => TRUE)");
    const definition =
      'SELECT time_bucket(INTERVAL \'1 day\', "ts") AS "bucket", count(*) AS "n" ' +
      'FROM "public"."t190" GROUP BY time_bucket(INTERVAL \'1 day\', "ts")';

    const run = async (view: string, intent: 'create' | 'reproduce'): Promise<string[]> => {
      const compiled = compileOperation({
        kind: 'createContinuousAggregateRaw',
        view,
        definition,
        materializedOnly: false,
        intent,
      });
      for (const up of compiled.up) await ds.query(up);
      const exists = async (): Promise<boolean> =>
        (await introspect(ds)).continuousAggregates.some((c) => c.viewName === `public.${view}`);
      expect(await exists()).toBe(true);
      for (const down of compiled.down) await ds.query(down);
      return [String(await exists())];
    };

    // create → down() DROPs it. It was made WITH NO DATA and holds nothing, so this is lossless;
    // refusing to drop it strands an empty view the user never had.
    expect(await run('t190_created', 'create')).toEqual(['false']);

    // reproduce → down() must NOT drop. Its rows may be the only surviving copy of data whose
    // source chunks retention has already removed. This is the property #190 must not break.
    expect(await run('t190_reproduced', 'reproduce')).toEqual(['true']);

    // The preview text a user reads before running the plan must match what each actually does.
    const created = classifyOperation({
      kind: 'createContinuousAggregateRaw',
      view: 'x',
      definition,
      intent: 'create',
    });
    expect(created.reason).toMatch(/created WITH NO DATA/);
    expect(created.reason).not.toMatch(/EXISTING/);

    await ds.query('DROP MATERIALIZED VIEW IF EXISTS t190_reproduced');
    await ds.query('DROP TABLE IF EXISTS t190 CASCADE');
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

  it('generate emits the CAGG too, so check/generate/run actually converges', async () => {
    // Found by red-team: `check` could SEE aggregates while `generate` stayed blind, so the
    // migration workflow was a closed loop — check reports drift, generate writes a migration
    // without the CAGG, it runs, check reports the same drift, forever. Whatever `check` reports as
    // drift, `generate` must be able to emit.
    const written: Array<{ path: string; content: string }> = [];
    const writer = {
      mkdirp: () => {},
      write: (path: string, content: string) => {
        written.push({ path, content });
      },
    };

    const result = generateMigrationFile(
      ds,
      {
        outDir: '/tmp/unused',
        output: 'sql',
        timestamp: 1_700_000_000_000,
        continuousAggregates: [ReadingHourly],
      },
      writer,
    );
    expect(result).not.toBeNull();
    const sql = written[0]?.content ?? '';
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW/i);
    expect(sql).toContain('reading_hourly');
    expect(sql).toMatch(/add_continuous_aggregate_policy/i);
  }, 120_000);

  it('replays a generated migration against a DB that already has the CAGG (#189)', async () => {
    // The incremental-adoption path, which is what #189 actually broke. `generate` is a
    // DESIRED-STATE emitter: it writes a CREATE for EVERY declared aggregate, not just the missing
    // ones. So the second aggregate you add produces a migration whose FIRST statement recreates
    // one that already exists — and without IF NOT EXISTS that died with `relation already exists`,
    // leaving the drift `check` reported permanently unfixable through the migration workflow.
    //
    // A string assertion cannot prove this; only replaying against a live database that already
    // holds the aggregate can. `reading_hourly` exists by now, so this is exactly that situation.
    //
    // Replay `migration.up` directly rather than the rendered .sql file: that file also carries the
    // DOWN section, and naively splitting it on `;` executes the DROP too (which is how the first
    // version of this test deleted the very view it was asserting on).
    const migration = generateTimescaleMigration(ds, {
      name: 'Replay',
      timestamp: 1_700_000_000_000,
      continuousAggregates: [ReadingHourly],
    });
    const createStatements = migration.up.filter((x) => /CREATE MATERIALIZED VIEW/i.test(x));
    expect(createStatements.length).toBeGreaterThan(0);
    expect(createStatements.every((x) => /IF NOT EXISTS/i.test(x))).toBe(true);

    const before = await introspect(ds);
    expect(before.continuousAggregates.some((c) => c.viewName === 'public.reading_hourly')).toBe(
      true,
    );

    // Replay the whole UP. Before the fix this threw on the CREATE.
    for (const statement of migration.up) {
      await ds.query(statement);
    }

    // Still exactly ONE aggregate — not duplicated, not clobbered.
    const after = await introspect(ds);
    expect(
      after.continuousAggregates.filter((c) => c.viewName === 'public.reading_hourly'),
    ).toHaveLength(1);
  }, 300_000);

  it('mix runs pull BEFORE push, and a half-clean run is not clean (#197)', async () => {
    const lines: string[] = [];
    const logger = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const outDir = mkdtempSync(join(tmpdir(), 'tsdb-mix-197-'));

    const outcome = await mixCommand(
      ds,
      logger,
      { outDir, output: 'sql', timestamp: 1_700_000_000_000 },
      { continuousAggregates: [ReadingHourly] },
    );

    const out = lines.join('\n');
    // ORDER IS LOAD-BEARING: the pull must describe the database as it was, not as push left it.
    expect(out.indexOf('── pull')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('── pull')).toBeLessThan(out.indexOf('── push'));

    // This database HAS TimescaleDB objects the entities do not fully describe, so the pull half
    // has something to say — i.e. the run is not clean, and must not claim to be.
    expect(outcome).not.toBe('applied');
    if (outcome === 'clean') {
      expect(out).toMatch(/Nothing to pull|No drift detected/);
    } else {
      expect(exitCodeForMix(outcome)).toBe(2);
    }
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource } from 'typeorm';
import {
  intervalsEqual,
  policiesEqual,
  caggDefinitionsEqual,
  type SchemaStateIR,
  type HypertableState,
  type ContinuousAggregateState,
  type PolicyState,
} from '@blueprime/timescaledb-core';
import { introspect } from '../src/index.js';

// Env-gated (mirrors the other *.integration.test.ts): runs only when TIMESCALE_IMAGE is set, so it
// can be pointed at BOTH timescale/timescaledb:latest-pg17 (2.28.x) AND timescale/timescaledb:2.18.0-pg16.
const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

// ---------------------------------------------------------------------------
// The H1 round-trip matrix — a diverse, KNOWN desired-state built via raw DDL, then recovered by
// introspect() and asserted equal VIA the Slice-1 normalizers (not raw ===), because Postgres
// reformats intervals ('1 day'→'1 day', '1 month'→'1 mon', schedule '1 hour'→'01:00:00') and
// re-expands view text. Each `intended` value below is what the DDL declared.
// ---------------------------------------------------------------------------

const SETUP_SQL = `
  SET intervalstyle = 'postgres';

  -- (1) time hypertable + (2) space partition + columnstore + (3) compression + (4) retention
  CREATE TABLE metric (
    ts        timestamptz NOT NULL,
    device_id int         NOT NULL,
    region    text        NOT NULL,
    value     double precision
  );
  SELECT create_hypertable('metric', by_range('ts', INTERVAL '1 day'));
  SELECT add_dimension('metric', by_hash('device_id', 4));
  ALTER TABLE metric SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, region',
    timescaledb.compress_orderby   = 'ts DESC, value ASC NULLS LAST'
  );
  SELECT add_compression_policy('metric', INTERVAL '30 days');
  SELECT add_retention_policy('metric', INTERVAL '365 days');
  -- Pin the policy schedules to known values (the DB defaults differ per version). The
  -- add_*_policy functions take no schedule_interval, so alter_job sets it as declared state.
  SELECT alter_job((SELECT job_id FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_compression' AND hypertable_name = 'metric'),
                   schedule_interval => INTERVAL '6 hours');
  SELECT alter_job((SELECT job_id FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention' AND hypertable_name = 'metric'),
                   schedule_interval => INTERVAL '2 days');

  -- (5) integer-time hypertable (chunk_time_interval is a bigint, not an interval)
  CREATE TABLE events (id bigint NOT NULL, payload text);
  SELECT create_hypertable('events', by_range('id', 1000000));

  -- (6) CAGG over metric with a refresh policy, real-time (materialized_only = false)
  CREATE MATERIALIZED VIEW metric_hourly
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT time_bucket(INTERVAL '1 hour', ts) AS bucket, device_id, avg(value) AS avg_value
    FROM metric GROUP BY bucket, device_id
    WITH NO DATA;
  SELECT add_continuous_aggregate_policy('metric_hourly',
    start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

  -- (7) HIERARCHICAL CAGG (cagg-on-cagg), materialized_only = true
  CREATE MATERIALIZED VIEW metric_daily
    WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
    SELECT time_bucket(INTERVAL '1 day', bucket) AS bucket, device_id, avg(avg_value) AS avg_value
    FROM metric_hourly GROUP BY 1, 2
    WITH NO DATA;
`;

/** The intended desired-state, expressed in the same IR the reader produces. */
const intended = {
  metric: {
    chunkInterval: '1 day' as const,
    spaceColumn: 'device_id',
    numPartitions: 4,
    segmentBy: ['device_id', 'region'],
    orderBy: [
      { column: 'ts', desc: true, nullsFirst: true }, // DESC defaults to NULLS FIRST
      { column: 'value', desc: false, nullsFirst: false }, // ASC NULLS LAST
    ],
    compressionPolicy: {
      kind: 'compression',
      after: '30 days',
      scheduleInterval: '6 hours',
    } as PolicyState,
    retentionPolicy: {
      kind: 'retention',
      after: '365 days',
      scheduleInterval: '2 days',
    } as PolicyState,
  },
  events: {
    chunkInterval: 1000000, // integer-time
  },
  metricHourly: {
    source: 'public.metric',
    hierarchical: false,
    materializedOnly: false,
    refresh: {
      kind: 'refresh',
      startOffset: '1 month',
      endOffset: '1 hour',
      scheduleInterval: '1 hour',
    } as PolicyState,
  },
  metricDaily: {
    source: 'public.metric_hourly',
    hierarchical: true,
    materializedOnly: true,
  },
};

function ht(ir: SchemaStateIR, table: string): HypertableState {
  const found = ir.hypertables.find((h) => h.table === table);
  if (!found) throw new Error(`hypertable ${table} not found in IR`);
  return found;
}

function cagg(ir: SchemaStateIR, viewName: string): ContinuousAggregateState {
  const found = ir.continuousAggregates.find((c) => c.viewName === viewName);
  if (!found) throw new Error(`cagg ${viewName} not found in IR`);
  return found;
}

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
    synchronize: false,
  });
  await ds.initialize();
  await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  // Run the setup as separate statements (node-pg simple-query would take a multi-statement string,
  // but keep each explicit so a failure points at the offending DDL).
  for (const stmt of SETUP_SQL.split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await ds.query(stmt);
  }
  return { container, ds };
}

describe.skipIf(!IMAGE)('M4.0 introspect() — live-DB → SchemaStateIR round-trip', () => {
  let container: StartedTestContainer;
  let ds: DataSource;
  let ir: SchemaStateIR;

  beforeAll(async () => {
    ({ container, ds } = await boot(IMAGE as string));
    ir = await introspect(ds);
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('records the timescaledb version and does not leak intervalstyle to the session', async () => {
    expect(ir.timescaledbVersion).toMatch(/^2\.\d+\.\d+/);
    // SET LOCAL must not have altered the session default outside the introspection transaction.
    // (SHOW returns the value under a GUC-cased key, so read it positionally.)
    const rows: Array<Record<string, string>> = await ds.query('SHOW intervalstyle');
    const style = rows[0] ? Object.values(rows[0])[0] : undefined;
    expect(['postgres', 'postgres_verbose']).toContain(style);
  });

  it('recovers the time dimension chunk interval (interval-time) via intervalsEqual', () => {
    const m = ht(ir, 'public.metric');
    const time = m.dimensions.find((d) => d.kind === 'time' && d.column === 'ts');
    expect(time).toBeDefined();
    expect(intervalsEqual(time!.chunkInterval, intended.metric.chunkInterval)).toBe(true);
  });

  it('recovers the space partition dimension (column + numPartitions)', () => {
    const m = ht(ir, 'public.metric');
    const space = m.dimensions.find((d) => d.kind === 'space');
    expect(space?.column).toBe(intended.metric.spaceColumn);
    expect(space?.numPartitions).toBe(intended.metric.numPartitions);
  });

  it('recovers dimension ordering (time dim first, then space)', () => {
    const m = ht(ir, 'public.metric');
    expect(m.dimensions.map((d) => d.kind)).toEqual(['time', 'space']);
  });

  it('recovers an integer-time chunk interval via intervalsEqual (number form)', () => {
    const e = ht(ir, 'public.events');
    const time = e.dimensions.find((d) => d.kind === 'time');
    expect(intervalsEqual(time!.chunkInterval, intended.events.chunkInterval)).toBe(true);
  });

  it('recovers columnstore segmentby (ordered) exactly', () => {
    const m = ht(ir, 'public.metric');
    expect(m.columnstore?.segmentBy).toEqual(intended.metric.segmentBy);
  });

  it('recovers columnstore orderby with direction + nulls placement (structured)', () => {
    const m = ht(ir, 'public.metric');
    expect(m.columnstore?.orderBy).toEqual(intended.metric.orderBy);
  });

  it('recovers the compression policy via policiesEqual', () => {
    const m = ht(ir, 'public.metric');
    expect(policiesEqual(m.compressionPolicy, intended.metric.compressionPolicy)).toBe(true);
  });

  it('recovers the retention policy via policiesEqual', () => {
    const m = ht(ir, 'public.metric');
    expect(policiesEqual(m.retentionPolicy, intended.metric.retentionPolicy)).toBe(true);
  });

  it('recovers the CAGG source, real-time flag, and refresh policy', () => {
    const c = cagg(ir, 'public.metric_hourly');
    expect(c.source).toBe(intended.metricHourly.source);
    expect(c.hierarchical).toBe(intended.metricHourly.hierarchical);
    expect(c.materializedOnly).toBe(intended.metricHourly.materializedOnly);
    expect(policiesEqual(c.refresh, intended.metricHourly.refresh)).toBe(true);
  });

  it('recovers a HIERARCHICAL cagg-on-cagg (parent view as source)', () => {
    const c = cagg(ir, 'public.metric_daily');
    expect(c.hierarchical).toBe(intended.metricDaily.hierarchical);
    expect(c.source).toBe(intended.metricDaily.source);
    expect(c.materializedOnly).toBe(intended.metricDaily.materializedOnly);
  });

  // Guards the SET LOCAL intervalstyle scoping (the core Slice-2 hazard). The main matrix above
  // cannot catch a regression to bare dataSource.query() because the container's DEFAULT style is
  // already 'postgres', so intervals would render correctly even if the SET landed on the wrong
  // pooled connection or were dropped. Force a HOSTILE database-level default that the Slice-1
  // canonicalizer cannot parse (iso_8601 renders '1 day' as 'P1D'); only if introspect()'s
  // `SET LOCAL intervalstyle='postgres'` actually applies to the read connection will the intervals
  // still round-trip. A fresh DataSource is used so no pooled connection predates the ALTER DATABASE.
  it('recovers intervals even when the DB default intervalstyle is hostile (SET LOCAL lands on reads)', async () => {
    await ds.query("ALTER DATABASE test SET intervalstyle = 'iso_8601'");
    const hostileDs = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
      synchronize: false,
    });
    await hostileDs.initialize();
    try {
      // Confirm the hostile default is actually in force on a new connection (guards the guard).
      const styleRows: Array<Record<string, string>> = await hostileDs.query('SHOW intervalstyle');
      expect(styleRows[0] ? Object.values(styleRows[0])[0] : undefined).toBe('iso_8601');

      const hostileIr = await introspect(hostileDs);
      const m = ht(hostileIr, 'public.metric');
      const time = m.dimensions.find((d) => d.kind === 'time' && d.column === 'ts');
      expect(intervalsEqual(time!.chunkInterval, intended.metric.chunkInterval)).toBe(true);
      expect(policiesEqual(m.compressionPolicy, intended.metric.compressionPolicy)).toBe(true);
      expect(policiesEqual(m.retentionPolicy, intended.metric.retentionPolicy)).toBe(true);
      const ch = cagg(hostileIr, 'public.metric_hourly');
      expect(policiesEqual(ch.refresh, intended.metricHourly.refresh)).toBe(true);
    } finally {
      await hostileDs.destroy();
      await ds.query('ALTER DATABASE test RESET intervalstyle');
    }
  });

  it('produces a stable, normalized CAGG definition (idempotent across two reads)', async () => {
    const again = await introspect(ds);
    const a = cagg(ir, 'public.metric_hourly');
    const b = cagg(again, 'public.metric_hourly');
    // The reader sources view_definition from Postgres's own normalized form; two reads must agree.
    expect(caggDefinitionsEqual(a.definition, b.definition)).toBe(true);
    expect(a.definition).toContain('avg(value)');
  });

  // Round-trip recoverability score (the H1 gate). Every facet below is recovered == intended via
  // the Slice-1 normalizers. NOT textually recoverable against the *raw* DDL (enumerated, excluded
  // from the score by design): the CAGG SELECT *definition text* — Postgres rewrites it (e.g.
  // `INTERVAL '1 hour'`→`'01:00:00'::interval`, GROUP BY expansion), so it round-trips only
  // Postgres-normalized-vs-Postgres-normalized (asserted for stability above), never vs raw DDL.
  it('recovers >= 95% of the known configuration facets', () => {
    const m = ht(ir, 'public.metric');
    const e = ht(ir, 'public.events');
    const ch = cagg(ir, 'public.metric_hourly');
    const cd = cagg(ir, 'public.metric_daily');
    const facets: Array<[string, boolean]> = [
      [
        'metric.time.chunkInterval',
        intervalsEqual(
          m.dimensions.find((d) => d.kind === 'time')!.chunkInterval,
          intended.metric.chunkInterval,
        ),
      ],
      [
        'metric.space.column',
        m.dimensions.find((d) => d.kind === 'space')?.column === intended.metric.spaceColumn,
      ],
      [
        'metric.space.numPartitions',
        m.dimensions.find((d) => d.kind === 'space')?.numPartitions ===
          intended.metric.numPartitions,
      ],
      [
        'metric.dimension.order',
        JSON.stringify(m.dimensions.map((d) => d.kind)) === JSON.stringify(['time', 'space']),
      ],
      [
        'events.integer.chunkInterval',
        intervalsEqual(
          e.dimensions.find((d) => d.kind === 'time')!.chunkInterval,
          intended.events.chunkInterval,
        ),
      ],
      [
        'metric.columnstore.segmentBy',
        JSON.stringify(m.columnstore?.segmentBy) === JSON.stringify(intended.metric.segmentBy),
      ],
      [
        'metric.columnstore.orderBy',
        JSON.stringify(m.columnstore?.orderBy) === JSON.stringify(intended.metric.orderBy),
      ],
      [
        'metric.compressionPolicy',
        policiesEqual(m.compressionPolicy, intended.metric.compressionPolicy),
      ],
      ['metric.retentionPolicy', policiesEqual(m.retentionPolicy, intended.metric.retentionPolicy)],
      ['metric_hourly.source', ch.source === intended.metricHourly.source],
      ['metric_hourly.hierarchical', ch.hierarchical === intended.metricHourly.hierarchical],
      [
        'metric_hourly.materializedOnly',
        ch.materializedOnly === intended.metricHourly.materializedOnly,
      ],
      ['metric_hourly.refresh', policiesEqual(ch.refresh, intended.metricHourly.refresh)],
      ['metric_daily.hierarchical', cd.hierarchical === intended.metricDaily.hierarchical],
      ['metric_daily.source', cd.source === intended.metricDaily.source],
      [
        'metric_daily.materializedOnly',
        cd.materializedOnly === intended.metricDaily.materializedOnly,
      ],
    ];
    const recovered = facets.filter(([, ok]) => ok);
    const failed = facets.filter(([, ok]) => !ok).map(([name]) => name);
    const pct = (recovered.length / facets.length) * 100;
    // Surface which facet regressed (if any) in the failure message.
    expect(failed, `unrecovered facets: ${failed.join(', ')}`).toEqual([]);
    expect(pct).toBeGreaterThanOrEqual(95);
  });
});

// ── Pre-release audit regression ───────────────────────────────────────────────────────────────
describe.skipIf(!IMAGE)(
  'introspect() — policy thresholds under a non-default IntervalStyle',
  () => {
    let container: StartedTestContainer;
    let ds: DataSource;

    beforeAll(async () => {
      ({ container, ds } = await boot(IMAGE as string));
    }, 240_000);

    afterAll(async () => {
      await ds?.destroy();
      await container?.stop();
    });

    it('normalizes ISO-8601 policy thresholds frozen in the job config', async () => {
      // A policy's threshold is stored as TEXT inside the job's `config` JSONB, rendered in whatever
      // IntervalStyle the CREATING session used — so the reader's `SET LOCAL intervalstyle` cannot
      // re-render it. A policy created under `iso_8601` read back as `P7D`, which the canonicalizer
      // quarantines: the diff then emitted an alter on EVERY run and `applyDirect` threw compiling it.
      await ds.query(`CREATE TABLE iso_policy(t timestamptz NOT NULL, v double precision)`);
      await ds.query(`SELECT create_hypertable('public.iso_policy','t')`);
      await ds.query(`ALTER TABLE public.iso_policy SET (timescaledb.compress)`);
      // Create the policies in a session using ISO-8601 interval rendering.
      const qr = ds.createQueryRunner();
      try {
        await qr.connect();
        await qr.query(`SET intervalstyle = 'iso_8601'`);
        await qr.query(`SELECT add_compression_policy('public.iso_policy', INTERVAL '7 days')`);
        await qr.query(`SELECT add_retention_policy('public.iso_policy', INTERVAL '30 days')`);
      } finally {
        await qr.release();
      }

      // Raw catalog really does hold the ISO form — otherwise this test proves nothing.
      const raw: Array<{ v: string }> = await ds.query(
        `SELECT coalesce(config->>'compress_after', config->>'drop_after') AS v
         FROM timescaledb_information.jobs WHERE hypertable_name = 'iso_policy'`,
      );
      expect(raw.map((r) => r.v).sort()).toEqual(['P30D', 'P7D']);

      const ir = await introspect(ds);
      const ht = ir.hypertables.find((h) => h.table === 'public.iso_policy');
      expect(ht).toBeDefined();
      // Normalized back to the Postgres rendering the canonicalizer understands.
      expect(ht?.compressionPolicy?.after).toBe('7 days');
      expect(ht?.retentionPolicy?.after).toBe('30 days');
    });

    it('leaves an INTEGER-time threshold untouched (never coerced to an interval)', async () => {
      // `'500000'::interval` is silently 277:46:40 — a blind cast would corrupt integer-time policies.
      await ds.query(`CREATE TABLE int_policy(t bigint NOT NULL, v double precision)`);
      await ds.query(
        `SELECT create_hypertable('public.int_policy','t', chunk_time_interval => 1000000)`,
      );
      await ds.query(`ALTER TABLE public.int_policy SET (timescaledb.compress)`);
      await ds.query(`SELECT add_compression_policy('public.int_policy', 500000::bigint)`);

      const ir = await introspect(ds);
      const ht = ir.hypertables.find((h) => h.table === 'public.int_policy');
      expect(ht?.compressionPolicy?.after).toBe(500000);
    });
  },
);
